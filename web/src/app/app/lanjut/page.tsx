'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { startRegistration } from '@simplewebauthn/browser';

type Phase = 'redeeming' | 'ready' | 'creating' | 'done' | 'error';

/**
 * Landing page for the system-browser passkey fallback.
 *
 * This page runs OUTSIDE Telegram, so there is no initData here. Identity
 * arrives as a one-time token in the URL, immediately exchanged for a
 * short-lived httpOnly session cookie — after which the token is spent and
 * the URL is worthless if it leaks.
 *
 * It calls the WebAuthn endpoints directly rather than through `apiFetch`,
 * because `apiFetch` requires initData and would refuse every request here.
 * The cookie is the credential instead, and the server accepts either.
 */
export default function LanjutPage() {
  // useSearchParams needs a Suspense boundary: without one the whole route
  // opts out of prerendering and the build fails.
  return (
    <Suspense
      fallback={
        <main className="flex min-h-dvh items-center justify-center p-8">
          <p className="text-sm opacity-60">Sebentar…</p>
        </main>
      }
    >
      <LanjutInner />
    </Suspense>
  );
}

const BOT_USERNAME = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || 'circagram_bot';

function LanjutInner() {
  const params = useSearchParams();
  const token = params.get('t');
  const next = params.get('next');
  const [phase, setPhase] = useState<Phase>('redeeming');
  const [error, setError] = useState<string | null>(null);
  // The redeem token is single-use. React StrictMode double-invokes effects
  // in dev, which would otherwise fire this request twice and always show
  // the second (failing) response.
  const redeemed = useRef(false);

  useEffect(() => {
    if (!token) {
      setError('Link-nya nggak lengkap. Balik ke Telegram dan coba lagi ya.');
      setPhase('error');
      return;
    }
    if (redeemed.current) return;
    redeemed.current = true;
    fetch('/api/wallet/handoff/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? 'gagal');
        setPhase('ready');
      })
      .catch((e) => {
        setError(e.message);
        setPhase('error');
      });
  }, [token]);

  async function onCreate() {
    setPhase('creating');
    setError(null);
    try {
      const optRes = await fetch('/api/webauthn/generate-registration-options', {
        method: 'POST',
      });
      if (!optRes.ok) throw new Error((await optRes.json()).error ?? 'gagal');
      const optionsJSON = await optRes.json();

      const attestation = await startRegistration({ optionsJSON });

      const verifyRes = await fetch('/api/webauthn/verify-registration', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response: attestation }),
      });
      if (!verifyRes.ok) throw new Error((await verifyRes.json()).error ?? 'gagal');

      setPhase('done');
    } catch (e) {
      setError((e as Error).message);
      setPhase('ready');
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 p-8 text-center">
      <h1 className="text-xl font-semibold">Lanjut bikin dompet</h1>

      {error && (
        <div className="w-full max-w-sm rounded-xl border border-red-300/40 bg-red-500/10 p-4 text-sm">
          {error}
        </div>
      )}

      {phase === 'redeeming' && <p className="text-sm opacity-60">Sebentar…</p>}

      {phase === 'ready' && (
        <>
          <p className="max-w-sm text-sm opacity-70">
            HP kamu bakal minta FaceID atau sidik jari buat bikin kunci yang cuma
            ada di HP kamu.
          </p>
          <button
            onClick={onCreate}
            className="rounded-xl bg-foreground px-5 py-3 text-background font-medium"
          >
            Bikin dompet
          </button>
        </>
      )}

      {phase === 'creating' && (
        <p className="text-sm opacity-60">Lagi bikin dompet kamu…</p>
      )}

      {phase === 'done' && (
        <>
          <p className="text-lg">Dompet kamu udah jadi ✅</p>
          <p className="max-w-sm text-sm opacity-70">
            Balik ke Telegram ya, lanjutin di sana.
          </p>
          <a
            href={`https://t.me/${BOT_USERNAME}${next ? `?start=${next}` : ''}`}
            className="rounded-xl bg-foreground px-5 py-3 text-background font-medium"
          >
            Buka Telegram
          </a>
        </>
      )}
    </main>
  );
}
