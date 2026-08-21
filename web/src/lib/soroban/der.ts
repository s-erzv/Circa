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
// secp256r1 (P-256) group order.
const SECP256R1_ORDER = BigInt(
  '0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551',
);
const SECP256R1_ORDER_HALF = SECP256R1_ORDER / BigInt(2);

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = BigInt(0);
  for (const byte of bytes) {
    value = (value << BigInt(8)) | BigInt(byte);
  }
  return value;
}

function bigIntToBytes32(value: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(value & BigInt(0xff));
    value >>= BigInt(8);
  }
  return bytes;
}

/**
 * WebAuthn assertions aren't guaranteed to come back low-S: for any
 * message/key, both `s` and `n - s` are valid ECDSA signatures, and
 * browsers don't pick one consistently. `secp256r1_verify` on-chain
 * enforces the canonical low-S form (`s <= n/2`) as a malleability guard —
 * same convention as Bitcoin/Ethereum — so roughly half of otherwise-valid
 * real signatures fail verification unless flipped here first.
 */
function normalizeLowS(s: Uint8Array): Uint8Array {
  const value = bytesToBigInt(s);
  if (value <= SECP256R1_ORDER_HALF) return s;
  return bigIntToBytes32(SECP256R1_ORDER - value);
}

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
  const s = normalizeLowS(readInteger());

  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}
