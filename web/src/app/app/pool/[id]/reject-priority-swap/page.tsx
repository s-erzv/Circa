'use client';

import { use, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import {
  createPasskeyWallet,
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
};

type PendingSwap = {
  requester: string;
  requesterName: string;
  fee: string;
};

type WalletStatus = { hasWallet: boolean; walletAddress: string | null; credentialId: string | null };
type Phase = 'loading' | 'ready' | 'needs-wallet' | 'creating-wallet' | 'rejecting' | 'done' | 'error';

export default function RejectPrioritySwapPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [phase, setPhase] = useState<Phase>('loading');
  const [pool, setPool] = useState<PoolInfo | null>(null);
  const [pending, setPending] = useState<PendingSwap | null>(null);
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

      const pendingRes = await apiFetch<{ pending: PendingSwap | null }>(`/api/pools/${id}/pending-pswap`);
      if (!pendingRes.pending) {
        setError('Tidak ada permintaan tukar giliran yang menunggu persetujuanmu.');
        setPhase('error');
        return;
      }
      setPending(pendingRes.pending);

      const status = await apiFetch<WalletStatus>('/api/wallet/status');
      setPhase(status.hasWallet ? 'ready' : 'needs-wallet');
    } catch (e) {
      setError((e as Error).message);
      setPhase('error');
    }
  }

  async function onCreateWallet() {
    if (!isPasskeySupported()) {
      try { await handOffToSystemBrowser(`rpswap_${id}`); } catch (e) { setError((e as Error).message); }
      return;
    }
    setPhase('creating-wallet');
    setError(null);
    try {
      await createPasskeyWallet();
      setPhase('ready');
    } catch (e) {
      if (isWebAuthnBlockedError(e)) {
        try { await handOffToSystemBrowser(`rpswap_${id}`); } catch (he) { setError((he as Error).message); setPhase('needs-wallet'); }
        return;
      }
      setError((e as Error).message);
      setPhase('needs-wallet');
    }
  }

  async function onReject() {
    setPhase('rejecting');
    setError(null);
    try {
      const status = await apiFetch<WalletStatus>('/api/wallet/status');
      if (!status.hasWallet || !status.walletAddress || !status.credentialId || !pool?.contractId) {
        throw new Error('Data belum siap.');
      }

      await relayAction(
        { 
          kind: 'pool_reject_priority_swap', 
          poolId: pool.contractId, 
          target: status.walletAddress
        },
        status.credentialId,
      );

      setPhase('done');
    } catch (e) {
      if (isWebAuthnBlockedError(e)) {
        try { await handOffToSystemBrowser(`rpswap_${id}`); } catch (he) { setError((he as Error).message); }
        setPhase('ready');
        return;
      }
      setError((e as Error).message);
      setPhase('ready');
    }
  }

  return (
    <main className="flex min-h-dvh flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Tolak Tukar Giliran</h1>

      {error && (
        <div className="rounded-xl border border-red-300/40 bg-red-500/10 p-4 text-sm">
          {error}
        </div>
      )}

      {phase === 'loading' && <p className="text-sm opacity-60">Sebentar…</p>}

      {pool && pending && phase !== 'loading' && phase !== 'error' && phase !== 'done' && (
        <section className="rounded-xl border border-black/10 p-4 text-sm dark:border-white/15 flex flex-col gap-3">
          <p>
            Kamu akan menolak permintaan tukar giliran dari <strong>{pending.requesterName}</strong>.
          </p>
          <p className="opacity-70">
            Giliranmu tidak akan berubah. {pending.requesterName} bisa mencoba mengajukan penawaran lagi nanti dengan fee yang lebih tinggi jika dia masih mau.
          </p>
        </section>
      )}

      {phase === 'needs-wallet' && (
        <>
          <p className="text-sm opacity-70">
            Butuh tanda tangan pakai FaceID/sidik jari untuk menolak.
          </p>
          <button onClick={onCreateWallet} className="rounded-xl bg-foreground px-4 py-3 text-background font-medium">
            Siapkan Tanda Tangan
          </button>
        </>
      )}

      {phase === 'creating-wallet' && (
        <p className="text-sm opacity-60">Lagi menyiapkan…</p>
      )}

      {phase === 'ready' && (
        <button onClick={onReject} className="rounded-xl bg-red-600 px-4 py-3 text-white font-medium">
          Tolak Permintaan
        </button>
      )}

      {phase === 'rejecting' && (
        <p className="text-sm opacity-60">Lagi diproses di blockchain… jangan tutup dulu ya.</p>
      )}

      {phase === 'done' && (
        <div className="flex flex-col gap-3">
          <p className="text-lg font-semibold">Permintaan berhasil ditolak.</p>
          <p className="text-sm opacity-70">
            Urutan kamu tetap sama. Balik ke grup ya!
          </p>
        </div>
      )}
    </main>
  );
}
