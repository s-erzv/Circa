'use client';

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { apiFetch } from '@/lib/api-client';
import { initTelegramView, isInsideTelegram } from '@/lib/telegram-client';

type Phase = 'entering' | 'creating' | 'waiting' | 'paid' | 'error';

const QUICK_AMOUNTS = [50_000, 100_000, 250_000, 500_000];

/**
 * Top up your own wallet via QRIS, scanned with whatever payment app you
 * already have (GoPay, bank m-banking, etc.) — this is the QRIS side of
 * the bridge described in mint.ts. Deliberately separate from any specific
 * pool's setoran: this credits your wallet balance in general, and
 * contribute() (a signed action you take yourself) is what later moves
 * that balance into a pool.
 */
export default function TopupPage() {
  const [phase, setPhase] = useState<Phase>('entering');
  const [amount, setAmount] = useState(100_000);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    initTelegramView();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function onCreateQr() {
    if (!isInsideTelegram()) {
      setError('Buka lewat Telegram ya.');
      setPhase('error');
      return;
    }
    setPhase('creating');
    setError(null);
    try {
      const { intentId, qrString } = await apiFetch<{ intentId: string; qrString: string }>(
        '/api/payments/qris/create',
        { method: 'POST', body: JSON.stringify({ amount }) },
      );

      const dataUrl = await QRCode.toDataURL(qrString, { width: 320, margin: 1 });
      setQrDataUrl(dataUrl);
      setPhase('waiting');

      pollRef.current = setInterval(async () => {
        try {
          const status = await apiFetch<{ status: string }>(`/api/payments/qris/${intentId}`);
          if (status.status === 'paid') {
            if (pollRef.current) clearInterval(pollRef.current);
            setPhase('paid');
          } else if (status.status === 'failed' || status.status === 'expired') {
            if (pollRef.current) clearInterval(pollRef.current);
            setError('Pembayaran gagal atau kedaluwarsa. Coba lagi ya.');
            setPhase('error');
          }
        } catch {
          // Transient poll failure — try again next tick.
        }
      }, 3000);
    } catch (e) {
      setError((e as Error).message);
      setPhase('error');
    }
  }

  return (
    <main className="flex min-h-dvh flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Isi Saldo</h1>

      {error && (
        <div className="rounded-xl border border-red-300/40 bg-red-500/10 p-4 text-sm">
          {error}
        </div>
      )}

      {phase === 'entering' && (
        <>
          <p className="text-sm opacity-70">
            Bayar pakai QRIS dari aplikasi apa aja yang udah kamu punya (GoPay,
            m-banking, dll) — saldonya masuk ke dompet Stellar kamu sendiri.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {QUICK_AMOUNTS.map((v) => (
              <button
                key={v}
                onClick={() => setAmount(v)}
                className={`rounded-xl border px-4 py-3 text-sm font-medium ${
                  amount === v
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-black/10 dark:border-white/15'
                }`}
              >
                Rp{v.toLocaleString('id-ID')}
              </button>
            ))}
          </div>
          <button
            onClick={onCreateQr}
            className="rounded-xl bg-foreground px-4 py-3 text-background font-medium"
          >
            Bikin QRIS — Rp{amount.toLocaleString('id-ID')}
          </button>
        </>
      )}

      {phase === 'creating' && <p className="text-sm opacity-60">Bikin kode QRIS…</p>}

      {phase === 'waiting' && qrDataUrl && (
        <section className="flex flex-col items-center gap-4">
          <img src={qrDataUrl} alt="Kode QRIS" className="rounded-xl" />
          <p className="text-sm opacity-70">
            Scan pakai aplikasi bayar kamu. Halaman ini otomatis update begitu
            pembayaran masuk.
          </p>
        </section>
      )}

      {phase === 'paid' && (
        <p className="text-lg">Top-up Rp{amount.toLocaleString('id-ID')} berhasil ✅</p>
      )}
    </main>
  );
}
