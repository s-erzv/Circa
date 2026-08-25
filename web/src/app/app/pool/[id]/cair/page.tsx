'use client';

import { use, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import {
  handOffToSystemBrowser,
  isPasskeySupported,
  isWebAuthnBlockedError,
} from '@/lib/passkey';
import { relayAction } from '@/lib/soroban/relay-client';
import { initTelegramView, isInsideTelegram } from '@/lib/telegram-client';

type PoolInfo = {
  id: string;
  name: string;
  status: string;
  contractId: string | null;
  contributionAmount: number;
  currentCycle: number;
  nextDeadline: number | null;
};

type WalletStatus = { hasWallet: boolean; walletAddress: string | null; credentialId: string | null };
type Phase = 'loading' | 'ready' | 'distributing' | 'done' | 'error';

/**
 * Triggered from the bot DM when it's the member's turn to receive the pot.
 * Calls distribute() on-chain — permissionless but deadline-gated, so this
 * works even if called by someone other than the recipient.
 */
export default function CairPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [phase, setPhase] = useState<Phase>('loading');
  const [pool, setPool] = useState<PoolInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    initTelegramView();
    if (!isInsideTelegram()) {
      setError('Buka lewat Telegram ya.');
      setPhase('error');
      return;
    }
    load();
  }, []);

  async function load() {
    try {
      const p = await apiFetch<PoolInfo>(`/api/pools/${id}`);
      setPool(p);
      if (!p.contractId || p.status !== 'active') {
        setError('Arisan ini belum aktif atau sudah selesai.');
        setPhase('error');
        return;
      }
      setPhase('ready');
    } catch (e) {
      setError((e as Error).message);
      setPhase('error');
    }
  }

  async function onCair() {
    setPhase('distributing');
    setError(null);
    try {
      // distribute() is permissionless — we can call it server-side without
      // the member's passkey. We route through a dedicated API endpoint that
      // uses the sponsor key to pay gas, same as runDistribute() in the cron.
      await apiFetch(`/api/pools/${id}/distribute`, { method: 'POST' });
      setPhase('done');
    } catch (e) {
      if (isWebAuthnBlockedError(e)) {
        if (isPasskeySupported()) {
          try { await handOffToSystemBrowser(`cair_${id}`); } catch { /* ignore */ }
        }
        setPhase('ready');
        return;
      }
      setError((e as Error).message);
      setPhase('ready');
    }
  }

  const deadline = pool?.nextDeadline
    ? new Intl.DateTimeFormat('id-ID', {
        day: 'numeric', month: 'long', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta',
      }).format(new Date(pool.nextDeadline * 1000))
    : null;

  return (
    <main className="flex min-h-dvh flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Cairkan Dana</h1>

      {error && (
        <div className="rounded-xl border border-red-300/40 bg-red-500/10 p-4 text-sm">
          {error}
        </div>
      )}

      {phase === 'loading' && <p className="text-sm opacity-60">Sebentar…</p>}

      {pool && phase === 'ready' && (
        <section className="flex flex-col gap-4">
          <div className="rounded-xl border border-black/10 p-5 dark:border-white/15">
            <p className="text-3xl font-bold">
              Rp{pool.contributionAmount.toLocaleString('id-ID')}
            </p>
            <p className="mt-1 text-sm opacity-60">
              Dana siklus ke-{pool.currentCycle} siap dicairkan ke dompetmu.
            </p>
            {deadline && (
              <p className="mt-3 text-xs opacity-50">
                Batas otomatis cair: {deadline}
              </p>
            )}
          </div>

          <p className="text-sm opacity-70">
            Tap tombol di bawah buat cairkan sekarang. Dananya langsung
            masuk ke dompet blockchain kamu — nggak ada perantara.
          </p>

          <button
            id="btn-cair"
            onClick={onCair}
            className="rounded-xl bg-foreground px-4 py-3 text-background font-medium"
          >
            Cair Sekarang
          </button>
        </section>
      )}

      {phase === 'distributing' && (
        <p className="text-sm opacity-60">Lagi proses pencairan… jangan tutup dulu ya.</p>
      )}

      {phase === 'done' && (
        <div className="flex flex-col gap-3">
          <p className="text-lg font-semibold">Dana berhasil cair!</p>
          <p className="text-sm opacity-70">
            Cek dompet kamu — dananya udah masuk. Siklus berikutnya akan
            dikocok otomatis. Balik ke grup ya!
          </p>
        </div>
      )}
    </main>
  );
}
