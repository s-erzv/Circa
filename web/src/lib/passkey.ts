'use client';

import { startRegistration } from '@simplewebauthn/browser';
import { apiFetch } from './api-client';
import { openInSystemBrowser } from './telegram-client';

/**
 * Whether this browser can actually run a passkey ceremony.
 *
 * Telegram's in-app WebView does not expose WebAuthn on every platform
 * (notably iOS WKWebView), so this has to be checked before offering the
 * flow — calling `startRegistration` where it is unavailable throws an
 * opaque error that reads to the user as "the app is broken".
 */
export function isPasskeySupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined'
  );
}

export type WalletCreated = { verified: true; contractId: string };

/**
 * Whether a thrown error means "WebAuthn exists per `isPasskeySupported()`,
 * but this specific embedding context won't actually let it run" — the
 * case `isPasskeySupported()` cannot catch in advance.
 *
 * Telegram Desktop and Telegram Web render the Mini App inside an iframe.
 * Whether that iframe delegates the `publickey-credentials-create`
 * Permissions-Policy is entirely Telegram's call (the `allow` attribute on
 * *their* iframe embedding *us* — nothing on our side can grant it), so
 * `navigator.credentials.create` throws instead of silently being absent.
 * `isPasskeySupported()`'s feature-detection only checks that the API
 * object exists, not that policy allows invoking it — this is the runtime
 * check that catches what the static one structurally cannot.
 */
export function isWebAuthnBlockedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'NotAllowedError' ||
    /publickey-credentials-(create|get)/i.test(error.message) ||
    /permissions policy/i.test(error.message)
  );
}

/**
 * Runs the full ceremony: fetch a server-issued challenge, prompt for
 * FaceID/TouchID, and send the result back to be verified and bound.
 *
 * The challenge is never generated here. The server issues it, stores it,
 * and checks the response against what it stored — that round trip is the
 * entire replay protection, so a client-side shortcut would silently
 * reintroduce the vulnerability it exists to prevent.
 */
export async function createPasskeyWallet(): Promise<WalletCreated> {
  const options = await apiFetch<Parameters<typeof startRegistration>[0]['optionsJSON']>(
    '/api/webauthn/generate-registration-options',
    { method: 'POST' },
  );

  const attestation = await startRegistration({ optionsJSON: options });

  return apiFetch<WalletCreated>('/api/webauthn/verify-registration', {
    method: 'POST',
    body: JSON.stringify({ response: attestation }),
  });
}

/**
 * Fallback for WebViews without WebAuthn: hand off to the system browser.
 *
 * The handoff URL carries a one-time, server-signed, short-TTL token — never
 * the raw telegram_id. A URL is a weak place to carry identity (logs,
 * history, Referer, over-the-shoulder), so what travels there must be
 * useless once spent and useless after a few minutes.
 */
export async function handOffToSystemBrowser(): Promise<void> {
  const { url } = await apiFetch<{ url: string }>('/api/wallet/handoff', {
    method: 'POST',
  });
  openInSystemBrowser(url);
}
