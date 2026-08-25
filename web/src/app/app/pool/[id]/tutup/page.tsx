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
  isOrganizer: boolean;
};

type WalletStatus = { hasWallet: boolean; walletAddress: string | null; credentialId: string | null };
type Phase = 'loading' | 'ready' | 'needs-wallet' | 'creating-wallet' | 'closing' | 'done' | 'error';

/**
 * Organizer page to force close the pool.
 */
export default function TutupPage({ params }: { params: Promise<{ id: string }> }) {
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
        setError('Arisan ini belum aktif atau sudah ditutup.');
        setPhase('error');
        return;
      }
      if (!p.isOrganizer) {
        setError('Cuma pembuat arisan yang bisa menutup arisan.');
        setPhase('error');
        return;
      }

      const status = await apiFetch<WalletStatus>('/api/wallet/status');
      setPhase(status.hasWallet ? 'ready' : 'needs-wallet');
    } catch (e) {
      setError((e as Error).message);
      setPhase('error');
    }
  }

  async function onCreateWallet() {
    if (!isPasskeySupported()) {
      try {
        await handOffToSystemBrowser(`tutup_${id}`);
      } catch (e) {
        setError((e as Error).message);
      }
      return;
    }
    setPhase('creating-wallet');
    setError(null);
    try {
      await createPasskeyWallet();
      setPhase('ready');
    } catch (e) {
      if (isWebAuthnBlockedError(e)) {
        try { await handOffToSystemBrowser(`tutup_${id}`); } catch (he) { setError((he as Error).message); setPhase('needs-wallet'); }
        return;
      }
      setError((e as Error).message);
      setPhase('needs-wallet');
    }
  }

  async function onTutup() {
    setPhase('closing');
    setError(null);
    try {
      const status = await apiFetch<WalletStatus>('/api/wallet/status');
      if (!status.hasWallet || !status.walletAddress || !status.credentialId || !pool?.contractId) {
        throw new Error('Dompet belum siap.');
      }

      await relayAction(
        { kind: 'pool_force_close', poolId: pool.contractId, organizer: status.walletAddress },
        status.credentialId,
      );

      setPhase('done');
    } catch (e) {
      if (isWebAuthnBlockedError(e)) {
        try { await handOffToSystemBrowser(`tutup_${id}`); } catch (he) { setError((he as Error).message); }
        setPhase('ready');
        return;
      }
      setError((e as Error).message);
      setPhase('ready');
    }
  }

  return (
    <main className="flex min-h-dvh flex-col gap-6 p-6">
      <div className="text-4xl">⚠️</div>
      <h1 className="text-2xl font-semibold">Tutup Arisan</h1>

      {error && (
        <div className="rounded-xl border border-red-300/40 bg-red-500/10 p-4 text-sm">
          {error}
        </div>
      )}

      {phase === 'loading' && <p className="text-sm opacity-60">Sebentar…</p>}

      {pool && phase !== 'loading' && phase !== 'error' && phase !== 'done' && (
        <section className="rounded-xl border border-black/10 p-4 text-sm dark:border-white/15">
          <p className="font-bold">Kamu yakin mau tutup "{pool.name}"?</p>
          <p className="mt-2 opacity-70">
            Arisan akan langsung dihentikan. Semua anggota yang belum mendapat giliran
            akan dikembalikan sisa dananya dari kas yang tersedia. Sisa dana tidak
            akan dikembalikan penuh jika ada denda atau tunggakan dari anggota lain.
          </p>
        </section>
      )}

      {phase === 'needs-wallet' && (
        <>
          <p className="text-sm opacity-70">
            Butuh tanda tangan pakai FaceID/sidik jari untuk mengonfirmasi.
          </p>
          <button
            onClick={onCreateWallet}
            className="rounded-xl bg-foreground px-4 py-3 text-background font-medium"
          >
            Siapkan Tanda Tangan
          </button>
        </>
      )}

      {phase === 'creating-wallet' && (
        <p className="text-sm opacity-60">Lagi menyiapkan…</p>
      )}

      {phase === 'ready' && (
        <button
          onClick={onTutup}
          className="rounded-xl bg-red-500 px-4 py-3 text-white font-medium"
        >
          Konfirmasi Tutup Arisan
        </button>
      )}

      {phase === 'closing' && (
        <p className="text-sm opacity-60">Lagi diproses di blockchain… jangan tutup dulu ya.</p>
      )}

      {phase === 'done' && (
        <div className="flex flex-col gap-3">
          <p className="text-lg font-semibold">Arisan berhasil ditutup!</p>
          <p className="text-sm opacity-70">
            Dana sisa udah mulai dibagikan ke anggota yang belum dapet. Balik ke grup ya.
          </p>
        </div>
      )}
    </main>
  );
}
