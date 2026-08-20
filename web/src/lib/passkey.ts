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
