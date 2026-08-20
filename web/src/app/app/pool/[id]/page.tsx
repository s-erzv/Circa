'use client';

import { use, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { createPasskeyWallet, handOffToSystemBrowser, isPasskeySupported } from '@/lib/passkey';
import { initTelegramView, isInsideTelegram } from '@/lib/telegram-client';

type PoolInfo = {
  id: string;
  name: string;
  status: 'draft' | 'deploying' | 'forming' | 'active' | 'closed';
  contractId: string | null;
  memberCount: number;
  contributionAmount: number;
  cycleLengthSecs: number;
  isOrganizer: boolean;
};

type WalletStatus = { hasWallet: boolean; walletAddress: string | null; credentialId: string | null };

type Phase = 'loading' | 'ready' | 'needs-wallet' | 'creating-wallet' | 'confirming' | 'done' | 'error';

/**
 * Where the organizer reviews and confirms a draft arisan. This is the
 * real confirmation gate the plan requires before anything touches the
 * chain — a Telegram button tap isn't a strong enough commitment for
 * deploying a contract, but a passkey signature is.
 */
export default function PoolConfirmPage({ params }: { params: Promise<{ id: string }> }) {
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
      if (p.status !== 'draft' && p.status !== 'deploying') {
        setPhase('done');
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
      setError((e as Error).message);
      setPhase('needs-wallet');
    }
  }

  async function onConfirm() {
    setPhase('confirming');
    setError(null);
    try {
      const status = await apiFetch<WalletStatus>('/api/wallet/status');
      if (!status.hasWallet || !status.credentialId) {
        throw new Error('Dompet belum siap.');
      }

      const prepared = await apiFetch<{
        relayId: string;
        authEntryXdr: string;
        validUntilLedgerSeq: number;
        networkPassphrase: string;
      }>(`/api/pools/${id}/deploy`, { method: 'POST' });

      // Reuse relay-client's sign step directly rather than its whole
      // prepare()-through-relayAction() sequence, since prepare already
      // happened against a pool-specific endpoint, not the generic one.
      const { xdr } = await import('@stellar/stellar-sdk');
      const { signSorobanAuthEntry } = await import('@/lib/soroban/passkey-auth');
      const unsignedEntry = xdr.SorobanAuthorizationEntry.fromXDR(prepared.authEntryXdr, 'base64');
      const signedEntry = await signSorobanAuthEntry(unsignedEntry, {
        validUntilLedgerSeq: prepared.validUntilLedgerSeq,
        networkPassphrase: prepared.networkPassphrase,
        credentialId: status.credentialId,
      });

      await apiFetch('/api/tx/submit', {
        method: 'POST',
        body: JSON.stringify({
          relayId: prepared.relayId,
          signedAuthEntryXdr: signedEntry.toXDR('base64'),
        }),
      });

      await apiFetch(`/api/pools/${id}/confirm-created`, { method: 'POST' });
      setPhase('done');
      load();
    } catch (e) {
      setError((e as Error).message);
      setPhase('ready');
    }
  }

  return (
    <main className="flex min-h-dvh flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">{pool?.name ?? 'Arisan'}</h1>

      {error && (
        <div className="rounded-xl border border-red-300/40 bg-red-500/10 p-4 text-sm">
          {error}
        </div>
      )}

      {phase === 'loading' && <p className="text-sm opacity-60">Sebentar…</p>}

      {pool && (phase === 'ready' || phase === 'needs-wallet' || phase === 'creating-wallet' || phase === 'confirming') && (
        <section className="rounded-xl border border-black/10 p-4 text-sm dark:border-white/15">
          <p>• {pool.memberCount} anggota</p>
          <p>• Setoran Rp{pool.contributionAmount.toLocaleString('id-ID')} / siklus</p>
          <p className="mt-2 text-xs opacity-60">⚠️ Testnet: token uji, belum Rupiah beneran.</p>
        </section>
      )}

      {!pool?.isOrganizer && phase !== 'loading' && phase !== 'error' && (
        <p className="text-sm opacity-70">
          Cuma yang bikin draf ini yang bisa konfirmasi. Kamu bisa lihat-lihat aja di sini.
        </p>
      )}

      {pool?.isOrganizer && phase === 'needs-wallet' && (
        <>
          <p className="text-sm opacity-70">
            Sekali doang: HP kamu bakal minta FaceID/sidik jari buat bikin kunci yang cuma
            ada di HP kamu, dipakai buat tanda tangan bikin kontrak arisan ini.
          </p>
          <button
            onClick={onCreateWallet}
            className="rounded-xl bg-foreground px-4 py-3 text-background font-medium"
          >
            Bikin dompet & lanjut
          </button>
        </>
      )}

      {pool?.isOrganizer && phase === 'creating-wallet' && (
        <p className="text-sm opacity-60">Lagi bikin dompet kamu…</p>
      )}

      {pool?.isOrganizer && phase === 'ready' && (
        <button
          onClick={onConfirm}
          className="rounded-xl bg-foreground px-4 py-3 text-background font-medium"
        >
          Konfirmasi & Buat Arisan Ini
        </button>
      )}

      {phase === 'confirming' && (
        <p className="text-sm opacity-60">
          Lagi bikin kontrak & tanda tangan… jangan tutup halaman ini ya.
        </p>
      )}

      {phase === 'done' && (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            {pool?.status === 'draft'
              ? 'Belum dikonfirmasi.'
              : 'Arisan ini udah jadi ✅ — balik ke grup buat ikutan.'}
          </p>
          {pool && ['active', 'closed'].includes(pool.status) && (
            <a
              href={`/app/pool/${id}/jadwal`}
              className="rounded-xl border border-black/10 px-4 py-3 text-center text-sm font-medium dark:border-white/15"
            >
              Lihat Jadwal Kocokan
            </a>
          )}
        </div>
      )}
    </main>
  );
}
