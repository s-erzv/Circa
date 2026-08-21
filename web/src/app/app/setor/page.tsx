'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import {
  createPasskeyWallet,
  handOffToSystemBrowser,
  isPasskeySupported,
  isWebAuthnBlockedError,
} from '@/lib/passkey';
import { initTelegramView, isInsideTelegram } from '@/lib/telegram-client';

type WalletStatus = { hasWallet: boolean; walletAddress: string | null };

type Phase =
  | 'checking'
  | 'needs-wallet'
  | 'creating-wallet'
  | 'ready-to-pay'
  | 'error';

export default function SetorPage() {
  const [phase, setPhase] = useState<Phase>('checking');
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    initTelegramView();
    if (!isInsideTelegram()) {
      setError('Buka lewat Telegram ya.');
      setPhase('error');
      return;
    }
    apiFetch<WalletStatus>('/api/wallet/status')
      .then((s) => setPhase(s.hasWallet ? 'ready-to-pay' : 'needs-wallet'))
      .catch((e) => {
        setError(e.message);
        setPhase('error');
      });
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function onCreateWallet() {
    setError(null);

    // Telegram's WebView does not expose WebAuthn on every platform. Check
    // before prompting: calling into it where it is missing throws an
    // opaque error that reads as "the app is broken".
    if (!isPasskeySupported()) {
      try {
        await handOffToSystemBrowser();
      } catch (e) {
        setError((e as Error).message);
        setPhase('error');
      }
      return;
    }

    setPhase('creating-wallet');
    try {
      await createPasskeyWallet();
      setPhase('ready-to-pay');
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

  return (
    <main className="flex min-h-dvh flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Setor arisan</h1>

      {error && (
        <div className="rounded-xl border border-red-300/40 bg-red-500/10 p-4 text-sm">
          {error}
        </div>
      )}

      {phase === 'checking' && (
        <p className="text-sm opacity-60">Sebentar ya…</p>
      )}

      {phase === 'needs-wallet' && (
        <section className="flex flex-col gap-4">
          <div className="rounded-xl border border-black/10 p-4 text-sm dark:border-white/15">
            <p className="font-medium">Sekali doang: bikin dompet kamu.</p>
            <p className="mt-2 opacity-70">
              Sebentar lagi HP kamu bakal minta FaceID atau sidik jari. Itu
              dipakai buat bikin kunci yang cuma ada di HP kamu — jadi cuma kamu
              yang bisa gerakin uangmu. Circa sendiri nggak bisa, dan nggak
              nyimpen kunci itu di mana pun.
            </p>
            <p className="mt-2 opacity-70">
              Habis ini kamu nggak perlu ngulang lagi.
            </p>
          </div>
          <button
            onClick={onCreateWallet}
            className="rounded-xl bg-foreground px-4 py-3 text-background font-medium"
          >
            Bikin dompet & lanjut setor
          </button>
        </section>
      )}

      {phase === 'creating-wallet' && (
        <p className="text-sm opacity-60">
          Lagi bikin dompet kamu… jangan tutup halaman ini ya.
        </p>
      )}

      {phase === 'ready-to-pay' && (
        <section className="rounded-xl border border-black/10 p-4 text-sm dark:border-white/15">
          <p className="font-medium">Dompet kamu siap</p>
          <p className="mt-1 opacity-70">
            Alur pembayaran (top-up Rupiah lewat anchor) nyusul di tahap
            berikutnya.
          </p>
        </section>
      )}
    </main>
  );
}
