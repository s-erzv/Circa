'use client';

import { use, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { apiFetch } from '@/lib/api-client';
import { initTelegramView, isInsideTelegram } from '@/lib/telegram-client';

type PoolInfo = {
  id: string;
  name: string;
  status: string;
  contractId: string | null;
  contributionAmount: number;
};

type Phase = 'loading' | 'ready' | 'creating' | 'waiting' | 'paid' | 'error';

/**
 * A cycle's setoran, paid straight through QRIS — no wallet balance, no
 * passkey signature. Depositing money into a pool can't be used to steal
 * from anyone (only to harmlessly credit them), so unlike join()/exit() it
 * doesn't need the member's own live signature: the QRIS payment itself IS
 * the authorization, verified by the webhook before it ever touches the
 * chain (see contribute_via_gateway in cycle.rs).
 */
export default function PoolSetorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [phase, setPhase] = useState<Phase>('loading');
  const [pool, setPool] = useState<PoolInfo | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    initTelegramView();
    if (!isInsideTelegram()) {
      setError('Buka lewat Telegram ya.');
      setPhase('error');
      return;
    }
    load();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function load() {
    try {
      const p = await apiFetch<PoolInfo>(`/api/pools/${id}`);
      setPool(p);
      if (!p.contractId || p.status !== 'active') {
        setError('Arisan ini belum aktif atau udah selesai.');
        setPhase('error');
        return;
      }
      setPhase('ready');
    } catch (e) {
      setError((e as Error).message);
      setPhase('error');
    }
  }

  async function onCreateQr() {
    setPhase('creating');
    setError(null);
    try {
      const { intentId, qrString } = await apiFetch<{ intentId: string; qrString: string }>(
        '/api/payments/qris/create',
        { method: 'POST', body: JSON.stringify({ poolId: id }) },
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
      setPhase('ready');
    }
  }

  return (
    <main className="flex min-h-dvh flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Setor: {pool?.name ?? 'Arisan'}</h1>

      {error && (
        <div className="rounded-xl border border-red-300/40 bg-red-500/10 p-4 text-sm">
          {error}
        </div>
      )}

      {phase === 'loading' && <p className="text-sm opacity-60">Sebentar…</p>}

      {pool && (phase === 'ready' || phase === 'creating') && (
        <>
          <section className="rounded-xl border border-black/10 p-4 text-sm dark:border-white/15">
            <p className="text-lg font-medium">
              Rp{pool.contributionAmount.toLocaleString('id-ID')}
            </p>
            <p className="mt-1 opacity-70">
              Bayar pakai QRIS dari aplikasi apa aja yang udah kamu punya (GoPay,
              m-banking, dll) — begitu lunas, langsung tercatat sebagai setoran
              kamu, nggak perlu tanda tangan apa-apa lagi.
            </p>
            <p className="mt-2 text-xs opacity-60">Testnet: token uji, belum Rupiah beneran.</p>
          </section>
          <button
            onClick={onCreateQr}
            disabled={phase === 'creating'}
            className="rounded-xl bg-foreground px-4 py-3 text-background font-medium disabled:opacity-60"
          >
            {phase === 'creating' ? 'Bikin kode QRIS…' : 'Bikin QRIS & Setor'}
          </button>
        </>
      )}

      {phase === 'waiting' && qrDataUrl && (
        <section className="flex flex-col items-center gap-4">
          <img src={qrDataUrl} alt="Kode QRIS" className="rounded-xl" />
          <p className="text-sm opacity-70">
            Scan pakai aplikasi bayar kamu. Halaman ini otomatis update begitu
            pembayaran masuk.
          </p>
        </section>
      )}

      {phase === 'paid' && <p className="text-lg">Setoran berhasil.</p>}
    </main>
  );
}
