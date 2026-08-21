'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { startRegistration } from '@simplewebauthn/browser';

type Phase = 'redeeming' | 'ready' | 'creating' | 'continuing' | 'done' | 'error';

type ActionKind = 'confirm' | 'join' | 'setor' | 'jadwal';
type NextAction = { kind: ActionKind; poolId: string };

const BOT_USERNAME = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || 'circagram_bot';

/** Mirrors bot.ts's own `<kind>_<poolId>` payload parsing for `/start`. */
function parseNext(next: string | null): NextAction | null {
  if (!next) return null;
  const [kind, poolId] = next.split('_');
  if (!poolId) return null;
  if (kind !== 'confirm' && kind !== 'join' && kind !== 'setor' && kind !== 'jadwal') {
    return null;
  }
  return { kind, poolId };
}

const continuingLabel: Record<ActionKind, string> = {
  confirm: 'Lagi bikin kontrak arisan…',
  join: 'Lagi nyelesain gabung kamu…',
  setor: 'Lagi proses setoran…',
  jadwal: 'Sebentar…',
};

const doneLabel: Record<ActionKind, string> = {
  confirm: 'Arisan ini udah jadi ✅',
  join: 'Kamu resmi gabung ✅',
  setor: 'Setoran berhasil ✅',
  jadwal: 'Dompet kamu udah jadi ✅',
};

/**
 * `apiFetch` refuses every request outside Telegram (by design — see
 * api-client.ts). This page runs OUTSIDE Telegram on purpose, so it talks
 * to the API directly; the handoff session cookie is what `requireUser`
 * accepts here instead of initData.
 */
async function rawFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(path, { ...init, headers });
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    payload = undefined;
  }
  if (!res.ok) {
    const message =
      (payload as { error?: string } | undefined)?.error ?? 'Ada yang error. Coba lagi bentar lagi ya.';
    throw new Error(message);
  }
  return payload as T;
}

type PreparedRelay = {
  relayId: string;
  authEntryXdr: string;
  validUntilLedgerSeq: number;
  networkPassphrase: string;
};

/**
 * Signs and submits one already-prepared relay, sharing the exact
 * prepare→sign→submit sequence relay-client.ts uses inside Telegram — this
 * page just can't call that module directly since it's built on `apiFetch`.
 */
async function signAndSubmit(prepared: PreparedRelay, credentialId: string): Promise<void> {
  const { xdr } = await import('@stellar/stellar-sdk');
  const { signSorobanAuthEntry } = await import('@/lib/soroban/passkey-auth');

  const unsignedEntry = xdr.SorobanAuthorizationEntry.fromXDR(prepared.authEntryXdr, 'base64');
  const signedEntry = await signSorobanAuthEntry(unsignedEntry, {
    validUntilLedgerSeq: prepared.validUntilLedgerSeq,
    networkPassphrase: prepared.networkPassphrase,
    credentialId,
  });

  await rawFetch('/api/tx/submit', {
    method: 'POST',
    body: JSON.stringify({
      relayId: prepared.relayId,
      signedAuthEntryXdr: signedEntry.toXDR('base64'),
    }),
  });
}

/**
 * Landing page for the system-browser passkey fallback.
 *
 * This page runs OUTSIDE Telegram, so there is no initData here. Identity
 * arrives as a one-time token in the URL, immediately exchanged for a
 * short-lived httpOnly session cookie — after which the token is spent and
 * the URL is worthless if it leaks.
 *
 * Beyond just creating the wallet, it also finishes whatever the user was
 * doing when Telegram's WebView blocked WebAuthn (join/setor/confirm) right
 * here, in the same browser session — the passkey ceremony already forced a
 * trip out of Telegram, so there is no reason to bounce the user back in
 * just to tap one more button that could be done automatically.
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

function LanjutInner() {
  const params = useSearchParams();
  const token = params.get('t');
  const action = parseNext(params.get('next'));
  const [phase, setPhase] = useState<Phase>('redeeming');
  const [error, setError] = useState<string | null>(null);
  const [resultLabel, setResultLabel] = useState<string | null>(null);
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
    (async () => {
      try {
        const r = await fetch('/api/wallet/handoff/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        if (!r.ok) throw new Error((await r.json()).error ?? 'gagal');

        // A wallet may already exist — this handoff can be reached not just
        // to CREATE one, but because the sign step of an already-existing
        // wallet's join/setor/confirm also hit the same iframe restriction
        // (`publickey-credentials-get`, not `-create`). Skip straight past
        // "Bikin dompet" in that case; there's no wallet left to create.
        const status = await rawFetch<{ hasWallet: boolean }>('/api/wallet/status');
        if (status.hasWallet && action && action.kind !== 'jadwal') {
          await continueAction(action);
        } else {
          setPhase('ready');
        }
      } catch (e) {
        setError((e as Error).message);
        setPhase('error');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  /**
   * Finishes the action the user was in the middle of when they got bounced
   * here. A failure past this point still leaves the wallet created, so it
   * falls through to 'done' with the error shown rather than back to
   * 'ready' — retrying wallet creation would just hit "already active".
   */
  async function continueAction(next: NextAction) {
    setPhase('continuing');
    try {
      const status = await rawFetch<{
        hasWallet: boolean;
        walletAddress: string | null;
        credentialId: string | null;
      }>('/api/wallet/status');
      if (!status.hasWallet || !status.walletAddress || !status.credentialId) {
        throw new Error('Dompet belum siap.');
      }

      if (next.kind === 'join' || next.kind === 'setor') {
        const pool = await rawFetch<{ contractId: string | null }>(`/api/pools/${next.poolId}`);
        if (!pool.contractId) throw new Error('Arisan ini belum siap.');

        const prepared = await rawFetch<PreparedRelay>('/api/tx/prepare', {
          method: 'POST',
          body: JSON.stringify({
            kind: next.kind === 'join' ? 'pool_join' : 'pool_contribute',
            poolId: pool.contractId,
            member: status.walletAddress,
          }),
        });
        await signAndSubmit(prepared, status.credentialId);

        if (next.kind === 'join') {
          await rawFetch(`/api/pools/${next.poolId}/confirm-joined`, { method: 'POST' });
        }
      } else if (next.kind === 'confirm') {
        const prepared = await rawFetch<PreparedRelay>(`/api/pools/${next.poolId}/deploy`, {
          method: 'POST',
        });
        await signAndSubmit(prepared, status.credentialId);
        await rawFetch(`/api/pools/${next.poolId}/confirm-created`, { method: 'POST' });
      }

      setResultLabel(doneLabel[next.kind]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPhase('done');
    }
  }

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

      if (action && action.kind !== 'jadwal') {
        await continueAction(action);
      } else {
        setPhase('done');
      }
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

      {phase === 'continuing' && (
        <p className="text-sm opacity-60">{continuingLabel[action?.kind ?? 'jadwal']}</p>
      )}

      {phase === 'done' && (
        <>
          <p className="text-lg">{resultLabel ?? 'Dompet kamu udah jadi ✅'}</p>
          <p className="max-w-sm text-sm opacity-70">
            {error
              ? 'Dompetnya aman kok — tinggal balik ke Telegram buat coba lagi.'
              : 'Balik ke Telegram ya, lanjutin di sana.'}
          </p>
          <a
            href={`https://t.me/${BOT_USERNAME}${params.get('next') ? `?start=${params.get('next')}` : ''}`}
            className="rounded-xl bg-foreground px-5 py-3 text-background font-medium"
          >
            Buka Telegram
          </a>
        </>
      )}
    </main>
  );
}
