import { supabase } from '../src/lib/supabase';
import { createQrCode, simulateQrPayment } from '../src/lib/payments/xendit';

/**
 * Test-only convenience: does the same thing tapping "Isi Saldo (QRIS)" and
 * then scanning the code with a real e-wallet would, except the second half
 * (an actual scan) isn't possible against a sandbox `xnd_development_` key.
 * This calls Xendit's own test-mode simulate-payment endpoint instead, so
 * the real webhook still fires and mints IDRT the same way a real payment
 * would — nothing about the mint path is faked, only the "someone scanned
 * it" part.
 *
 * Usage: pnpm run simulate-topup <telegramId> <amountIdr>
 */
async function main() {
  const [telegramId, amountArg] = process.argv.slice(2);
  const amountIdr = Number(amountArg);

  if (!telegramId || !Number.isInteger(amountIdr) || amountIdr <= 0) {
    console.error('Usage: pnpm run simulate-topup <telegramId> <amountIdr>');
    process.exit(1);
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    console.error('NEXT_PUBLIC_APP_URL is not configured.');
    process.exit(1);
  }

  const { data: userRow } = await supabase
    .from('users')
    .select('wallet_address')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (!userRow?.wallet_address) {
    console.error(`No wallet found for telegram_id=${telegramId}. Create one in the Mini App first.`);
    process.exit(1);
  }

  const { data: intent, error } = await supabase
    .from('payment_intents')
    .insert({
      telegram_id: telegramId,
      wallet_address: userRow.wallet_address,
      amount: amountIdr,
      xendit_qr_id: '',
      external_id: '',
      status: 'pending',
    })
    .select()
    .single();

  if (error || !intent) {
    console.error('Failed to create payment_intent:', error);
    process.exit(1);
  }

  const qr = await createQrCode({
    externalId: intent.id,
    amountIdr,
    callbackUrl: `${appUrl}/api/payments/xendit/webhook`,
  });

  await supabase
    .from('payment_intents')
    .update({ xendit_qr_id: qr.id, external_id: qr.external_id })
    .eq('id', intent.id);

  console.log(`Created intent ${intent.id}, simulating a Rp${amountIdr.toLocaleString('id-ID')} payment...`);
  await simulateQrPayment(qr.external_id, amountIdr);
  console.log('Simulated. Watch the bot/webhook logs for the mint confirmation.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
