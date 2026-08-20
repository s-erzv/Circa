import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { createQrCode } from '@/lib/payments/xendit';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const MIN_IDR = 10_000;
const MAX_IDR = 5_000_000;

/**
 * Starts a QRIS top-up: creates the tracking row first (so the webhook
 * always has something to find, even if Xendit's response never reaches
 * us), then asks Xendit for the actual QR code.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireUser(request);
  } catch {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { data: userRow } = await supabase
    .from('users')
    .select('wallet_address')
    .eq('telegram_id', user.id)
    .maybeSingle();
  if (!userRow?.wallet_address) {
    return NextResponse.json({ error: 'Kamu belum punya dompet.' }, { status: 409 });
  }

  const { amount } = await request.json().catch(() => ({ amount: null }));
  const amountIdr = Number(amount);
  if (!Number.isInteger(amountIdr) || amountIdr < MIN_IDR || amountIdr > MAX_IDR) {
    return NextResponse.json(
      { error: `Nominal harus antara Rp${MIN_IDR.toLocaleString('id-ID')} dan Rp${MAX_IDR.toLocaleString('id-ID')}.` },
      { status: 400 },
    );
  }

  const { data: intent, error } = await supabase
    .from('payment_intents')
    .insert({
      telegram_id: user.id,
      wallet_address: userRow.wallet_address,
      amount: amountIdr,
      xendit_qr_id: '',
      external_id: '',
      status: 'pending',
    })
    .select()
    .single();

  if (error || !intent) {
    console.error('failed to create payment intent:', error);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }

  try {
    const qr = await createQrCode({
      externalId: intent.id,
      amountIdr,
      callbackUrl: `${APP_URL}/api/payments/xendit/webhook`,
    });

    await supabase
      .from('payment_intents')
      .update({ xendit_qr_id: qr.id, external_id: qr.external_id })
      .eq('id', intent.id);

    return NextResponse.json({ intentId: intent.id, qrString: qr.qr_string });
  } catch (err) {
    console.error('Xendit QR creation failed:', err);
    await supabase.from('payment_intents').update({ status: 'failed' }).eq('id', intent.id);
    return NextResponse.json({ error: 'Gagal bikin kode QRIS. Coba lagi ya.' }, { status: 502 });
  }
}
