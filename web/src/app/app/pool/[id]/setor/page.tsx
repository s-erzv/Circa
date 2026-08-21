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
  contributionAmount: number;
};

type WalletStatus = { hasWallet: boolean; walletAddress: string | null; credentialId: string | null };

type Phase = 'loading' | 'ready' | 'needs-wallet' | 'creating-wallet' | 'paying' | 'done' | 'error';

/**
 * A cycle's setoran. Same wallet-then-sign shape as join — contribute()
 * needs the member's own passkey too — but this one repeats every cycle,
 * so returning members skip straight to 'ready'.
 */
export default function PoolSetorPage({ params }: { params: Promise<{ id: string }> }) {
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
        setError('Arisan ini belum aktif atau udah selesai.');
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
        await handOffToSystemBrowser(`setor_${id}`);
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
          await handOffToSystemBrowser(`setor_${id}`);
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

  async function onPay() {
    setPhase('paying');
    setError(null);
    try {
      const status = await apiFetch<WalletStatus>('/api/wallet/status');
      if (!status.hasWallet || !status.walletAddress || !status.credentialId || !pool?.contractId) {
        throw new Error('Dompet belum siap.');
      }

      await relayAction(
        { kind: 'pool_contribute', poolId: pool.contractId, member: status.walletAddress },
        status.credentialId,
      );

      await apiFetch(`/api/pools/${id}/confirm-contributed`, { method: 'POST' }).catch((err) =>
        console.error('confirm-contributed failed:', err),
      );
      setPhase('done');
    } catch (e) {
      // The wallet already exists here, so this is the *signing* ceremony
      // (`publickey-credentials-get`) hitting the same iframe restriction
      // `onCreateWallet` guards against for the *creation* one — same fix.
      if (isWebAuthnBlockedError(e)) {
        try {
          await handOffToSystemBrowser(`setor_${id}`);
        } catch (handoffError) {
          setError((handoffError as Error).message);
        }
        setPhase('ready');
        return;
      }
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

      {pool && phase !== 'loading' && phase !== 'error' && phase !== 'done' && (
        <section className="rounded-xl border border-black/10 p-4 text-sm dark:border-white/15">
          <p className="text-lg font-medium">
            Rp{pool.contributionAmount.toLocaleString('id-ID')}
          </p>
          <p className="mt-1 text-xs opacity-60">⚠️ Testnet: token uji, belum Rupiah beneran.</p>
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
          onClick={onPay}
          className="rounded-xl bg-foreground px-4 py-3 text-background font-medium"
        >
          Setor Sekarang
        </button>
      )}

      {phase === 'paying' && (
        <p className="text-sm opacity-60">Lagi proses setoran… jangan tutup dulu ya.</p>
      )}

      {phase === 'done' && <p className="text-lg">Setoran berhasil ✅</p>}
    </main>
  );
}
