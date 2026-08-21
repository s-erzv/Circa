import { deployContract } from './deploy';
import { prepareRelay, type PreparedRelay } from './tx-relay';

/**
 * Deploys a fresh `ArisanPool` contract instance.
 *
 * `ArisanPool` has no `__constructor` — its state is set up by a separate
 * `create()` call, which needs the organizer's own signature (unlike the
 * deploy itself, which needs only the sponsor's). So this only ever returns
 * a bare, uninitialized contract id; the caller must follow up with a
 * `pool_create` relay action signed by the organizer before the pool is
 * usable for anything.
 */
export async function deployPoolContract(): Promise<string> {
  const wasmHashHex = process.env.ARISAN_POOL_WASM_HASH;
  if (!wasmHashHex) throw new Error('ARISAN_POOL_WASM_HASH is not configured');
  return deployContract(wasmHashHex, []);
}

export type PoolDraftTerms = {
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
};

/**
 * Prepares the organizer-signed `create()` call against an already-deployed
 * pool contract. Returns the same shape `/api/tx/prepare` returns for
 * join/contribute, so the client's existing sign-and-submit flow
 * (`relay-client.ts`) works unmodified for pool creation too.
 */
export async function prepareCreatePool(
  poolId: string,
  terms: PoolDraftTerms,
): Promise<PreparedRelay> {
  return prepareRelay({
    kind: 'pool_create',
    poolId,
    organizer: terms.organizer,
    token: terms.token,
    gateway: terms.gateway,
    contributionAmount: terms.contributionAmount,
    memberCount: terms.memberCount,
    cycleLengthSecs: terms.cycleLengthSecs,
    deadlineOffsetSecs: terms.deadlineOffsetSecs,
    penaltyAmount: terms.penaltyAmount,
    exitPenaltyAmount: terms.exitPenaltyAmount,
    reserveBps: terms.reserveBps,
  });
}
