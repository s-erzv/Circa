import { NextResponse } from 'next/server';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { requireUser } from '@/lib/session';
import { supabase } from '@/lib/supabase';

const rpName = 'Circa Arisan';
const originUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const rpID = new URL(originUrl).hostname;

/** How long a user has to complete the FaceID/TouchID prompt. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Issues a WebAuthn registration challenge for the *verified* caller.
 *
 * Two things changed from the prototype, both load-bearing:
 *
 *  - Identity comes from the signed Telegram initData header, not from a
 *    `?id=` query parameter. Telegram IDs are visible to anyone sharing a
 *    group, so accepting one from the client let an attacker start a
 *    registration against someone else's account.
 *
 *  - The challenge is persisted server-side. `verify-registration` checks
 *    the response against *this* stored value; without that, there is no
 *    replay protection at all.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireUser(request);
  } catch {
    // Deliberately opaque: distinguishing "bad signature" from "expired"
    // for an unauthenticated caller only helps someone probing the format.
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    // Refuse before issuing a challenge if a wallet already exists. The
    // binding is single-shot, so completing this ceremony could not succeed
    // anyway — failing here saves the user an unexplained FaceID prompt.
    const { data: existing } = await supabase
      .from('users')
      .select('wallet_address')
      .eq('telegram_id', user.id)
      .maybeSingle();

    if (existing?.wallet_address) {
      return NextResponse.json(
        { error: 'Dompet kamu sudah aktif, nggak perlu daftar lagi.' },
        { status: 409 },
      );
    }

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: new Uint8Array(Buffer.from(user.id)),
      userName: user.username ? `@${user.username}` : `user-${user.id}`,
      userDisplayName: user.firstName || user.username || 'Anggota Circa',
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'preferred',
      },
      // ES256 / secp256r1 only — this is what the passkey_wallet contract
      // verifies on-chain. Offering an algorithm the contract cannot check
      // would produce a wallet nobody can spend from.
      supportedAlgorithmIDs: [-7],
    });

    // Upsert rather than insert: a user who abandons the prompt and retries
    // should simply get a fresh challenge, not a primary-key collision.
    const { error: storeError } = await supabase
      .from('webauthn_challenges')
      .upsert({
        telegram_id: user.id,
        challenge: options.challenge,
        expires_at: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
      });

    if (storeError) {
      console.error('Failed to persist WebAuthn challenge:', storeError);
      // Fail closed. Returning options whose challenge was never stored
      // would produce a ceremony that can never verify.
      return NextResponse.json(
        { error: 'Gagal menyiapkan pendaftaran. Coba lagi ya.' },
        { status: 500 },
      );
    }

    return NextResponse.json(options);
  } catch (error) {
    console.error('generate-registration-options failed:', error);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}
