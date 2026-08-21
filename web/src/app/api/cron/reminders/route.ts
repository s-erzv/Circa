import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { bot, deepLinkKeyboard } from '@/lib/bot';
import { getPool } from '@/lib/soroban/read';
import { membersOwingThisCycle, runDistribute, runPenalize } from '@/lib/soroban/cycle';

/** How far ahead of a deadline to start nudging members who haven't paid. */
const REMINDER_WINDOW_SECS = 24 * 60 * 60;

/**
 * The heartbeat for every active arisan's cycle: reminds members before a
 * deadline, penalizes and pays out after one passes. Meant to be hit
 * periodically by an external scheduler (Vercel Cron or equivalent) — this
 * route holds no state of its own about "when to run next", it just acts
 * on whatever the chain says is currently due.
 *
 * Protected by a shared secret rather than requireUser(): nothing about
 * this action is scoped to a Telegram identity, it's infrastructure calling
 * infrastructure.
 */
export async function POST(request: Request) {
  const provided = request.headers.get('x-cron-secret');
  const expected = process.env.CRON_SECRET;
  if (!expected || provided !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { data: pools } = await supabase
    .from('pools')
    .select('id, contract_id, name, telegram_chat_id, status')
    .eq('status', 'active');

  const results: Array<{ poolId: string; action: string; detail?: unknown }> = [];

  for (const pool of pools ?? []) {
    if (!pool.contract_id) continue;
    try {
      await tickPool(pool, results);
    } catch (error) {
      console.error(`cron tick failed for pool ${pool.id}:`, error);
      results.push({ poolId: pool.id, action: 'error', detail: String(error) });
    }
  }

  return NextResponse.json({ ticked: results.length, results });
}

async function tickPool(
  pool: { id: string; contract_id: string; name: string; telegram_chat_id: string | null },
  results: Array<{ poolId: string; action: string; detail?: unknown }>,
) {
  const onChain = await getPool(pool.contract_id);
  const now = Math.floor(Date.now() / 1000);
  const deadline = Number(onChain.cycle_deadline);

  if (now < deadline) {
    // Before the deadline: remind, at most once per cycle.
    if (deadline - now > REMINDER_WINDOW_SECS) return;

    const { data: already } = await supabase
      .from('pool_reminders')
      .select('pool_id')
      .eq('pool_id', pool.id)
      .eq('cycle', onChain.current_cycle)
      .maybeSingle();
    if (already) return;

    const owing = await membersOwingThisCycle(pool.contract_id);
    if (owing.length === 0) return;

    const { data: owingUsers } = await supabase
      .from('users')
      .select('telegram_username')
      .in('wallet_address', owing);
    const names = (owingUsers ?? [])
      .map((u) => (u.telegram_username ? `@${u.telegram_username}` : null))
      .filter(Boolean)
      .join(', ');

    if (pool.telegram_chat_id) {
      const keyboard = deepLinkKeyboard('Setor Sekarang', `setor_${pool.id}`);
      await bot.api.sendMessage(
        pool.telegram_chat_id,
        `⏰ Pengingat setoran "${pool.name}": kurang dari 24 jam lagi ke deadline siklus ini.\n` +
          (names ? `Yang belum setor: ${names}` : 'Masih ada yang belum setor.'),
        { reply_markup: keyboard },
      );
    }

    await supabase
      .from('pool_reminders')
      .insert({ pool_id: pool.id, cycle: onChain.current_cycle });
    results.push({ poolId: pool.id, action: 'reminded', detail: owing.length });
    return;
  }

  // Deadline passed: penalize whoever still hasn't paid, then trigger the
  // payout. Both are on-chain-guarded against double-execution, so calling
  // them on every cron tick past the deadline is safe — the second call in
  // a cycle simply errors and is ignored here.
  const owing = await membersOwingThisCycle(pool.contract_id);
  for (const addr of owing) {
    try {
      await runPenalize(pool.contract_id, addr);
    } catch {
      // Already penalized this cycle, or some other guard tripped — fine.
    }
  }

  try {
    const distributed = await runDistribute(pool.contract_id);
    if (distributed.recipient) {
      const { data: recipientUser } = await supabase
        .from('users')
        .select('telegram_username')
        .eq('wallet_address', distributed.recipient)
        .maybeSingle();
      const label = recipientUser?.telegram_username
        ? `@${recipientUser.telegram_username}`
        : distributed.recipient.slice(0, 8) + '…';

      if (pool.telegram_chat_id) {
        await bot.api.sendMessage(
          pool.telegram_chat_id,
          `Giliran "${pool.name}" cair! Kali ini ke ${label}.`,
        );
      }

      const after = await getPool(pool.contract_id);
      if (after.closed) {
        await supabase.from('pools').update({ status: 'closed' }).eq('id', pool.id);
        if (pool.telegram_chat_id) {
          await bot.api.sendMessage(
            pool.telegram_chat_id,
            `Arisan "${pool.name}" udah selesai — semua kebagian giliran. Makasih udah ikut!`,
          );
        }
      }
      results.push({ poolId: pool.id, action: 'distributed', detail: distributed.recipient });
    }
  } catch {
    // Payout not due yet by the contract's own accounting, or no eligible
    // recipient this pass — nothing to do until the next tick.
  }
}
