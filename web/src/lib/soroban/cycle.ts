import { Address } from '@stellar/stellar-sdk';
import { callPermissionless, prepareRelay, type PreparedRelay } from './tx-relay';
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
    (m, i) => !m.received_payout && after[i].received_payout,
  );

  return {
    recipient: flippedIndex === -1 ? null : members[flippedIndex],
    netPayout: null,
    hash: result.hash,
  };
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
