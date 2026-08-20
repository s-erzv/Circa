import { NextResponse } from 'next/server';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { deployPasskeyWallet } from '@/lib/soroban';
import { requireUser } from '@/lib/session';
import { supabase } from '@/lib/supabase';

const origin = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const rpID = new URL(origin).hostname;

/**
 * Extracts the raw 65-byte uncompressed secp256r1 public key from a COSE
 * key, which is the format `passkey_wallet`'s constructor expects.
 *
 * COSE labels -2 and -3 hold the X and Y coordinates. In the CBOR encoding
 * these appear as `21 5820 <32 bytes>` and `22 5820 <32 bytes>`.
 */
function coseToUncompressedPublicKey(cose: Uint8Array): string {
  const hex = Buffer.from(cose).toString('hex');
  const xIndex = hex.indexOf('215820');
  const yIndex = hex.indexOf('225820');
  if (xIndex === -1 || yIndex === -1) {
    throw new Error('Invalid COSE key: expected a secp256r1 key');
  }
  const x = hex.substring(xIndex + 6, xIndex + 6 + 64);
  const y = hex.substring(yIndex + 6, yIndex + 6 + 64);
  if (x.length !== 64 || y.length !== 64) {
    throw new Error('Invalid COSE key: truncated coordinates');
  }
  return `04${x}${y}`;
}

/**
 * Completes the passkey ceremony and binds a freshly deployed wallet.
 *
 * The ordering below is deliberate and security-relevant:
 *   1. verify who is calling — signed initData, or a handoff session cookie
 *      when the ceremony moved to the system browser. Both are verified
 *      server-side against a secret the client never holds; neither is ever
 *      a body or query field,
 *   2. claim the stored challenge, deleting it so it cannot be replayed
 *      even if a later step fails,
 *   3. check it has not expired,
 *   4. verify the WebAuthn response against that challenge,
 *   5. refuse if a wallet already exists,
 *   6. deploy, then bind with a null-guarded UPDATE.
 *
 * Step 6 is conditional rather than a blind update because this field
 * decides where a member's arisan payout lands. Overwriting it is a fund
 * redirection, so it must be impossible by construction, not by convention.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireUser(request);
  } catch {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const { response } = await request.json();
    if (!response) {
      return NextResponse.json({ error: 'missing response' }, { status: 400 });
    }

    // Claim-and-delete: the challenge is single-use. Deleting before
    // verification (rather than after success) means a failed or replayed
    // attempt cannot retry against the same challenge.
    const { data: stored } = await supabase
      .from('webauthn_challenges')
      .select('challenge, expires_at')
      .eq('telegram_id', user.id)
      .maybeSingle();

    await supabase
      .from('webauthn_challenges')
      .delete()
      .eq('telegram_id', user.id);

    if (!stored) {
      return NextResponse.json(
        { error: 'Sesi pendaftaran nggak ketemu. Coba mulai lagi ya.' },
        { status: 400 },
      );
    }

    if (new Date(stored.expires_at).getTime() < Date.now()) {
      return NextResponse.json(
        { error: 'Sesi pendaftaran sudah kedaluwarsa. Coba lagi ya.' },
        { status: 400 },
      );
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: stored.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      });
    } catch (error) {
      console.error('WebAuthn verification failed:', error);
      return NextResponse.json({ error: 'verification failed' }, { status: 400 });
    }

    if (!verification.verified || !verification.registrationInfo) {
      return NextResponse.json({ error: 'verification failed' }, { status: 400 });
    }

    // Re-check immediately before deploying. The generate step also checks
    // this, but the two calls are far apart in wall-clock time (a user can
    // sit on the FaceID prompt), and this is the check that actually
    // guards the write.
    const { data: existing } = await supabase
      .from('users')
      .select('wallet_address')
      .eq('telegram_id', user.id)
      .maybeSingle();

    if (existing?.wallet_address) {
      return NextResponse.json(
        { error: 'Dompet kamu sudah aktif.' },
        { status: 409 },
      );
    }

    const publicKeyHex = coseToUncompressedPublicKey(
      verification.registrationInfo.credential.publicKey,
    );
    const contractId = await deployPasskeyWallet(publicKeyHex);

    // Single-shot binding. `.is('wallet_address', null)` makes this a no-op
    // if anything bound a wallet since the check above, so two concurrent
    // ceremonies cannot both bind — one wins, the other is told so.
    const { data: bound } = await supabase
      .from('users')
      .update({
        wallet_address: contractId,
        public_key: publicKeyHex,
        credential_id: verification.registrationInfo.credential.id,
        counter: verification.registrationInfo.credential.counter,
        wallet_bound_at: new Date().toISOString(),
      })
      .eq('telegram_id', user.id)
      .is('wallet_address', null)
      .select()
      .maybeSingle();

    if (!bound) {
      // The deployed contract is orphaned, which is harmless — it holds no
      // funds and nothing references it. The binding is what matters, and
      // refusing to overwrite is the correct outcome.
      console.warn(
        `Wallet binding lost a race for telegram_id=${user.id}; ` +
          `orphaned contract ${contractId}`,
      );
      return NextResponse.json(
        { error: 'Dompet kamu sudah aktif.' },
        { status: 409 },
      );
    }

    return NextResponse.json({ verified: true, contractId });
  } catch (error) {
    console.error('verify-registration failed:', error);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}
