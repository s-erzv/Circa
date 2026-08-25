import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { bot, deepLinkKeyboard } from '@/lib/bot';

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
  const { target, fee } = await request.json();

  if (!target || !fee) {
    return NextResponse.json({ error: 'Target dan fee diperlukan.' }, { status: 400 });
  }

  const { data: pool } = await supabase
    .from('pools')
    .select('id, name')
    .eq('id', id)
    .single();

  if (!pool) {
    return NextResponse.json({ error: 'Arisan tidak ditemukan.' }, { status: 404 });
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
    const feeNum = Number(fee);
    const feeFormatted = isNaN(feeNum) ? fee : feeNum.toLocaleString('id-ID');

    // Notify the target user via DM
    await bot.api.sendMessage(
      targetUser.telegram_id,
      `*Permintaan Tukar Giliran (Piauw)*\n\n` +
      `Seseorang di arisan "${pool.name}" ingin menukar gilirannya dengan giliranmu yang lebih awal.\n\n` +
      `Sebagai gantinya, dia menawarkan fee sebesar *Rp${feeFormatted}* yang akan dimasukkan ke kas cadangan arisan.\n\n` +
      `Pilih aksi di bawah:`,
      { 
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Setuju Tukar', url: `https://t.me/${process.env.TELEGRAM_BOT_USERNAME ?? 'circagram_bot'}?start=apswap_${pool.id}` }],
            [{ text: 'Tolak', url: `https://t.me/${process.env.TELEGRAM_BOT_USERNAME ?? 'circagram_bot'}?start=rpswap_${pool.id}` }]
          ]
        }
      }
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Failed to notify pswap:', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
