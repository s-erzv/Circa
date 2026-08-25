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

type Bid = {
  requester: string;
  requesterName: string;
  fee: string;
  isHighest: boolean;
};

type WalletStatus = { hasWallet: boolean; walletAddress: string | null; credentialId: string | null };
type Phase = 'loading' | 'ready' | 'needs-wallet' | 'creating-wallet' | 'accepting' | 'done' | 'error';

/**
 * This is an auction, not a single offer — any number of members can bid
 * for the caller's front-of-queue slot at once. Only the currently-highest
 * bid can ever be accepted (the contract itself enforces this), so the UI's
 * job is just to make that one obvious rather than let the caller imagine
 * they can pick a favorite among lower ones.
 */
export default function AcceptPrioritySwapPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [phase, setPhase] = useState<Phase>('loading');
  const [pool, setPool] = useState<PoolInfo | null>(null);
  const [bids, setBids] = useState<Bid[]>([]);
  const [error, setError] = useState<string | null>(null);

  const highest = bids.find((b) => b.isHighest) ?? null;

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

      const res = await apiFetch<{ bids: Bid[] }>(`/api/pools/${id}/pending-pswap`);
      if (res.bids.length === 0) {
        setError('Tidak ada yang menawar giliranmu saat ini.');
        setPhase('error');
        return;
      }
      setBids(res.bids);

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
      if (!status.hasWallet || !status.walletAddress || !status.credentialId || !pool?.contractId || !highest) {
        throw new Error('Data belum siap.');
      }

      await relayAction(
        {
          kind: 'pool_accept_priority_swap',
          poolId: pool.contractId,
          target: status.walletAddress,
          requester: highest.requester,
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
      <h1 className="text-2xl font-semibold">Tawaran Tukar Giliran</h1>

      {error && (
        <div className="rounded-xl border border-red-300/40 bg-red-500/10 p-4 text-sm">
          {error}
        </div>
      )}

      {phase === 'loading' && <p className="text-sm opacity-60">Sebentar…</p>}

      {pool && bids.length > 0 && phase !== 'loading' && phase !== 'error' && phase !== 'done' && (
        <section className="flex flex-col gap-3">
          <p className="text-sm opacity-70">
            {bids.length > 1
              ? `${bids.length} orang nawar buat gantiin posisimu. Tawaran tertinggi yang bisa kamu terima:`
              : 'Ada yang nawar buat gantiin posisimu:'}
          </p>
          {highest && (
            <div className="rounded-xl border-2 border-foreground p-4 text-sm">
              <p>
                <strong>{highest.requesterName}</strong> — Rp{Number(highest.fee).toLocaleString('id-ID')}
              </p>
              <p className="mt-1 opacity-70">
                Masuk ke kas cadangan, dibagikan ke semua anggota di akhir periode.
                Giliranmu mundur menempati urutan {highest.requesterName} sebelumnya.
              </p>
            </div>
          )}
          {bids.length > 1 && (
            <div className="rounded-xl border border-black/10 p-3 text-xs opacity-60 dark:border-white/15">
              {bids.length - 1} tawaran lain di bawah ini nggak bisa diterima kecuali tawaran di atas
              ditolak dulu — cuma yang tertinggi yang berlaku.
            </div>
          )}
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
          Terima Tawaran Tertinggi & Tukar
        </button>
      )}

      {phase === 'accepting' && (
        <p className="text-sm opacity-60">Lagi diproses di blockchain… jangan tutup dulu ya.</p>
      )}

      {phase === 'done' && (
        <div className="flex flex-col gap-3">
          <p className="text-lg font-semibold">Berhasil bertukar giliran!</p>
          <p className="text-sm opacity-70">
            Urutan kalian sudah ditukar di kontrak, dan setiap tawaran lain sudah otomatis
            dikembalikan ke yang nawar. Balik ke grup ya!
          </p>
        </div>
      )}
    </main>
  );
}
