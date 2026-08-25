import { randomBytes } from 'node:crypto';
import {
  Address,
  Contract,
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { supabase } from '@/lib/supabase';

const RPC_URL = process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = Networks.TESTNET;
const RELAY_TTL_MS = 10 * 60 * 1000;

function sponsor(): Keypair {
  const secret = process.env.STELLAR_SPONSOR_SECRET;
  if (!secret) throw new Error('STELLAR_SPONSOR_SECRET is not configured');
  return Keypair.fromSecret(secret);
}

function issuer(): Keypair {
  const secret = process.env.IDRT_ISSUER_SECRET;
  if (!secret) throw new Error('IDRT_ISSUER_SECRET is not configured');
  return Keypair.fromSecret(secret);
}

function server(): rpc.Server {
  return new rpc.Server(RPC_URL);
}

/**
 * Every write a Mini App user can trigger, and the exact contract + argument
 * shape it maps to.
 *
 * This is a strict allowlist, not a generic "invoke any method" relay. The
 * sponsor key that pays fees for these transactions is a shared server
 * secret with no per-user spending limit of its own — the thing standing
 * between "the wallet owner authorized this specific call" (which the
 * Soroban auth entry proves) and "the sponsor becomes an open relay for
 * arbitrary contract calls" is this list. `args` is validated per-action
 * here, never passed through from the client as free-form ScVal.
 */
export type RelayAction =
  | { kind: 'pool_join'; poolId: string; member: string }
  | { kind: 'pool_contribute'; poolId: string; member: string }
  | {
      kind: 'pool_create';
      poolId: string;
      organizer: string;
      token: string;
      gateway: string;
      contributionAmount: string;
      memberCount: number;
      cycleLengthSecs: number;
      deadlineOffsetSecs: number;
      penaltyAmount: string;
      exitPenaltyAmount: string;
      reserveBps: number;
    }
  | {
      kind: 'pool_request_priority_swap';
      poolId: string;
      requester: string;
      target: string;
      fee: string; // i128 as string
    }
  | { kind: 'pool_accept_priority_swap'; poolId: string; target: string; requester: string }
  | { kind: 'pool_reject_priority_swap'; poolId: string; target: string }
  | { kind: 'pool_force_close'; poolId: string; organizer: string };

function i128(value: string): xdr.ScVal {
  return nativeToScVal(BigInt(value), { type: 'i128' });
}

function buildInvocation(action: RelayAction): {
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  authAddress: string;
} {
  switch (action.kind) {
    case 'pool_join':
      return {
        contractId: action.poolId,
        method: 'join',
        args: [new Address(action.member).toScVal()],
        authAddress: action.member,
      };
    case 'pool_contribute':
      return {
        contractId: action.poolId,
        method: 'contribute',
        args: [new Address(action.member).toScVal()],
        authAddress: action.member,
      };
    case 'pool_create':
      // Argument order must match ArisanPool::create exactly:
      // organizer, token, gateway, contribution_amount, member_count,
      // cycle_length_secs, deadline_offset_secs, penalty_amount,
      // exit_penalty_amount, reserve_bps.
      return {
        contractId: action.poolId,
        method: 'create',
        args: [
          new Address(action.organizer).toScVal(),
          new Address(action.token).toScVal(),
          new Address(action.gateway).toScVal(),
          i128(action.contributionAmount),
          nativeToScVal(action.memberCount, { type: 'u32' }),
          nativeToScVal(action.cycleLengthSecs, { type: 'u64' }),
          nativeToScVal(action.deadlineOffsetSecs, { type: 'u64' }),
          i128(action.penaltyAmount),
          i128(action.exitPenaltyAmount),
          nativeToScVal(action.reserveBps, { type: 'u32' }),
        ],
        authAddress: action.organizer,
      };
    case 'pool_request_priority_swap':
      return {
        contractId: action.poolId,
        method: 'request_priority_swap',
        args: [
          new Address(action.requester).toScVal(),
          new Address(action.target).toScVal(),
          i128(action.fee),
        ],
        authAddress: action.requester,
      };
    case 'pool_accept_priority_swap':
      return {
        contractId: action.poolId,
        method: 'accept_priority_swap',
        args: [
          new Address(action.target).toScVal(),
          new Address(action.requester).toScVal(),
        ],
        authAddress: action.target,
      };
    case 'pool_reject_priority_swap':
      return {
        contractId: action.poolId,
        method: 'reject_priority_swap',
        args: [new Address(action.target).toScVal()],
        authAddress: action.target,
      };
    case 'pool_force_close':
      return {
        contractId: action.poolId,
        method: 'force_close',
        args: [new Address(action.organizer).toScVal()],
        authAddress: action.organizer,
      };
  }
}

export type PreparedRelay = {
  /** Opaque handle to the prepared transaction, held server-side. NOT the
   *  transaction itself — see the module comment on why. */
  relayId: string;
  /** The single auth entry belonging to the caller's wallet, unsigned, base64 XDR. */
  authEntryXdr: string;
  /** Passed back to `authorizeEntry` on the client, and reused at submit time. */
  validUntilLedgerSeq: number;
  networkPassphrase: string;
};

/**
 * Builds and simulates the transaction for one allowlisted action, sourced
 * from the sponsor account (which pays fees), stores the unsigned
 * transaction server-side, and returns a handle to it plus the one unsigned
 * Soroban auth entry that belongs to the caller — the only part the caller
 * needs to sign with their passkey.
 *
 * The transaction itself is deliberately NEVER sent to the client. If it
 * were, `submitRelay` would have no way to tell "a transaction this
 * function legitimately built" apart from "any transaction a client felt
 * like constructing" — and since a user can produce a valid signature for
 * their OWN wallet against literally any auth entry, that would turn the
 * sponsor into an open relay paying fees for arbitrary contract calls.
 * Keeping the transaction server-side and handing back only an opaque id is
 * what makes `buildInvocation`'s allowlist actually binding rather than
 * advisory.
 *
 * Simulation is what populates the auth entry's nonce and root invocation
 * tree; without running it first there is nothing correctly shaped for the
 * client to sign.
 */
export async function prepareRelay(action: RelayAction): Promise<PreparedRelay> {
  const { contractId, method, args, authAddress } = buildInvocation(action);
  const rpcServer = server();
  const sponsorKp = sponsor();
  const sponsorAccount = await rpcServer.getAccount(sponsorKp.publicKey());

  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(sponsorAccount, {
    fee: '1000000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  const simulated = await rpcServer.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulated)) {
    throw new Error(`simulation failed: ${simulated.error}`);
  }

  const authEntries = simulated.result?.auth ?? [];
  const mine = authEntries.find((entry) => {
    const credentials = entry.credentials();
    if (credentials.switch().name !== 'sorobanCredentialsAddress') return false;
    const entryAddress = Address.fromScAddress(
      credentials.address().address(),
    ).toString();
    return entryAddress === authAddress;
  });

  if (!mine) {
    throw new Error(
      `no auth entry found for ${authAddress} — is it really required to authorize this call?`,
    );
  }

  const latestLedger = await rpcServer.getLatestLedger();
  // A short window: this entry is only ever meant to be signed and
  // submitted within the same user interaction, not held for later.
  const validUntilLedgerSeq = latestLedger.sequence + 200;

  const assembled = rpc.assembleTransaction(tx, simulated).build();

  const relayId = randomBytes(24).toString('hex');
  const { error } = await supabase.from('pending_relays').insert({
    relay_id: relayId,
    tx_xdr: assembled.toXDR(),
    expires_at: new Date(Date.now() + RELAY_TTL_MS).toISOString(),
  });
  if (error) {
    throw new Error(`failed to store prepared relay: ${error.message}`);
  }

  return {
    relayId,
    authEntryXdr: mine.toXDR('base64'),
    validUntilLedgerSeq,
    networkPassphrase: NETWORK_PASSPHRASE,
  };
}

export type SubmitResult = { status: 'SUCCESS'; hash: string } | { status: 'FAILED'; hash: string };

/**
 * Reinserts the client-signed auth entry into the transaction `prepareRelay`
 * built and stored server-side, re-simulates (the entry's real signature
 * bytes change the resource footprint from what the placeholder-signed
 * simulation estimated), signs the outer envelope with the sponsor key,
 * submits, and polls to completion.
 *
 * `relayId` is looked up and deleted — single-use, like this codebase's
 * other short-lived server-issued tokens (`webauthn_challenges`,
 * `wallet_handoff_tokens`) — before any network call, so a retried or
 * replayed request cannot reuse the same stored transaction twice. There is
 * deliberately no client-supplied transaction XDR anywhere in this
 * function: the ONLY transaction content that can ever be submitted is
 * whatever `prepareRelay`'s allowlist decided to build, which is the entire
 * point of storing it server-side rather than round-tripping it through the
 * client.
 *
 * Mutates the parsed XDR envelope directly rather than rebuilding through
 * `TransactionBuilder` — the builder's operation API has no "insert this
 * exact raw operation" path, only ones that construct a fresh operation
 * from scratch, which would require re-deriving the host function call.
 * Editing the envelope's `auth` field in place and re-wrapping it in a
 * `Transaction` keeps every other field (source, sequence, fee, the host
 * function itself) exactly as `prepareRelay` built it.
 *
 * Reuses the sequence number already baked into the stored transaction
 * rather than fetching a fresh one — nothing was actually submitted between
 * prepare and submit, so the original sequence is still the correct one to
 * sign.
 */
export async function submitRelay(
  relayId: string,
  signedAuthEntryXdr: string,
): Promise<SubmitResult> {
  const rpcServer = server();
  const sponsorKp = sponsor();

  const { data: pending } = await supabase
    .from('pending_relays')
    .select('tx_xdr, expires_at')
    .eq('relay_id', relayId)
    .maybeSingle();

  await supabase.from('pending_relays').delete().eq('relay_id', relayId);

  if (!pending) {
    throw new Error('relay not found or already used');
  }
  if (new Date(pending.expires_at).getTime() < Date.now()) {
    throw new Error('relay expired');
  }

  const tx = TransactionBuilder.fromXDR(pending.tx_xdr, NETWORK_PASSPHRASE) as Transaction;
  const envelope = tx.toEnvelope();
  const operations = envelope.v1().tx().operations();
  if (operations.length !== 1) {
    throw new Error('unexpected transaction shape: expected exactly one operation');
  }
  const body = operations[0].body();
  if (body.switch().name !== 'invokeHostFunction') {
    throw new Error('unexpected transaction shape: expected invokeHostFunction');
  }
  const invocation = body.invokeHostFunctionOp();

  const signedEntry = xdr.SorobanAuthorizationEntry.fromXDR(signedAuthEntryXdr, 'base64');
  const signedAddress = Address.fromScAddress(
    signedEntry.credentials().address().address(),
  ).toString();

  const nextAuth = invocation.auth().map((entry) => {
    if (entry.credentials().switch().name !== 'sorobanCredentialsAddress') return entry;
    const entryAddress = Address.fromScAddress(
      entry.credentials().address().address(),
    ).toString();
    return entryAddress === signedAddress ? signedEntry : entry;
  });
  invocation.auth(nextAuth);

  const mutatedTx = new Transaction(envelope, NETWORK_PASSPHRASE);

  const resimulated = await rpcServer.simulateTransaction(mutatedTx);
  if (rpc.Api.isSimulationError(resimulated)) {
    throw new Error(`re-simulation with signed auth failed: ${resimulated.error}`);
  }

  const prepared = rpc.assembleTransaction(mutatedTx, resimulated).build();
  prepared.sign(sponsorKp);

  const sendResult = await rpcServer.sendTransaction(prepared);
  if (sendResult.status === 'ERROR') {
    throw new Error(`submit failed: ${JSON.stringify(sendResult)}`);
  }

  for (let i = 0; i < 20; i++) {
    const status = await rpcServer.getTransaction(sendResult.hash);
    if (status.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { status: 'SUCCESS', hash: sendResult.hash };
    }
    if (status.status === rpc.Api.GetTransactionStatus.FAILED) {
      return { status: 'FAILED', hash: sendResult.hash };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('transaction confirmation timed out');
}

/**
 * Invokes a contract method that genuinely needs no one's authorization —
 * `ArisanPool::distribute` and `::penalize` have no `require_auth()` call
 * anywhere in their bodies (confirmed by reading `cycle.rs` directly, not
 * assumed): they're permissionless by design, gated only by the cycle
 * deadline, so that a payout or a late-penalty can't be held hostage
 * waiting on any particular person to act.
 *
 * Because nothing needs signing, this skips the whole
 * prepare-store-sign-submit relay dance entirely: the sponsor is simply the
 * transaction's source and sole signer. Do NOT reuse this for anything that
 * calls `require_auth()` on a real user — that path exists precisely
 * because the sponsor's signature alone is never sufficient proof of a
 * user's consent.
 */
export async function callPermissionless(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<SubmitResult> {
  const rpcServer = server();
  const sponsorKp = sponsor();
  const sponsorAccount = await rpcServer.getAccount(sponsorKp.publicKey());

  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(sponsorAccount, {
    fee: '1000000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  const prepared = await rpcServer.prepareTransaction(tx);
  prepared.sign(sponsorKp);

  const sendResult = await rpcServer.sendTransaction(prepared);
  if (sendResult.status === 'ERROR') {
    throw new Error(`submit failed: ${JSON.stringify(sendResult)}`);
  }

  for (let i = 0; i < 20; i++) {
    const status = await rpcServer.getTransaction(sendResult.hash);
    if (status.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { status: 'SUCCESS', hash: sendResult.hash };
    }
    if (status.status === rpc.Api.GetTransactionStatus.FAILED) {
      return { status: 'FAILED', hash: sendResult.hash };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('transaction confirmation timed out');
}

/**
 * Invokes `ArisanPool::contribute_via_gateway`, authorized by the IDRT
 * issuer acting as the transaction's own source account. `pool.gateway` is
 * set to the issuer's address at pool creation (see `pool.ts`'s
 * `prepareCreatePool`), and a classic account satisfies its own
 * `require_auth()` just by being the transaction's signed source — no
 * separate Soroban auth entry needed, structurally identical to
 * `callPermissionless` except THIS call does require one specific party's
 * authorization (the issuer's), not none at all. Never reuse this for a
 * method whose real auth requirement belongs to a member, not the issuer.
 */
export async function callAsIssuer(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<SubmitResult> {
  const rpcServer = server();
  const issuerKp = issuer();
  const issuerAccount = await rpcServer.getAccount(issuerKp.publicKey());

  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(issuerAccount, {
    fee: '1000000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  const prepared = await rpcServer.prepareTransaction(tx);
  prepared.sign(issuerKp);

  const sendResult = await rpcServer.sendTransaction(prepared);
  if (sendResult.status === 'ERROR') {
    throw new Error(`submit failed: ${JSON.stringify(sendResult)}`);
  }

  for (let i = 0; i < 20; i++) {
    const status = await rpcServer.getTransaction(sendResult.hash);
    if (status.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { status: 'SUCCESS', hash: sendResult.hash };
    }
    if (status.status === rpc.Api.GetTransactionStatus.FAILED) {
      return { status: 'FAILED', hash: sendResult.hash };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('transaction confirmation timed out');
}

/** The subset of RelayAction a Mini App client may request directly through
 *  `/api/tx/prepare`. `pool_create` is deliberately excluded — it is only
 *  ever built server-side, from a pool's own stored draft terms, via
 *  `prepareCreatePool` in `pool.ts`, never from a client-supplied body. */
export type ClientRelayAction = Extract<
  RelayAction,
  { kind: 'pool_join' | 'pool_contribute' | 'pool_request_priority_swap' | 'pool_accept_priority_swap' | 'pool_reject_priority_swap' | 'pool_force_close' }
>;

/** Only used by API routes to translate a request body into a
 *  ClientRelayAction without trusting the client's contract id — the caller
 *  still has to check `poolId` against a real pool before preparing. */
export function assertRelayActionShape(value: unknown): ClientRelayAction {
  if (typeof value !== 'object' || value === null) {
    throw new Error('invalid action');
  }
  const v = value as Record<string, unknown>;
  if (
    (v.kind === 'pool_join' || v.kind === 'pool_contribute') &&
    typeof v.poolId === 'string' &&
    typeof v.member === 'string'
  ) {
    return v as ClientRelayAction;
  }
  if (
    v.kind === 'pool_request_priority_swap' &&
    typeof v.poolId === 'string' &&
    typeof v.requester === 'string' &&
    typeof v.target === 'string' &&
    typeof v.fee === 'string'
  ) {
    return v as ClientRelayAction;
  }
  if (
    v.kind === 'pool_accept_priority_swap' &&
    typeof v.poolId === 'string' &&
    typeof v.target === 'string' &&
    typeof v.requester === 'string'
  ) {
    return v as ClientRelayAction;
  }
  if (
    v.kind === 'pool_reject_priority_swap' &&
    typeof v.poolId === 'string' &&
    typeof v.target === 'string'
  ) {
    return v as ClientRelayAction;
  }
  if (
    v.kind === 'pool_force_close' &&
    typeof v.poolId === 'string' &&
    typeof v.organizer === 'string'
  ) {
    return v as ClientRelayAction;
  }
  throw new Error('invalid or unsupported action');
}

export { nativeToScVal };
