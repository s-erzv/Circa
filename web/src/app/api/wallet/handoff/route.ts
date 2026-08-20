import { NextResponse } from 'next/server';
import { requireTelegramUser } from '@/lib/telegram-auth';
import { newHandoffToken } from '@/lib/session';
import { supabase } from '@/lib/supabase';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * Issues a one-time handoff URL for continuing the passkey ceremony in the
 * system browser.
 *
 * Requires real initData — not the handoff cookie — so a handoff can only
 * ever originate inside Telegram. Letting a handoff session mint further
 * handoffs would turn a single short-lived token into an indefinitely
 * renewable one.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireTelegramUser(request);
  } catch {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const token = newHandoffToken();
  const { error } = await supabase.from('wallet_handoff_tokens').insert({
    token,
    telegram_id: user.id,
    expires_at: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
  });

  if (error) {
    console.error('Failed to store handoff token:', error);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }

  return NextResponse.json({ url: `${APP_URL}/app/lanjut?t=${token}` });
}
