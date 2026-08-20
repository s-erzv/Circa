import { describe, expect, test } from 'vitest';
import { createSign, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { derSignatureToRaw } from './der';

describe('derSignatureToRaw', () => {
  test('round-trips a real P-256 ECDSA signature end to end', () => {
    // The strongest test available without a browser: generate a real
    // secp256r1 keypair (same curve WebAuthn uses), sign real DER-encoded
    // data with it (what the browser hands back), convert with the function
    // under test, then verify the RAW signature with Node's own IEEE P1363
    // verifier. If conversion is wrong in any way — wrong byte order, wrong
    // padding, r/s swapped — this fails.
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });

    const message = Buffer.from('circa arisan payload under test');
    const derSignature = createSign('SHA256').update(message).sign(privateKey);

    const raw = derSignatureToRaw(new Uint8Array(derSignature));
    expect(raw.length).toBe(64);

    const verified = cryptoVerify(
      'SHA256',
      message,
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(raw),
    );
    expect(verified).toBe(true);
  });

  test('handles a DER integer with a leading 0x00 sign-guard byte', () => {
    // r = 0x00 followed by a byte whose high bit is set (0xF0...), forcing
    // DER to insert a sign-guard byte to keep the INTEGER non-negative.
    const r = new Uint8Array(33);
    r[0] = 0x00;
    r.fill(0xf0, 1);
    const s = new Uint8Array(32).fill(0x01);

    const der = encodeDerSequence(r, s);
    const raw = derSignatureToRaw(der);

    expect(raw.length).toBe(64);
    // The sign-guard byte must be stripped, leaving exactly the 32 real
    // bytes of r, unpadded further (it was already 32 bytes without the
    // guard).
    expect(Array.from(raw.slice(0, 32))).toEqual(Array.from(r.slice(1)));
    expect(Array.from(raw.slice(32))).toEqual(Array.from(s));
  });

  test('left-pads a DER integer shorter than 32 bytes', () => {
    // A small s value serializes as fewer than 32 bytes in DER (leading
    // zero bits are dropped); the raw format must zero-pad it back out.
    const r = new Uint8Array(32).fill(0x02);
    const s = new Uint8Array([0x01, 0x23]); // tiny value, 2 bytes in DER

    const der = encodeDerSequence(r, s);
    const raw = derSignatureToRaw(der);

    expect(raw.length).toBe(64);
    expect(Array.from(raw.slice(32, 62))).toEqual(new Array(30).fill(0));
    expect(Array.from(raw.slice(62))).toEqual([0x01, 0x23]);
  });

  test('rejects a buffer that is not a DER SEQUENCE', () => {
    expect(() => derSignatureToRaw(new Uint8Array([0x02, 0x01, 0x00]))).toThrow(
      /SEQUENCE/,
    );
  });
});

/** Hand-rolled minimal DER SEQUENCE{INTEGER r, INTEGER s} encoder, used only
 *  to build synthetic test vectors for edge cases real signatures won't
 *  reliably hit (leading-zero-guard, short components). */
function encodeDerSequence(r: Uint8Array, s: Uint8Array): Uint8Array {
  const encodeInteger = (bytes: Uint8Array) =>
    Uint8Array.from([0x02, bytes.length, ...bytes]);
  const rEnc = encodeInteger(r);
  const sEnc = encodeInteger(s);
  const body = Uint8Array.from([...rEnc, ...sEnc]);
  return Uint8Array.from([0x30, body.length, ...body]);
}
