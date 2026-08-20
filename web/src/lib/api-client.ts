'use client';

import { getInitData, isInsideTelegram } from './telegram-client';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The only sanctioned way the client calls our API.
 *
 * Attaches the signed Telegram payload to every request as a header. Going
 * through one wrapper — rather than calling `fetch` directly from
 * components — is what makes "every route authenticates" a property of the
 * codebase instead of a rule someone has to remember at each call site.
 *
 * The header, not the query string: URLs land in server logs, browser
 * history, and Referer headers, and a leaked initData payload is a usable
 * credential until it expires.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (!isInsideTelegram()) {
    throw new ApiError(
      'Buka Circa lewat Telegram ya — di luar Telegram kami nggak bisa mastiin ini kamu.',
      401,
    );
  }

  const headers = new Headers(init.headers);
  headers.set('x-telegram-init-data', getInitData());
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(path, { ...init, headers });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    const message =
      (payload as { error?: string } | undefined)?.error ??
      'Ada yang error. Coba lagi bentar lagi ya.';
    throw new ApiError(message, response.status);
  }

  return payload as T;
}
