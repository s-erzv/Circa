import { createHmac, timingSafeEqual } from 'node:crypto';

export type TelegramUser = {
  id: string;
  username?: string;
  firstName?: string;
};

/**
 * How long a signed initData payload stays acceptable.
 *
 * Telegram signs `auth_date` but does not expire payloads itself, so without
 * a window a payload captured once stays valid forever. 24h matches
 * Telegram's own guidance and is short enough that a leaked payload has a
 * bounded life, while long enough that a Mini App left open in the
 * background still works when the user returns to it.
 */
const MAX_AGE_SECONDS = 24 * 60 * 60;

/**
 * Verifies a Telegram Mini App `initData` payload and returns the user it
 * attests to.
 *
 * This is the trust boundary of the whole application. Telegram signs the
 * payload with HMAC-SHA256 under a key derived from the bot token, which the
 * client never holds — so a verified payload is cryptographic proof of which
 * Telegram account is calling. Nothing else in this codebase may be used to
 * establish identity: a `telegram_id` in a URL or request body is a claim,
 * not evidence, and Telegram IDs are freely visible to anyone sharing a
 * group with the user.
 *
 * Throws on any failure rather than returning null, so a caller cannot
 * accidentally treat an unverified payload as anonymous-but-acceptable.
 */
export function verifyInitData(initData: string, botToken: string): TelegramUser {
  const params = new URLSearchParams(initData);

  const hash = params.get('hash');
  if (!hash) throw new Error('initData: missing hash');
  params.delete('hash');

  // Telegram's data-check string: remaining fields sorted by key, joined
  // as `key=value` with newlines.
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');

  // Constant-time comparison. The length check has to come first because
  // timingSafeEqual throws on mismatched lengths instead of returning false,
  // which would surface as a confusing crash on a merely-malformed hash.
  const expectedBytes = Buffer.from(expected, 'hex');
  const actualBytes = Buffer.from(hash, 'hex');
  if (
    expectedBytes.length !== actualBytes.length ||
    !timingSafeEqual(expectedBytes, actualBytes)
  ) {
    throw new Error('initData: signature mismatch');
  }

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate)) {
    throw new Error('initData: missing or malformed auth_date');
  }
  if (Math.floor(Date.now() / 1000) - authDate > MAX_AGE_SECONDS) {
    throw new Error('initData: expired');
  }

  const rawUser = params.get('user');
  if (!rawUser) throw new Error('initData: missing user');

  let user: { id?: unknown; username?: unknown; first_name?: unknown };
  try {
    user = JSON.parse(rawUser);
  } catch {
    throw new Error('initData: malformed user');
  }
  if (typeof user.id !== 'number' && typeof user.id !== 'string') {
    throw new Error('initData: malformed user');
  }

  return {
    id: String(user.id),
    username: typeof user.username === 'string' ? user.username : undefined,
    firstName: typeof user.first_name === 'string' ? user.first_name : undefined,
  };
}

/**
 * The only sanctioned way an API route learns who is calling.
 *
 * Reads initData from a header rather than the query string: URLs end up in
 * server logs, browser history, and `Referer` headers, and a leaked initData
 * payload is a usable credential until it expires.
 */
export async function requireTelegramUser(request: Request): Promise<TelegramUser> {
  const initData = request.headers.get('x-telegram-init-data');
  if (!initData) throw new Error('unauthenticated: no initData supplied');

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');

  return verifyInitData(initData, token);
}
