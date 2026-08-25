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
  queue: string[];
};

type WalletStatus = { hasWallet: boolean; walletAddress: string | null; credentialId: string | null };
type Phase = 'loading' | 'ready' | 'needs-wallet' | 'creating-wallet' | 'requesting' | 'done' | 'error';

/**
 * Member bids to swap into the front-of-queue slot. Only `queue[0]` is ever
 * a valid target — distribute() reshuffles the entire remaining queue after
 * every payout, so a swap into any other position gets scrambled away
 * before it would matter. This is an auction, not a single offer: other
 * members may also be bidding on the same slot, and whichever bid ends up
 * highest is the only one the front-of-queue person can accept.
 */
export default function PrioritySwapPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [phase, setPhase] = useState<Phase>('loading');
  const [pool, setPool] = useState<PoolInfo | null>(null);
  const [wallet, setWallet] = useState<WalletStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fee, setFee] = useState<string>('');

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

      const status = await apiFetch<WalletStatus>('/api/wallet/status');
      setWallet(status);
      setPhase(status.hasWallet ? 'ready' : 'needs-wallet');
    } catch (e) {
      setError((e as Error).message);
      setPhase('error');
    }
  }

  async function onCreateWallet() {
    if (!isPasskeySupported()) {
      try {
        await handOffToSystemBrowser(`pswap_${id}`);
      } catch (e) {
        setError((e as Error).message);
      }
      return;
    }
    setPhase('creating-wallet');
    setError(null);
    try {
      await createPasskeyWallet();
      const status = await apiFetch<WalletStatus>('/api/wallet/status');
      setWallet(status);
      setPhase('ready');
    } catch (e) {
      if (isWebAuthnBlockedError(e)) {
        try { await handOffToSystemBrowser(`pswap_${id}`); } catch (he) { setError((he as Error).message); setPhase('needs-wallet'); }
        return;
      }
      setError((e as Error).message);
      setPhase('needs-wallet');
    }
  }

  async function onRequest() {
    const target = pool?.queue[0];
    if (!target) {
      setError('Belum ada urutan giliran buat pool ini.');
      return;
    }
    const feeBig = BigInt(fee || '0');
    if (feeBig <= BigInt(0)) {
      setError('Tentukan biaya kompensasi (fee) yang valid.');
      return;
    }

    setPhase('requesting');
    setError(null);
    try {
      const status = await apiFetch<WalletStatus>('/api/wallet/status');
      if (!status.hasWallet || !status.walletAddress || !status.credentialId || !pool?.contractId) {
        throw new Error('Dompet belum siap.');
      }

      await relayAction(
        {
          kind: 'pool_request_priority_swap',
          poolId: pool.contractId,
          requester: status.walletAddress,
          target,
          fee: feeBig.toString()
        },
        status.credentialId,
      );

      // notify-pswap re-derives the fee (and confirms the bid is real) from
      // the on-chain pending bids themselves — target is all it needs.
      await apiFetch(`/api/pools/${id}/notify-pswap`, {
        method: 'POST',
        body: JSON.stringify({ target })
      });

      setPhase('done');
    } catch (e) {
      if (isWebAuthnBlockedError(e)) {
        try { await handOffToSystemBrowser(`pswap_${id}`); } catch (he) { setError((he as Error).message); }
        setPhase('ready');
        return;
      }
      setError((e as Error).message);
      setPhase('ready');
    }
  }

  const myIndex = wallet?.walletAddress && pool?.queue ? pool.queue.indexOf(wallet.walletAddress) : -1;
  const frontOfQueue = pool?.queue[0] ?? null;

  return (
    <main className="flex min-h-dvh flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Tukar Giliran (Piauw)</h1>

      {error && (
        <div className="rounded-xl border border-red-300/40 bg-red-500/10 p-4 text-sm">
          {error}
        </div>
      )}

      {phase === 'loading' && <p className="text-sm opacity-60">Sebentar…</p>}

      {pool && wallet && phase !== 'loading' && phase !== 'error' && phase !== 'done' && (
        <section className="rounded-xl border border-black/10 p-4 text-sm dark:border-white/15">
          <p className="opacity-70 mb-4">
            Butuh dana lebih awal? Kamu bisa nawar buat gantiin posisi yang paling depan urutan
            (satu-satunya posisi yang beneran pasti — sisanya diundi ulang tiap siklus).
            Anggota lain juga boleh ikut nawar; yang keliatan cuma tawaran tertinggi doang yang berlaku.
          </p>

          {myIndex === -1 ? (
            <p className="text-red-500">Kamu belum gabung atau giliran kamu udah lewat.</p>
          ) : myIndex === 0 ? (
            <p className="text-yellow-600 font-medium">Kamu udah ada di urutan pertama! Nggak bisa maju lagi.</p>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="rounded-lg border border-black/10 p-3 text-xs opacity-70 dark:border-white/15">
                Target: {frontOfQueue?.slice(0, 8)}... (urutan pertama)
              </div>
              <div>
                <label className="block text-xs font-medium opacity-70 mb-1">Fee (Masuk ke Kas Cadangan)</label>
                <input
                  type="number"
                  min="0"
                  className="w-full rounded-lg border border-black/10 p-3 bg-transparent dark:border-white/15"
                  placeholder="Contoh: 50000"
                  value={fee}
                  onChange={(e) => setFee(e.target.value)}
                />
              </div>
            </div>
          )}
        </section>
      )}

      {phase === 'needs-wallet' && (
        <>
          <p className="text-sm opacity-70">
            Butuh tanda tangan pakai FaceID/sidik jari.
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

      {phase === 'ready' && myIndex > 0 && (
        <button
          onClick={onRequest}
          className="rounded-xl bg-foreground px-4 py-3 text-background font-medium"
        >
          Ajukan Tawaran
        </button>
      )}

      {phase === 'requesting' && (
        <p className="text-sm opacity-60">Lagi diproses di blockchain… jangan tutup dulu ya.</p>
      )}

      {phase === 'done' && (
        <div className="flex flex-col gap-3">
          <p className="text-lg font-semibold">Tawaran berhasil dikirim!</p>
          <p className="text-sm opacity-70">
            Bot udah ngabarin. Kalau tawaranmu masih yang tertinggi pas dia memutuskan, posisi
            kalian bakal ditukar dan fee dipotong otomatis — kalau kalah tawar, fee-mu balik utuh.
          </p>
        </div>
      )}
    </main>
  );
}
