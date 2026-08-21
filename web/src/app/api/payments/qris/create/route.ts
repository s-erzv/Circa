import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { getPool } from '@/lib/pools';
import { createQrCode } from '@/lib/payments/xendit';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const MIN_IDR = 10_000;
const MAX_IDR = 5_000_000;

/**
 * Starts a QRIS payment — either a generic wallet top-up (`amount`) or a
 * specific pool's setoran (`poolId`), creating the tracking row first (so
 * the webhook always has something to find, even if Xendit's response
 * never reaches us), then asking Xendit for the actual QR code.
 *
 * For `poolId`, the amount is the pool's own `contribution_amount` — never
 * client-supplied — since this is what the webhook later credits on-chain
 * via `contribute_via_gateway`, and a client-controlled amount there would
 * let a payer choose their own contribution size.
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

  const body = await request.json().catch(() => ({}));
  let amountIdr: number;
  let poolId: string | null = null;

  if (body.poolId) {
    const pool = await getPool(body.poolId);
    if (!pool || !pool.contract_id || pool.status !== 'active') {
      return NextResponse.json({ error: 'Arisan ini belum aktif atau udah selesai.' }, { status: 409 });
    }
    if (!pool.contribution_amount) {
      return NextResponse.json({ error: 'internal: missing contribution_amount' }, { status: 500 });
    }
    poolId = pool.id;
    amountIdr = pool.contribution_amount;
  } else {
    amountIdr = Number(body.amount);
    if (!Number.isInteger(amountIdr) || amountIdr < MIN_IDR || amountIdr > MAX_IDR) {
      return NextResponse.json(
        { error: `Nominal harus antara Rp${MIN_IDR.toLocaleString('id-ID')} dan Rp${MAX_IDR.toLocaleString('id-ID')}.` },
        { status: 400 },
      );
    }
  }

  const { data: intent, error } = await supabase
    .from('payment_intents')
    .insert({
      telegram_id: user.id,
      wallet_address: userRow.wallet_address,
      amount: amountIdr,
      pool_id: poolId,
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
