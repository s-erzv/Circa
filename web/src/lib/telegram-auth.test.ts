import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { verifyInitData } from './telegram-auth';

const BOT_TOKEN = '123456:TEST-TOKEN';

/**
 * Produces a genuinely signed initData payload, exactly the way Telegram
 * does: every field except `hash`, sorted by key, joined as `k=v` with
 * newlines, HMAC'd with a key that is itself HMAC("WebAppData", botToken).
 *
 * Building this by hand rather than mocking the verifier is the point — a
 * mocked signature would prove nothing about whether we validate real ones.
 */
function signInitData(
  fields: Record<string, string>,
  token = BOT_TOKEN,
): string {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const freshUser = () => ({
  user: JSON.stringify({ id: 42, username: 'budi', first_name: 'Budi' }),
  auth_date: String(Math.floor(Date.now() / 1000)),
});

describe('verifyInitData', () => {
  test('accepts a correctly signed payload and extracts the user', () => {
    const result = verifyInitData(signInitData(freshUser()), BOT_TOKEN);
    expect(result.id).toBe('42');
    expect(result.username).toBe('budi');
    expect(result.firstName).toBe('Budi');
  });

  test('rejects a payload signed with the wrong bot token', () => {
    const forged = signInitData(freshUser(), '999:WRONG-TOKEN');
    expect(() => verifyInitData(forged, BOT_TOKEN)).toThrow();
  });

  // The account-takeover case: an attacker who has seen someone else's valid
  // payload swaps in their own id. The hash must stop this, because the id is
  // part of the signed material.
  test('rejects a tampered user id even when the signature is otherwise intact', () => {
    const valid = new URLSearchParams(signInitData(freshUser()));
    valid.set('user', JSON.stringify({ id: 99, username: 'attacker' }));
    expect(() => verifyInitData(valid.toString(), BOT_TOKEN)).toThrow();
  });

  test('rejects a stale payload beyond the freshness window', () => {
    const stale = signInitData({
      user: JSON.stringify({ id: 42 }),
      auth_date: String(Math.floor(Date.now() / 1000) - 60 * 60 * 25),
    });
    expect(() => verifyInitData(stale, BOT_TOKEN)).toThrow(/expired/i);
  });

  test('rejects an entirely unsigned payload', () => {
    const unsigned = new URLSearchParams(freshUser()).toString();
    expect(() => verifyInitData(unsigned, BOT_TOKEN)).toThrow(/hash/i);
  });

  test('rejects a payload with a valid signature but no user', () => {
    const noUser = signInitData({
      auth_date: String(Math.floor(Date.now() / 1000)),
    });
    expect(() => verifyInitData(noUser, BOT_TOKEN)).toThrow(/user/i);
  });

  // A hex string of the wrong length must be rejected cleanly, not crash:
  // timingSafeEqual throws on length mismatch, so the length guard has to
  // come first.
  test('rejects a truncated hash without throwing a length error', () => {
    const params = new URLSearchParams(signInitData(freshUser()));
    params.set('hash', 'abcd');
    expect(() => verifyInitData(params.toString(), BOT_TOKEN)).toThrow(
      /signature/i,
    );
  });
});
