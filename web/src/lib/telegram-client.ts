'use client';

/**
 * Client-side access to the Telegram Mini App bridge.
 *
 * Everything here is for RENDERING and UX only. The user object Telegram
 * exposes to JavaScript is unauthenticated — a modified client can put any
 * name or id in it. Never branch on it for authorization; the server
 * decides that from the HMAC-verified `initData` (see telegram-auth.ts).
 */

type TelegramWebApp = {
  initData: string;
  initDataUnsafe?: {
    user?: { id: number; username?: string; first_name?: string };
  };
  ready: () => void;
  expand: () => void;
  openLink: (url: string) => void;
  colorScheme?: 'light' | 'dark';
  themeParams?: Record<string, string>;
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function getWebApp(): TelegramWebApp | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.Telegram?.WebApp;
}

/** True when running inside Telegram with a usable signed payload. */
export function isInsideTelegram(): boolean {
  const app = getWebApp();
  return Boolean(app && app.initData);
}

/**
 * The signed payload to send to our API. Empty string when opened outside
 * Telegram — callers should check `isInsideTelegram()` and show the
 * "buka lewat Telegram" state rather than firing doomed requests.
 */
export function getInitData(): string {
  return getWebApp()?.initData ?? '';
}

/** Display-only identity. Not evidence of anything. */
export function getDisplayUser() {
  const u = getWebApp()?.initDataUnsafe?.user;
  if (!u) return undefined;
  return {
    id: String(u.id),
    username: u.username,
    firstName: u.first_name,
  };
}

/**
 * Tells Telegram the app has painted and asks for the full-height view.
 * Safe to call outside Telegram — it simply does nothing, so pages can call
 * it unconditionally on mount.
 */
export function initTelegramView(): void {
  const app = getWebApp();
  if (!app) return;
  app.ready();
  app.expand();
}

/**
 * Opens a URL in the system browser rather than Telegram's WebView.
 *
 * Needed for the passkey fallback: WebAuthn is unavailable in Telegram's
 * in-app WebView on some platforms, and the ceremony has to happen
 * somewhere that supports it.
 */
export function openInSystemBrowser(url: string): void {
  const app = getWebApp();
  if (app?.openLink) {
    app.openLink(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
