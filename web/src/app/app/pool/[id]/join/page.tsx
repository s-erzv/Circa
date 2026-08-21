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
  memberCount: number;
  contributionAmount: number;
};

type WalletStatus = { hasWallet: boolean; walletAddress: string | null; credentialId: string | null };

type Phase = 'loading' | 'ready' | 'needs-wallet' | 'creating-wallet' | 'joining' | 'done' | 'error';

/**
 * Where a member who tapped "Gabung" in the group turns that soft interest
 * into a real, signed on-chain join(). join() moves no tokens but still
 * needs the member's own signature — so this page exists as a distinct
 * step from the in-group tap, not folded into it.
 */
export default function PoolJoinPage({ params }: { params: Promise<{ id: string }> }) {
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
      if (!p.contractId || !['forming', 'active'].includes(p.status)) {
        setError('Arisan ini belum siap buat digabungin.');
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
        await handOffToSystemBrowser();
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
        try {
          await handOffToSystemBrowser();
        } catch (handoffError) {
          setError((handoffError as Error).message);
          setPhase('needs-wallet');
        }
        return;
      }
      setError((e as Error).message);
      setPhase('needs-wallet');
    }
  }

  async function onJoin() {
    setPhase('joining');
    setError(null);
    try {
      const status = await apiFetch<WalletStatus>('/api/wallet/status');
      if (!status.hasWallet || !status.walletAddress || !status.credentialId || !pool?.contractId) {
        throw new Error('Dompet belum siap.');
      }

      await relayAction(
        { kind: 'pool_join', poolId: pool.contractId, member: status.walletAddress },
        status.credentialId,
      );

      await apiFetch(`/api/pools/${id}/confirm-joined`, { method: 'POST' });
      setPhase('done');
    } catch (e) {
      setError((e as Error).message);
      setPhase('ready');
    }
  }

  return (
    <main className="flex min-h-dvh flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Gabung: {pool?.name ?? 'Arisan'}</h1>

      {error && (
        <div className="rounded-xl border border-red-300/40 bg-red-500/10 p-4 text-sm">
          {error}
        </div>
      )}

      {phase === 'loading' && <p className="text-sm opacity-60">Sebentar…</p>}

      {pool && phase !== 'loading' && phase !== 'error' && phase !== 'done' && (
        <section className="rounded-xl border border-black/10 p-4 text-sm dark:border-white/15">
          <p>Setoran Rp{pool.contributionAmount.toLocaleString('id-ID')} / siklus.</p>
          <p className="mt-2 opacity-70">
            Ini langkah terakhir buat resmi jadi anggota — belum ada uang yang gerak
            sekarang, tapi tetap butuh tanda tangan kamu biar keanggotaanmu beneran
            tercatat, bukan cuma niat.
          </p>
        </section>
      )}

      {phase === 'needs-wallet' && (
        <>
          <p className="text-sm opacity-70">
            Sekali doang: HP kamu bakal minta FaceID/sidik jari buat bikin kunci yang
            cuma ada di HP kamu.
          </p>
          <button
            onClick={onCreateWallet}
            className="rounded-xl bg-foreground px-4 py-3 text-background font-medium"
          >
            Bikin dompet & lanjut
          </button>
        </>
      )}

      {phase === 'creating-wallet' && (
        <p className="text-sm opacity-60">Lagi bikin dompet kamu…</p>
      )}

      {phase === 'ready' && (
        <button
          onClick={onJoin}
          className="rounded-xl bg-foreground px-4 py-3 text-background font-medium"
        >
          Gabung Sekarang
        </button>
      )}

      {phase === 'joining' && (
        <p className="text-sm opacity-60">Lagi gabungin kamu ke arisan… jangan tutup dulu ya.</p>
      )}

      {phase === 'done' && <p className="text-lg">Kamu resmi gabung ✅ Balik ke grup ya.</p>}
    </main>
  );
}
