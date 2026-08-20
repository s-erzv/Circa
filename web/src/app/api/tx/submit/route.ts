import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { submitRelay } from '@/lib/soroban/tx-relay';

/**
 * Submits the transaction `relayId` points at, with the client's
 * passkey-signed auth entry inserted.
 *
 * Deliberately does NOT re-check which wallet the signature belongs to:
 * that check already happened in `/api/tx/prepare` (the auth entry handed
 * back there was scoped to the caller's own wallet), and the entry itself
 * is only valid if its signature verifies against the specific payload
 * `authorizeEntry` computed for it — a caller cannot submit a signature for
 * someone else's entry and have it succeed, because they were never handed
 * one. This route still requires a verified caller so it cannot be used as
 * an anonymous submission relay.
 *
 * There is deliberately no `txXdr` field on this request at all — see
 * `tx-relay.ts`'s module comment for why accepting one would make this an
 * open relay regardless of any other check.
 */
export async function POST(request: Request) {
  try {
    await requireUser(request);
  } catch {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const { relayId, signedAuthEntryXdr } = await request.json();
    if (typeof relayId !== 'string' || typeof signedAuthEntryXdr !== 'string') {
      return NextResponse.json({ error: 'invalid request' }, { status: 400 });
    }

    const result = await submitRelay(relayId, signedAuthEntryXdr);
    if (result.status === 'FAILED') {
      return NextResponse.json(
        { error: 'Transaksi gagal di jaringan.', hash: result.hash },
        { status: 502 },
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error('tx/submit failed:', error);
    return NextResponse.json(
      { error: 'Gagal ngirim transaksi. Coba lagi ya.' },
      { status: 500 },
    );
  }
}
