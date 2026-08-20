const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Encodes a 32-byte hash as unpadded base64url into `dest`, which must be
/// exactly 43 bytes — the fixed output length for 32 bytes under this
/// encoding (`ceil(32 * 4 / 3)` with no `=` padding). WebAuthn's
/// `clientDataJSON.challenge` is exactly this encoding of the signed
/// payload, so `__check_auth` can compare it byte-for-byte against what it
/// computes here rather than decoding the client-supplied challenge back
/// into bytes.
pub fn encode(dest: &mut [u8], src: &[u8; 32]) {
    let mut di = 0;
    let mut i = 0;
    while i + 3 <= 32 {
        let b0 = src[i];
        let b1 = src[i + 1];
        let b2 = src[i + 2];
        dest[di] = ALPHABET[(b0 >> 2) as usize];
        dest[di + 1] = ALPHABET[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize];
        dest[di + 2] = ALPHABET[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize];
        dest[di + 3] = ALPHABET[(b2 & 0x3f) as usize];
        di += 4;
        i += 3;
    }
    let rem = 32 - i;
    if rem == 1 {
        let b0 = src[i];
        dest[di] = ALPHABET[(b0 >> 2) as usize];
        dest[di + 1] = ALPHABET[((b0 & 0x03) << 4) as usize];
    } else if rem == 2 {
        let b0 = src[i];
        let b1 = src[i + 1];
        dest[di] = ALPHABET[(b0 >> 2) as usize];
        dest[di + 1] = ALPHABET[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize];
        dest[di + 2] = ALPHABET[((b1 & 0x0f) << 2) as usize];
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn encodes_32_zero_bytes() {
        let src = [0u8; 32];
        let mut dest = [0u8; 43];
        encode(&mut dest, &src);
        assert_eq!(&dest, b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    }

    #[test]
    fn encodes_incrementing_bytes_matches_known_vector() {
        let mut src = [0u8; 32];
        for (i, b) in src.iter_mut().enumerate() {
            *b = i as u8;
        }
        let mut dest = [0u8; 43];
        encode(&mut dest, &src);
        // Standard base64url (no padding) of bytes 0x00..0x1f.
        assert_eq!(
            &dest,
            b"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
        );
    }
}
