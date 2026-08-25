import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { getPendingPrioritySwap } from '@/lib/soroban/read';
import { bot } from '@/lib/bot';

/**
 * DMs the target of a priority-swap request. `fee` is never taken from the
 * request body — it, and the fact that a pending request legitimately
 * exists at all, are read straight from the contract's own storage and
 * cross-checked against the caller.
 *
 * Two problems with trusting the client here: first, without verifying the
 * caller is genuinely the swap's requester, anyone could get any other
 * registered user DM'd an arbitrary "someone wants to swap with you"
 * message — a harassment/social-engineering vector with no real request
 * behind it. Second, a client-supplied `fee` embedded into a
 * `parse_mode: 'Markdown'` message is a Markdown-injection path — Telegram
 * markdown supports `[text](url)` links, so an unvalidated string there is
 * a phishing vector wearing the bot's own trusted identity. Reading both
 * facts from chain closes both at once: the fee is always a real i128, and
 * the DM only ever fires for a swap that actually exists with this caller
 * as its real requester.
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
  const { target } = await request.json();
  if (typeof target !== 'string' || !target) {
    return NextResponse.json({ error: 'Target diperlukan.' }, { status: 400 });
  }

  const { data: pool } = await supabase
    .from('pools')
    .select('id, name, contract_id')
    .eq('id', id)
    .maybeSingle();
  if (!pool?.contract_id) {
    return NextResponse.json({ error: 'Arisan tidak ditemukan.' }, { status: 404 });
  }

  const { data: callerRow } = await supabase
    .from('users')
    .select('wallet_address')
    .eq('telegram_id', user.id)
    .maybeSingle();
  if (!callerRow?.wallet_address) {
    return NextResponse.json({ error: 'Kamu belum punya dompet.' }, { status: 409 });
  }

  const pending = await getPendingPrioritySwap(pool.contract_id, target);
  if (!pending || pending.requester !== callerRow.wallet_address) {
    return NextResponse.json(
      { error: 'Nggak ada permintaan tukar giliran dari kamu ke target ini.' },
      { status: 403 },
    );
  }

  const { data: targetUser } = await supabase
    .from('users')
    .select('telegram_id')
    .eq('wallet_address', target)
    .maybeSingle();
  if (!targetUser?.telegram_id) {
    return NextResponse.json({ error: 'Pengguna target belum terdaftar.' }, { status: 404 });
  }

  try {
    const feeFormatted = Number(pending.fee).toLocaleString('id-ID');

    await bot.api.sendMessage(
      targetUser.telegram_id,
      `Permintaan Tukar Giliran (Piauw)\n\n` +
        `Seseorang di arisan "${pool.name}" ingin menukar gilirannya dengan giliranmu yang lebih awal.\n\n` +
        `Sebagai gantinya, dia menawarkan fee sebesar Rp${feeFormatted} yang akan dimasukkan ke kas cadangan arisan.\n\n` +
        `Pilih aksi di bawah:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Setuju Tukar', url: `https://t.me/${process.env.TELEGRAM_BOT_USERNAME ?? 'circagram_bot'}?start=apswap_${pool.id}` }],
            [{ text: 'Tolak', url: `https://t.me/${process.env.TELEGRAM_BOT_USERNAME ?? 'circagram_bot'}?start=rpswap_${pool.id}` }],
          ],
        },
      },
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Failed to notify pswap:', err);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}
