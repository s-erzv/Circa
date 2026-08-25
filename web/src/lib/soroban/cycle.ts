import { Address } from '@stellar/stellar-sdk';
import { callAsIssuer, callPermissionless, prepareRelay, type PreparedRelay } from './tx-relay';
import { getMember, getPool, listPoolMembers } from './read';

/** Prepares a member-signed `contribute()` call — reuses the same
 *  prepare→sign→submit relay path as `join()`, since contribute() also
 *  requires the member's own auth. */
export async function prepareContribute(
  poolId: string,
  member: string,
): Promise<PreparedRelay> {
  return prepareRelay({ kind: 'pool_contribute', poolId, member });
}

export type DistributeResult = {
  recipient: string | null;
  netPayout: string | null;
  hash: string;
};

/**
 * Triggers a cycle's payout. `distribute()` is permissionless and
 * deadline-gated (see `callPermissionless`'s doc comment), so this needs no
 * user signature — it can run from a cron job with no one present.
 *
 * The contract publishes a `Distributed` event naming the recipient, but
 * parsing contract events out of transaction result meta is its own piece
 * of XDR plumbing this codebase hasn't needed yet. Diffing `received_payout`
 * across every member before and after the call gets the same answer more
 * simply, at the cost of a few extra reads — acceptable for arisan-sized
 * member counts.
 */
export async function runDistribute(poolId: string): Promise<DistributeResult> {
  const members = await listPoolMembers(poolId);
  const before = await Promise.all(members.map((addr) => getMember(poolId, addr)));

  const result = await callPermissionless(poolId, 'distribute');
  if (result.status !== 'SUCCESS') {
    return { recipient: null, netPayout: null, hash: result.hash };
  }

  const after = await Promise.all(members.map((addr) => getMember(poolId, addr)));
  const flippedIndex = before.findIndex(
    (m: any, i: number) => !m.received_payout && after[i].received_payout,
  );

  return {
    recipient: flippedIndex === -1 ? null : members[flippedIndex],
    netPayout: null,
    hash: result.hash,
  };
}

/**
 * Records a QRIS-paid contribution — called after the payment webhook
 * confirms real money moved, never from a client request. No member
 * signature is involved: `contribute_via_gateway` on the contract requires
 * the issuer's own auth instead (see its doc comment in cycle.rs), which
 * `callAsIssuer` satisfies directly with the held issuer keypair.
 */
export async function runContributeViaGateway(poolId: string, member: string): Promise<void> {
  const result = await callAsIssuer(poolId, 'contribute_via_gateway', [
    new Address(member).toScVal(),
  ]);
  if (result.status !== 'SUCCESS') {
    throw new Error(`contribute_via_gateway failed: ${result.hash}`);
  }
}

/** Flags a member who missed their contribution deadline. Also
 *  permissionless — same reasoning as `runDistribute`. */
export async function runPenalize(poolId: string, member: string): Promise<void> {
  await callPermissionless(poolId, 'penalize', [new Address(member).toScVal()]);
}

/** Members of an active pool who have not yet contributed this cycle —
 *  exactly who a reminder should reach before the deadline passes. */
export async function membersOwingThisCycle(poolId: string): Promise<string[]> {
  const pool = await getPool(poolId);
  const members = await Promise.all(
    pool.members.map(async (addr) => ({ addr, m: await getMember(poolId, addr) })),
  );
  return members
    .filter(({ m }) => !m.exited && !m.contributed_this_cycle)
    .map(({ addr }) => addr);
}

/** Organizer force-closes the pool. Uses the organizer's own wallet via
 *  the Mini App relay (passkey required). Exposed here as a relay-prepare
 *  helper so the Mini App can initiate the signed flow. */
export async function prepareForceClose(
  poolId: string,
  organizer: string,
): Promise<import('./tx-relay').PreparedRelay> {
  return prepareRelay({ kind: 'pool_force_close', poolId, organizer });
}

/** Prepare a priority-swap request (member moving themselves earlier in
 *  the queue by offering a fee to the pool reserve). */
export async function prepareRequestPrioritySwap(
  poolId: string,
  requester: string,
  target: string,
  fee: bigint,
): Promise<import('./tx-relay').PreparedRelay> {
  return prepareRelay({
    kind: 'pool_request_priority_swap',
    poolId,
    requester,
    target,
    fee: fee.toString(),
  });
}

/** Prepare acceptance of a priority-swap request. */
export async function prepareAcceptPrioritySwap(
  poolId: string,
  target: string,
  requester: string,
): Promise<import('./tx-relay').PreparedRelay> {
  return prepareRelay({ kind: 'pool_accept_priority_swap', poolId, target, requester });
}

/** Prepare rejection of a priority-swap request. */
export async function prepareRejectPrioritySwap(
  poolId: string,
  target: string,
): Promise<import('./tx-relay').PreparedRelay> {
  return prepareRelay({ kind: 'pool_reject_priority_swap', poolId, target });
}

