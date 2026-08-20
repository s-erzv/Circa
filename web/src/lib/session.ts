import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { requireTelegramUser, type TelegramUser } from './telegram-auth';

const COOKIE_NAME = 'circa_handoff';

/** Handoff sessions are deliberately short: just long enough to finish a
 *  FaceID prompt in a browser the user had to switch to. */
const SESSION_TTL_SECONDS = 10 * 60;

function secret(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  return token;
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('hex');
}

export function newHandoffToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Mints a signed cookie value binding a Telegram id to an expiry.
 *
 * Signed rather than stored-by-reference so redemption needs no second
 * round trip, but still tamper-evident: the id and expiry are both inside
 * the signed material, so neither can be edited by the holder.
 */
export function mintHandoffSession(telegramId: string): {
  name: string;
  value: string;
  maxAge: number;
} {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${telegramId}.${expiresAt}`;
  return {
    name: COOKIE_NAME,
    value: `${payload}.${sign(payload)}`,
    maxAge: SESSION_TTL_SECONDS,
  };
}

function verifyHandoffSession(value: string): TelegramUser | null {
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [telegramId, expiresAtRaw, providedSig] = parts;

  const payload = `${telegramId}.${expiresAtRaw}`;
  const expected = Buffer.from(sign(payload), 'hex');
  const provided = Buffer.from(providedSig, 'hex');
  if (
    expected.length !== provided.length ||
    !timingSafeEqual(expected, provided)
  ) {
    return null;
  }

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) {
    return null;
  }

  return { id: telegramId };
}

/**
 * Resolves the caller from EITHER source of server-verified identity:
 * Telegram's signed initData (the normal path), or a handoff session cookie
 * (the system-browser fallback, where initData does not exist).
 *
 * Both are verified server-side against a secret the client never holds, so
 * neither is a claim the caller can forge. The initData path is tried first
 * because it is the one that should normally apply; the cookie exists only
 * for the WebView-without-WebAuthn case.
 */
export async function requireUser(request: Request): Promise<TelegramUser> {
  try {
    return await requireTelegramUser(request);
  } catch {
    // Fall through to the handoff cookie.
  }

  const jar = await cookies();
  const cookie = jar.get(COOKIE_NAME);
  if (!cookie) throw new Error('unauthenticated');

  const user = verifyHandoffSession(cookie.value);
  if (!user) throw new Error('unauthenticated');
  return user;
}

export const HANDOFF_COOKIE_NAME = COOKIE_NAME;
