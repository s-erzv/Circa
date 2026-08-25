import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { getMemberStatus, getPool } from '@/lib/pools';

/**
 * Read-only pool info for the Mini App. Anyone who knows the id may view
 * it (mirrors the "Pools are viewable by everyone" policy already on the
 * table) — the caller's identity is used only to compute `isOrganizer`, so
 * the client knows whether to show the deploy/confirm action.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try {
    user = await requireUser(request);
  } catch {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const pool = await getPool(id);
  if (!pool) {
    return NextResponse.json({ error: 'Arisan tidak ditemukan.' }, { status: 404 });
  }

  const memberStatus = await getMemberStatus(id, user.id);

  let currentCycle = 0;
  let nextDeadline: number | null = null;
  let queue: string[] = [];
  
  if (pool.contract_id) {
    try {
      // Import dynamically or ensure getOnChainPool is available
      const { getPool: getOnChainPool } = await import('@/lib/soroban/read');
      const onChain = await getOnChainPool(pool.contract_id);
      currentCycle = onChain.current_cycle + 1; // 1-indexed for display
      nextDeadline = Number(onChain.cycle_deadline);
      queue = onChain.queue;
    } catch (e) {
      console.error('Failed to fetch on-chain pool data', e);
    }
  }

  return NextResponse.json({
    id: pool.id,
    name: pool.name,
    status: pool.status,
    contractId: pool.contract_id,
    memberCount: pool.member_count,
    contributionAmount: pool.contribution_amount,
    cycleLengthSecs: pool.cycle_length_secs,
    isOrganizer: pool.organizer_telegram_id === user.id,
    memberStatus,
    currentCycle,
    nextDeadline,
    queue,
  });
}
