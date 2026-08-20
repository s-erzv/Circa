'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  getDisplayUser,
  initTelegramView,
  isInsideTelegram,
} from '@/lib/telegram-client';
import { apiFetch } from '@/lib/api-client';

type WalletStatus = {
  hasWallet: boolean;
  walletAddress: string | null;
};

export default function AppHome() {
  const [insideTelegram, setInsideTelegram] = useState<boolean | null>(null);
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    initTelegramView();
    const inside = isInsideTelegram();
    setInsideTelegram(inside);
    if (!inside) return;

    apiFetch<WalletStatus>('/api/wallet/status')
      .then(setStatus)
      .catch((e) => setError(e.message));
  }, []);

  // Server-rendered pass: render nothing rather than flashing the
  // "open in Telegram" state at users who are, in fact, in Telegram.
  if (insideTelegram === null) return null;

  if (!insideTelegram) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="text-xl font-semibold">Buka lewat Telegram ya</h1>
        <p className="max-w-sm text-sm opacity-70">
          Circa jalan di dalam Telegram. Cari bot Circa di Telegram, terus buka
          dari tombol yang dia kasih.
        </p>
      </main>
    );
  }

  const user = getDisplayUser();

  return (
    <main className="flex min-h-dvh flex-col gap-6 p-6">
      <header>
        <p className="text-sm opacity-60">Halo,</p>
        <h1 className="text-2xl font-semibold">
          {user?.firstName || user?.username || 'teman'} 👋
        </h1>
      </header>

      {error && (
        <div className="rounded-xl border border-red-300/40 bg-red-500/10 p-4 text-sm">
          {error}
        </div>
      )}

      {status && !status.hasWallet && (
        <section className="rounded-xl border border-black/10 p-4 text-sm dark:border-white/15">
          <p className="font-medium">Kamu belum punya dompet — dan itu normal.</p>
          <p className="mt-1 opacity-70">
            Dompet baru dibikin pas kamu mau setor pertama kali. Sebelum itu kamu
            bebas ikut arisan, lihat-lihat, dan keluar lagi tanpa naruh apa-apa.
          </p>
        </section>
      )}

      {status?.hasWallet && (
        <section className="rounded-xl border border-black/10 p-4 text-sm dark:border-white/15">
          <p className="font-medium">Dompet kamu aktif ✅</p>
          <p className="mt-1 break-all font-mono text-xs opacity-60">
            {status.walletAddress}
          </p>
          <Link
            href="/app/topup"
            className="mt-3 inline-block rounded-xl bg-foreground px-4 py-2 text-background font-medium"
          >
            Isi Saldo (QRIS)
          </Link>
        </section>
      )}

      {!status && !error && (
        <p className="text-sm opacity-60">Sebentar ya, lagi ngecek…</p>
      )}
    </main>
  );
}
