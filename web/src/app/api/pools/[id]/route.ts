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
  });
}
