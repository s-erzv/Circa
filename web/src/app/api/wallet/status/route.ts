import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { supabase } from '@/lib/supabase';

/**
 * Reports whether the caller has bound a passkey wallet yet.
 *
 * A null wallet is an ordinary, expected state — most users will sit in it
 * from `/start` until their first setoran — so this returns 200 with
 * `hasWallet: false` rather than treating it as an error.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireUser(request);
  } catch {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { data, error } = await supabase
    .from('users')
    .select('wallet_address, credential_id')
    .eq('telegram_id', user.id)
    .maybeSingle();

  if (error) {
    console.error('wallet/status lookup failed:', error);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }

  return NextResponse.json({
    hasWallet: Boolean(data?.wallet_address),
    walletAddress: data?.wallet_address ?? null,
    // Needed by the client to scope a later passkey ceremony to the right
    // credential (`allowCredentials`) rather than prompting the user to pick
    // among every passkey the platform authenticator happens to hold.
    credentialId: data?.credential_id ?? null,
  });
}
