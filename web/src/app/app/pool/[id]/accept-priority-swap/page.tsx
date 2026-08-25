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
type Phase = 'loading' | 'ready' | 'needs-wallet' | 'creating-wallet' | 'accepting' | 'done' | 'error';

export default function AcceptPrioritySwapPage({ params }: { params: Promise<{ id: string }> }) {
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
      try { await handOffToSystemBrowser(`apswap_${id}`); } catch (e) { setError((e as Error).message); }
      return;
    }
    setPhase('creating-wallet');
    setError(null);
    try {
      await createPasskeyWallet();
      setPhase('ready');
    } catch (e) {
      if (isWebAuthnBlockedError(e)) {
        try { await handOffToSystemBrowser(`apswap_${id}`); } catch (he) { setError((he as Error).message); setPhase('needs-wallet'); }
        return;
      }
      setError((e as Error).message);
      setPhase('needs-wallet');
    }
  }

  async function onAccept() {
    setPhase('accepting');
    setError(null);
    try {
      const status = await apiFetch<WalletStatus>('/api/wallet/status');
      if (!status.hasWallet || !status.walletAddress || !status.credentialId || !pool?.contractId || !pending) {
        throw new Error('Data belum siap.');
      }

      await relayAction(
        { 
          kind: 'pool_accept_priority_swap', 
          poolId: pool.contractId, 
          target: status.walletAddress,
          requester: pending.requester
        },
        status.credentialId,
      );

      setPhase('done');
    } catch (e) {
      if (isWebAuthnBlockedError(e)) {
        try { await handOffToSystemBrowser(`apswap_${id}`); } catch (he) { setError((he as Error).message); }
        setPhase('ready');
        return;
      }
      setError((e as Error).message);
      setPhase('ready');
    }
  }

  return (
    <main className="flex min-h-dvh flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Setujui Tukar Giliran</h1>

      {error && (
        <div className="rounded-xl border border-red-300/40 bg-red-500/10 p-4 text-sm">
          {error}
        </div>
      )}

      {phase === 'loading' && <p className="text-sm opacity-60">Sebentar…</p>}

      {pool && pending && phase !== 'loading' && phase !== 'error' && phase !== 'done' && (
        <section className="rounded-xl border border-black/10 p-4 text-sm dark:border-white/15 flex flex-col gap-3">
          <p>
            <strong>{pending.requesterName}</strong> ingin bertukar posisi denganmu.
          </p>
          <p className="opacity-70">
            Sebagai kompensasi, dia akan membayar <strong>Rp{Number(pending.fee).toLocaleString('id-ID')}</strong> yang akan masuk ke kas cadangan dan dibagikan ke semua anggota di akhir periode.
          </p>
          <p className="opacity-70 mt-2 font-medium">
            Giliranmu akan mundur menempati urutan {pending.requesterName} sebelumnya.
          </p>
        </section>
      )}

      {phase === 'needs-wallet' && (
        <>
          <p className="text-sm opacity-70">
            Butuh tanda tangan pakai FaceID/sidik jari untuk menyetujui.
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
        <button onClick={onAccept} className="rounded-xl bg-green-600 px-4 py-3 text-white font-medium">
          Setujui & Tukar Sekarang
        </button>
      )}

      {phase === 'accepting' && (
        <p className="text-sm opacity-60">Lagi diproses di blockchain… jangan tutup dulu ya.</p>
      )}

      {phase === 'done' && (
        <div className="flex flex-col gap-3">
          <p className="text-lg font-semibold">Berhasil bertukar giliran!</p>
          <p className="text-sm opacity-70">
            Urutan kalian sudah ditukar di kontrak dan fee kompensasi sudah ditarik. Balik ke grup ya!
          </p>
        </div>
      )}
    </main>
  );
}
