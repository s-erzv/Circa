import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { verifyWebhookToken } from '@/lib/payments/xendit';
import { mintIdrt } from '@/lib/payments/mint';
import { runContributeViaGateway } from '@/lib/soroban/cycle';
import { getPool as getOnChainPool } from '@/lib/soroban/read';
import { getPool as getPoolRow } from '@/lib/pools';
import { bot, deepLinkKeyboard } from '@/lib/bot';

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

  const body = await request.json();

  // Two shapes land on this one endpoint: the legacy QR Codes callback
  // (`event: 'qr.payment'`, kept for the simulate-topup.ts testing script)
  // and the Invoice callback the live product now uses (no `event` field at
  // all — just the invoice object itself, `status` being how a real
  // payment is told apart from PENDING/EXPIRED). Anything else — Xendit
  // adding event types this endpoint has no opinion about — is ignored
  // rather than erroring.
  let externalId: string | undefined;
  let paidAmount: number | undefined;

  if (body.event === 'qr.payment') {
    externalId = body.external_id ?? body.qr_code?.external_id;
    paidAmount = body.amount;
  } else if (body.status === 'PAID') {
    externalId = body.external_id;
    paidAmount = body.paid_amount ?? body.amount;
  } else {
    return NextResponse.json({ ok: true });
  }

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
  if (paidAmount !== claimed.amount) {
    console.error(
      `Xendit webhook amount mismatch for intent ${claimed.id}: expected ${claimed.amount}, got ${paidAmount}`,
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

        // current_cycle di kontrak adalah 0-indexed internal counter;
        // tampilkan sebagai 1-indexed supaya manusia nggak bingung.
        const cycleDisplay = onChain.current_cycle + 1;

        await bot.api
          .sendMessage(
            pool.telegram_chat_id,
            `${label} udah setor buat siklus ke-${cycleDisplay}.\n` +
              `Terkumpul: Rp${onChain.cycle_pot.toLocaleString('id-ID')} / Rp${target.toLocaleString('id-ID')}`,
          )
          .catch((err) => console.error('failed to announce gateway contribution:', err));

        // Semua anggota sudah setor siklus ini — umumkan ke grup siapa
        // yang dapat giliran, kapan bisa cair, dan tanya penerimanya
        // apakah mau cair sekarang (trigger distribute sebelum deadline)
        // atau tunggu sampai deadline otomatis.
        const potFilled = Number(onChain.cycle_pot) >= target && target > 0;
        if (potFilled) {
          const recipientWallet = onChain.queue[0] ?? null;
          let recipientLabel = 'Penerima giliran';
          let recipientTelegramId: string | null = null;
          if (recipientWallet) {
            const { data: recipientRow } = await supabase
              .from('users')
              .select('telegram_username, telegram_id')
              .eq('wallet_address', recipientWallet)
              .maybeSingle();
            if (recipientRow?.telegram_username) {
              recipientLabel = `@${recipientRow.telegram_username}`;
            }
            recipientTelegramId = recipientRow?.telegram_id ?? null;
          }

          // cycle_deadline = batas setor, tapi distribute() bisa dipanggil
          // lebih awal kalau semua udah setor. Formatnya jadi info "bisa
          // cair sekarang" bukan "cair pas deadline".
          const fmt = new Intl.DateTimeFormat('id-ID', {
            day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
            timeZone: 'Asia/Jakarta',
          });
          const deadlineDate = fmt.format(new Date(Number(onChain.cycle_deadline) * 1000));

          const nextCycleDays = pool.cycle_length_secs
            ? Math.round(pool.cycle_length_secs / 86400)
            : null;
          const nextCycleInfo = nextCycleDays
            ? `Siklus ke-${cycleDisplay + 1} mulai dalam ${nextCycleDays} hari.`
            : '';

          // Kirim pengumuman di grup
          await bot.api
            .sendMessage(
              pool.telegram_chat_id,
              `✅ Semua udah setor! Pool siklus ke-${cycleDisplay} penuh — Rp${target.toLocaleString('id-ID')} siap dicairkan.\n\n` +
                `💸 Giliran siklus ke-${cycleDisplay}: ${recipientLabel}\n\n` +
                `Dana bisa dicairkan sekarang atau paling lambat otomatis cair sebelum ${deadlineDate} WIB.` +
                (nextCycleInfo ? `\n\n🗓 ${nextCycleInfo} Yuk siap-siap setor lagi!` : ''),
            )
            .catch((err) => console.error('failed to announce pool full:', err));

          // DM ke penerima: tanya mau cair sekarang atau tunggu
          if (recipientTelegramId) {
            await bot.api
              .sendMessage(
                recipientTelegramId,
                `🎉 Giliran kamu dapat di arisan "${pool.name}" siklus ke-${cycleDisplay}!\n\n` +
                  `Pool udah terkumpul penuh Rp${target.toLocaleString('id-ID')}.\n` +
                  `Mau cair sekarang atau tunggu sampai deadline (${deadlineDate} WIB)?`,
                {
                  reply_markup: deepLinkKeyboard(
                    'Cair Sekarang 💸',
                    `cair_${claimed.pool_id}`,
                  ),
                },
              )
              .catch((err) => console.error('failed to DM recipient:', err));
          }
        }
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
