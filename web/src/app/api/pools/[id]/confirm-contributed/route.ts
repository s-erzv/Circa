import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { getPool } from '@/lib/pools';
import { getPool as getOnChainPool } from '@/lib/soroban/read';
import { bot } from '@/lib/bot';

/**
 * Called by the client once a member's signed `contribute()` has succeeded
 * on-chain. Unlike join, there's no local "joined" flag to flip — the
 * chain is already the source of truth for who's paid this cycle — so this
 * exists purely to announce it: the moment a real arisan already runs on,
 * everyone in the group seeing who's paid and who hasn't.
 */
export async function POST(
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
  if (!pool || !pool.contract_id) {
    return NextResponse.json({ error: 'Arisan tidak ditemukan.' }, { status: 404 });
  }

  if (pool.telegram_chat_id) {
    try {
      const { data: userRow } = await supabase
        .from('users')
        .select('telegram_username')
        .eq('telegram_id', user.id)
        .maybeSingle();

      const onChain = await getOnChainPool(pool.contract_id);
      const label = userRow?.telegram_username ? `@${userRow.telegram_username}` : 'Seseorang';
      const target = (pool.contribution_amount ?? 0) * (pool.member_count ?? 0);

      await bot.api
        .sendMessage(
          pool.telegram_chat_id,
          `💰 ${label} udah setor buat siklus ke-${onChain.current_cycle}.\n` +
            `Terkumpul: Rp${onChain.cycle_pot.toLocaleString('id-ID')} / Rp${target.toLocaleString('id-ID')}`,
        )
        .catch((err) => console.error('failed to announce contribution:', err));
    } catch (error) {
      // The contribution already succeeded on-chain regardless — a failure
      // here only means the group misses the announcement.
      console.error('post-contribute announcement failed:', error);
    }
  }

  return NextResponse.json({ ok: true });
}
