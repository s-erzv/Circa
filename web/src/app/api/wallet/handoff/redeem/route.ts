import { NextResponse } from 'next/server';
import { mintHandoffSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';

/**
 * Exchanges a one-time handoff token for a short-lived session cookie.
 *
 * The token is marked used before the session is minted, and the update is
 * conditioned on `used_at is null`, so two concurrent redemptions cannot
 * both succeed — one wins, the other is refused. Marking-then-minting
 * (rather than the reverse) means a crash between the two steps burns the
 * token rather than leaving it replayable.
 */
export async function POST(request: Request) {
  const { token } = await request.json().catch(() => ({ token: null }));
  if (typeof token !== 'string' || !token) {
    return NextResponse.json({ error: 'invalid token' }, { status: 400 });
  }

  const { data: row } = await supabase
    .from('wallet_handoff_tokens')
    .select('telegram_id, expires_at, used_at')
    .eq('token', token)
    .maybeSingle();

  if (!row || row.used_at) {
    // One message for "never existed" and "already spent": distinguishing
    // them tells a probing caller which tokens are real.
    return NextResponse.json(
      { error: 'Link-nya udah kepakai atau nggak berlaku. Balik ke Telegram dan coba lagi ya.' },
      { status: 400 },
    );
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    return NextResponse.json(
      { error: 'Link-nya udah kedaluwarsa. Balik ke Telegram dan coba lagi ya.' },
      { status: 400 },
    );
  }

  const { data: claimed } = await supabase
    .from('wallet_handoff_tokens')
    .update({ used_at: new Date().toISOString() })
    .eq('token', token)
    .is('used_at', null)
    .select()
    .maybeSingle();

  if (!claimed) {
    return NextResponse.json(
      { error: 'Link-nya udah kepakai. Balik ke Telegram dan coba lagi ya.' },
      { status: 400 },
    );
  }

  const session = mintHandoffSession(row.telegram_id);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(session.name, session.value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: session.maxAge,
  });
  return response;
}
