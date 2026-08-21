import { NextResponse } from 'next/server';
import { InlineKeyboard } from 'grammy';
import { requireUser } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { getPool } from '@/lib/pools';
import { bot } from '@/lib/bot';

/**
 * Called by the client once the organizer's signed `create()` transaction
 * has actually succeeded on-chain. Flips the pool from 'deploying' to
 * 'forming' and announces it in the group with the "Gabung" button —
 * this is the point a draft becomes something the rest of the group can
 * act on.
 *
 * Trusts the client's claim of success no further than any other write:
 * organizer-only, and only valid from 'deploying'. If a caller lied about
 * success, the pool just sits in 'forming' with no real contract behind
 * it and every join attempt will fail against the chain — annoying, not
 * unsafe, since nothing here moves funds.
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
  if (!pool) {
    return NextResponse.json({ error: 'Arisan tidak ditemukan.' }, { status: 404 });
  }
  if (pool.organizer_telegram_id !== user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (pool.status !== 'deploying' || !pool.contract_id) {
    return NextResponse.json({ error: 'Status arisan tidak sesuai.' }, { status: 409 });
  }

  await supabase.from('pools').update({ status: 'forming' }).eq('id', id);

  if (pool.telegram_chat_id) {
    const keyboard = new InlineKeyboard().text('Gabung', `gabung:${pool.id}`);
    await bot.api
      .sendMessage(
        pool.telegram_chat_id,
        `Arisan "${pool.name}" udah resmi jadi kontrak on-chain!\n\n` +
          `${pool.member_count} slot tersedia. Yuk siapa yang mau ikut, tap tombol di bawah.`,
        { reply_markup: keyboard },
      )
      .catch((err) => console.error('failed to announce pool creation:', err));
  }

  return NextResponse.json({ ok: true });
}
