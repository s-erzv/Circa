/**
 * Converts a DER-encoded ECDSA signature (what WebAuthn / the Web
 * Authentication API always returns) into the raw 64-byte r‖s format that
 * `secp256r1_verify` on-chain expects.
 *
 * DER shape: `SEQUENCE { INTEGER r, INTEGER s }`. Each INTEGER may carry a
 * leading 0x00 byte (when the high bit of the value would otherwise be
 * mistaken for a sign bit) or be shorter than 32 bytes (when the value has
 * leading zero bits) — both are normalized away here, since the on-chain
 * side wants exactly 32 bytes per component, always unsigned, always
 * fixed-width.
 */
export function derSignatureToRaw(der: Uint8Array): Uint8Array {
  let offset = 0;

  function expect(byte: number, what: string): void {
    if (der[offset] !== byte) {
      throw new Error(`derSignatureToRaw: expected ${what} at offset ${offset}`);
    }
    offset += 1;
  }

  function readLength(): number {
    const first = der[offset];
    offset += 1;
    if ((first & 0x80) === 0) return first;
    const numBytes = first & 0x7f;
    let len = 0;
    for (let i = 0; i < numBytes; i++) {
      len = (len << 8) | der[offset];
      offset += 1;
    }
    return len;
  }

  function readInteger(): Uint8Array {
    expect(0x02, 'INTEGER tag');
    const len = readLength();
    let bytes = der.slice(offset, offset + len);
    offset += len;

    // Strip a single leading 0x00 sign-guard byte, if present.
    if (bytes.length > 32 && bytes[0] === 0x00) {
      bytes = bytes.slice(1);
    }
    if (bytes.length > 32) {
      throw new Error('derSignatureToRaw: integer component wider than 32 bytes');
    }
    // Left-pad to exactly 32 bytes.
    const padded = new Uint8Array(32);
    padded.set(bytes, 32 - bytes.length);
    return padded;
  }

  expect(0x30, 'SEQUENCE tag');
  readLength();
  const r = readInteger();
  const s = readInteger();

  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}
