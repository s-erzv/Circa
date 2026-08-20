import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { getPool } from '@/lib/pools';
import { getPool as getOnChainPool, getPoolQueue } from '@/lib/soroban/read';

/**
 * Live payout schedule — read fresh from the contract every time, not
 * cached from the activation announcement. gov_skip/gov_kick/exit can all
 * reorder or shrink the queue after activation, so a snapshot taken once
 * would silently go stale exactly when it matters most (right after a
 * skip vote passes, say). The contract's queue IS the current truth; this
 * route just formats it.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireUser(request);
  } catch {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const pool = await getPool(id);
  if (!pool || !pool.contract_id) {
    return NextResponse.json({ error: 'Arisan tidak ditemukan.' }, { status: 404 });
  }
  if (!['active', 'closed'].includes(pool.status)) {
    return NextResponse.json(
      { error: 'Jadwal baru ada setelah arisan aktif (semua slot terisi).' },
      { status: 409 },
    );
  }

  const [queue, onChain] = await Promise.all([
    getPoolQueue(pool.contract_id),
    getOnChainPool(pool.contract_id),
  ]);

  const { data: members } = await supabase
    .from('users')
    .select('telegram_username, wallet_address')
    .in('wallet_address', queue.length > 0 ? queue : ['']);

  const firstDeadlineMs = Number(onChain.cycle_deadline) * 1000;
  const cycleMs = Number(onChain.cycle_length_secs) * 1000;

  const schedule = queue.map((addr, i) => {
    const m = members?.find((mm) => mm.wallet_address === addr);
    return {
      position: i + 1,
      label: m?.telegram_username ? `@${m.telegram_username}` : `${addr.slice(0, 8)}…`,
      approxDateMs: firstDeadlineMs + i * cycleMs,
    };
  });

  return NextResponse.json({
    name: pool.name,
    currentCycle: onChain.current_cycle,
    closed: onChain.closed,
    schedule,
  });
}
