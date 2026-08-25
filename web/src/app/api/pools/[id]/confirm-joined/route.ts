import { NextResponse } from 'next/server';
import { InlineKeyboard } from 'grammy';
import { requireUser } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { getPool, markJoinedOnChain } from '@/lib/pools';
import { isPoolActivated, getPoolQueue, getPool as getOnChainPool } from '@/lib/soroban/read';
import { bot, deepLinkUrl } from '@/lib/bot';

/**
 * Called by the client once a member's signed `join()` transaction has
 * succeeded on-chain. Marks their row `joined`, then checks whether the
 * pool has just activated (every seat filled) — if so, flips it to
 * 'active' and announces the kocokan (draw order) in the group, the
 * moment traditional arisan treats as the most dramatic one.
 *
 * The activation check reads the CONTRACT, not a locally-tracked join
 * count: `is_activated` is the one fact only the chain can answer
 * correctly, since the contract is what actually decides when the roster
 * is full.
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

  await markJoinedOnChain(id, user.id);

  // Confirm membership privately with the actual rules, right at the
  // moment they take effect for this specific person — the group-wide
  // summary shown at draft time is easy to have scrolled past by the time
  // someone actually joins.
  if (pool.contribution_amount && pool.cycle_length_secs && pool.penalty_amount != null && pool.exit_penalty_amount != null) {
    const cycleDays = Math.round(pool.cycle_length_secs / 86400);
    await bot.api
      .sendMessage(
        user.id,
        `Kamu resmi gabung "${pool.name}".\n\n` +
          `Aturan mainnya:\n` +
          `• Setoran Rp${pool.contribution_amount.toLocaleString('id-ID')} tiap ${cycleDays} hari\n` +
          `• Telat lewat batas: kena denda Rp${pool.penalty_amount.toLocaleString('id-ID')}\n` +
          `• Keluar duluan sebelum kelar: kena potongan Rp${pool.exit_penalty_amount.toLocaleString('id-ID')}\n\n` +
          `Balik ke grup buat lihat perkembangannya ya.`,
      )
      .catch((err) => console.error('failed to DM new-member rules:', err));
  }

  try {
    const activated = await isPoolActivated(pool.contract_id);
    if (activated && pool.status !== 'active') {
      await supabase.from('pools').update({ status: 'active' }).eq('id', id);

      if (pool.telegram_chat_id) {
        const [queue, onChain] = await Promise.all([
          getPoolQueue(pool.contract_id),
          getOnChainPool(pool.contract_id),
        ]);
        const { data: members } = await supabase
          .from('users')
          .select('telegram_id, telegram_username, wallet_address')
          .in('wallet_address', queue);

        // cycle_deadline is the contract's own first-payout deadline, set
        // at activation to now + cycle_length_secs — the actual anchor
        // point, not a guess. Each later position is one more cycle out.
        // This is a projection, not a promise: gov_skip/gov_kick/exit can
        // still reorder or shrink the queue after this message is sent, so
        // it says so plainly rather than reading as a locked-in calendar.
        const fmt = new Intl.DateTimeFormat('id-ID', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        });
        const firstDeadlineMs = Number(onChain.cycle_deadline) * 1000;
        const cycleMs = Number(onChain.cycle_length_secs) * 1000;

        const order = queue
          .map((addr, i) => {
            const m = members?.find((mm) => mm.wallet_address === addr);
            const label = m?.telegram_username ? `@${m.telegram_username}` : addr.slice(0, 8) + '…';
            const date = fmt.format(new Date(firstDeadlineMs + i * cycleMs));
            return `${i + 1}. ${label} — sekitar ${date}`;
          })
          .join('\n');

        const keyboard = new InlineKeyboard()
          .url('Setor Sekarang', deepLinkUrl(`setor_${pool.id}`))
          .url('Lihat Jadwal', deepLinkUrl(`jadwal_${pool.id}`));
        await bot.api
          .sendMessage(
            pool.telegram_chat_id,
            `Slot penuh! Arisan "${pool.name}" udah aktif.\n\n` +
              `Urutan kocokan:\n${order}\n\n` +
              `Ini proyeksi — bisa geser kalau ada yang di-skip/keluar/dikeluarkan lewat voting. ` +
              `Giliran yang sebenarnya selalu bisa dicek langsung di kontrak. Yuk mulai setor.`,
            { reply_markup: keyboard },
          )
          .catch((err) => console.error('failed to announce activation:', err));
      }
    }
  } catch (error) {
    // The join already succeeded on-chain and is already recorded; a
    // failure here only means the group misses the activation
    // announcement, not that anything is inconsistent.
    console.error('post-join activation check failed:', error);
  }

  return NextResponse.json({ ok: true });
}
