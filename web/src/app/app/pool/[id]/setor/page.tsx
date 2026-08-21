'use client';

import { use, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { initTelegramView, isInsideTelegram, openInSystemBrowser } from '@/lib/telegram-client';

type PoolInfo = {
  id: string;
  name: string;
  status: string;
  contractId: string | null;
  contributionAmount: number;
};

type Phase = 'loading' | 'ready' | 'creating' | 'waiting' | 'paid' | 'error';

/**
 * A cycle's setoran, paid straight through Xendit's hosted checkout page —
 * no wallet balance, no passkey signature. Depositing money into a pool
 * can't be used to steal from anyone (only to harmlessly credit them), so
 * unlike join()/exit() it doesn't need the member's own live signature: the
 * payment itself IS the authorization, verified by the webhook before it
 * ever touches the chain (see contribute_via_gateway in cycle.rs).
 *
 * Redirects to Xendit's own page rather than rendering a QR ourselves — a
 * raw code assembled inside our own Mini App carries none of the trust
 * signals a real payment page does.
 */
export default function PoolSetorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [phase, setPhase] = useState<Phase>('loading');
  const [pool, setPool] = useState<PoolInfo | null>(null);
  const [invoiceUrl, setInvoiceUrl] = useState<string | null>(null);
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

  async function onPay() {
    setPhase('creating');
    setError(null);
    try {
      const { intentId, invoiceUrl: url } = await apiFetch<{
        intentId: string;
        invoiceUrl: string;
      }>('/api/payments/qris/create', { method: 'POST', body: JSON.stringify({ poolId: id }) });

      setInvoiceUrl(url);
      openInSystemBrowser(url);
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
            onClick={onPay}
            disabled={phase === 'creating'}
            className="rounded-xl bg-foreground px-4 py-3 text-background font-medium disabled:opacity-60"
          >
            {phase === 'creating' ? 'Bikin halaman pembayaran…' : 'Bayar & Setor'}
          </button>
        </>
      )}

      {phase === 'waiting' && (
        <section className="flex flex-col gap-4">
          <p className="text-sm opacity-70">
            Selesain pembayaran di tab yang baru kebuka. Halaman ini otomatis
            update begitu lunas.
          </p>
          {invoiceUrl && (
            <button
              onClick={() => openInSystemBrowser(invoiceUrl)}
              className="rounded-xl border border-black/10 px-4 py-3 text-sm font-medium dark:border-white/15"
            >
              Buka halaman pembayaran lagi
            </button>
          )}
        </section>
      )}

      {phase === 'paid' && <p className="text-lg">Setoran berhasil.</p>}
    </main>
  );
}
