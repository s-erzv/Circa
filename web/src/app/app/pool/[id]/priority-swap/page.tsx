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
 * Member requests a priority swap (Piauw) with someone earlier in the queue.
 */
export default function PrioritySwapPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [phase, setPhase] = useState<Phase>('loading');
  const [pool, setPool] = useState<PoolInfo | null>(null);
  const [wallet, setWallet] = useState<WalletStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  const [target, setTarget] = useState<string>('');
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
    if (!target) {
      setError('Pilih target yang mau ditukar gilirannya.');
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

      // We should probably hit a webhook or notify the target via bot,
      // but the event indexer or a simpler API call can handle that.
      // For now, let's just trigger a DM via an API endpoint.
      await apiFetch(`/api/pools/${id}/notify-pswap`, {
        method: 'POST',
        body: JSON.stringify({ target, fee: feeBig.toString() })
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

  // Filter queue to only show people EARLIER than the current user.
  // We can't swap with ourselves, and there's no point swapping with someone later.
  const myIndex = wallet?.walletAddress && pool?.queue ? pool.queue.indexOf(wallet.walletAddress) : -1;
  const eligibleTargets = pool?.queue && myIndex > 0 ? pool.queue.slice(0, myIndex) : [];

  return (
    <main className="flex min-h-dvh flex-col gap-6 p-6">
      <div className="text-4xl">🔄</div>
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
            Butuh dana lebih awal? Kamu bisa minta tukar posisi dengan anggota yang dapet giliran lebih dulu. 
            Sebagai gantinya, kamu bayar kompensasi (fee) yang akan masuk ke kas cadangan dan dibagikan ke semua anggota di akhir.
          </p>

          {myIndex === -1 ? (
            <p className="text-red-500">Kamu belum gabung atau giliran kamu udah lewat.</p>
          ) : myIndex === 0 ? (
            <p className="text-yellow-600 font-medium">Kamu udah ada di urutan pertama! Nggak bisa maju lagi.</p>
          ) : (
            <div className="flex flex-col gap-4">
              <div>
                <label className="block text-xs font-medium opacity-70 mb-1">Target Tukar (Urutan Lebih Awal)</label>
                <select 
                  className="w-full rounded-lg border border-black/10 p-3 bg-transparent dark:border-white/15"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="">-- Pilih Anggota --</option>
                  {eligibleTargets.map((addr, idx) => (
                    <option key={addr} value={addr}>Urutan ke-{idx + 1}: {addr.slice(0, 8)}...</option>
                  ))}
                </select>
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
          Ajukan Permintaan
        </button>
      )}

      {phase === 'requesting' && (
        <p className="text-sm opacity-60">Lagi diproses di blockchain… jangan tutup dulu ya.</p>
      )}

      {phase === 'done' && (
        <div className="flex flex-col gap-3">
          <p className="text-lg font-semibold">Permintaan berhasil dikirim!</p>
          <p className="text-sm opacity-70">
            Bot udah ngabarin target kamu. Kalau dia setuju, posisi kalian bakal ditukar dan fee dipotong otomatis.
          </p>
        </div>
      )}
    </main>
  );
}
