import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { verifyWebhookToken, type XenditQrPaymentWebhook } from '@/lib/payments/xendit';
import { mintIdrt } from '@/lib/payments/mint';
import { runContributeViaGateway } from '@/lib/soroban/cycle';
import { getPool as getOnChainPool } from '@/lib/soroban/read';
import { getPool as getPoolRow } from '@/lib/pools';
import { bot } from '@/lib/bot';

/**
 * Where a real QRIS payment turns into an on-chain credit.
 *
 * This is a public endpoint by necessity (Xendit calls it, not a Telegram
 * user), so `requireUser`/initData do not apply here — the trust boundary
 * is `x-callback-token` instead, a static value only Xendit and we know.
 * Every other check below exists because a public endpoint is a public
 * endpoint: assume someone will call it directly with a forged body.
 */
export async function POST(request: Request) {
  if (!verifyWebhookToken(request.headers.get('x-callback-token'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body: XenditQrPaymentWebhook = await request.json();
  if (body.event !== 'qr.payment') {
    // Ignore anything we don't specifically handle rather than erroring —
    // Xendit may add event types this endpoint has no opinion about.
    return NextResponse.json({ ok: true });
  }

  const externalId = body.external_id ?? body.qr_code?.external_id;
  if (!externalId) {
    return NextResponse.json({ error: 'missing external_id' }, { status: 400 });
  }

  const { data: intent } = await supabase
    .from('payment_intents')
    .select('*')
    .eq('external_id', externalId)
    .maybeSingle();

  if (!intent) {
    // Could be a QR code created outside this flow, or a reconfigured
    // callback URL from a stale test — either way, nothing here to credit.
    console.warn(`Xendit webhook: no payment_intent for external_id=${externalId}`);
    return NextResponse.json({ ok: true });
  }

  // Idempotency: Xendit retries webhooks that don't get a fast 2xx, and a
  // network blip could deliver the same event twice. Claim the row with an
  // UPDATE conditioned on status still being 'pending' — only the request
  // that wins this race proceeds to mint; a retry finds status already
  // 'paid' and does nothing further.
  const { data: claimed } = await supabase
    .from('payment_intents')
    .update({ status: 'paid' })
    .eq('id', intent.id)
    .eq('status', 'pending')
    .select()
    .maybeSingle();

  if (!claimed) {
    return NextResponse.json({ ok: true });
  }

  // Sanity check even after verifying the callback token: the amount paid
  // must match what we asked for. A mismatch here would mean either a
  // Xendit-side inconsistency or a QR code that was tampered with/reused —
  // either way, do not mint blindly.
  if (body.amount !== claimed.amount) {
    console.error(
      `Xendit webhook amount mismatch for intent ${claimed.id}: expected ${claimed.amount}, got ${body.amount}`,
    );
    await supabase.from('payment_intents').update({ status: 'failed' }).eq('id', claimed.id);
    return NextResponse.json({ error: 'amount mismatch' }, { status: 400 });
  }

  try {
    if (claimed.pool_id) {
      // A pool's setoran, paid straight through the gateway: no separate
      // top-up, no member signature — see contribute_via_gateway's doc
      // comment in cycle.rs for why a deposit doesn't need one.
      const pool = await getPoolRow(claimed.pool_id);
      if (!pool?.contract_id) {
        throw new Error(`pool ${claimed.pool_id} has no contract_id`);
      }
      await runContributeViaGateway(pool.contract_id, claimed.wallet_address);
      await supabase
        .from('payment_intents')
        .update({ minted_at: new Date().toISOString() })
        .eq('id', claimed.id);

      if (pool.telegram_chat_id) {
        const { data: userRow } = await supabase
          .from('users')
          .select('telegram_username')
          .eq('telegram_id', claimed.telegram_id)
          .maybeSingle();
        const onChain = await getOnChainPool(pool.contract_id);
        const label = userRow?.telegram_username ? `@${userRow.telegram_username}` : 'Seseorang';
        const target = (pool.contribution_amount ?? 0) * (pool.member_count ?? 0);

        await bot.api
          .sendMessage(
            pool.telegram_chat_id,
            `${label} udah setor buat siklus ke-${onChain.current_cycle}.\n` +
              `Terkumpul: Rp${onChain.cycle_pot.toLocaleString('id-ID')} / Rp${target.toLocaleString('id-ID')}`,
          )
          .catch((err) => console.error('failed to announce gateway contribution:', err));
      }
    } else {
      await mintIdrt(claimed.wallet_address, claimed.amount);
      await supabase
        .from('payment_intents')
        .update({ minted_at: new Date().toISOString() })
        .eq('id', claimed.id);

      await bot.api
        .sendMessage(
          claimed.telegram_id,
          `Top-up Rp${claimed.amount.toLocaleString('id-ID')} berhasil masuk ke dompetmu.`,
        )
        .catch((err) => console.error('failed to notify top-up success:', err));
    }
  } catch (err) {
    // The payment is real and already marked 'paid' — a failure here is an
    // operational problem to fix (retry, manual credit), not a reason to
    // tell Xendit to retry the webhook, which would just repeat the same
    // failure.
    console.error(`credit failed for intent ${claimed.id}:`, err);
  }

  return NextResponse.json({ ok: true });
}
