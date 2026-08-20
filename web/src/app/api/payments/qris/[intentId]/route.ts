import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { supabase } from '@/lib/supabase';

/** Polled by the Mini App while the user has the QR on screen, waiting for
 *  the webhook to land. Scoped to the caller's own intent — a payment
 *  status is not something another Telegram user should be able to read. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ intentId: string }> },
) {
  let user;
  try {
    user = await requireUser(request);
  } catch {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { intentId } = await params;
  const { data: intent } = await supabase
    .from('payment_intents')
    .select('telegram_id, status, amount')
    .eq('id', intentId)
    .maybeSingle();

  if (!intent || intent.telegram_id !== user.id) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  return NextResponse.json({ status: intent.status, amount: intent.amount });
}
