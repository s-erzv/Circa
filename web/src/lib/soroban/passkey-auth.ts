'use client';

import {
  authorizeEntry,
  hash,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import {
  base64URLStringToBuffer,
  bufferToBase64URLString,
  startAuthentication,
} from '@simplewebauthn/browser';
import { derSignatureToRaw } from './der';

/**
 * Signs one Soroban authorization entry with the user's passkey.
 *
 * This is the client-side half of `passkey_wallet`'s custom account scheme
 * (`contracts/passkey-wallet/src/lib.rs`). `__check_auth` on that contract
 * expects a `Signature` struct — `authenticator_data`, `client_data_json`,
 * and a raw 64-byte `signature` — not a plain keypair signature, so this
 * cannot use `@stellar/stellar-sdk`'s default signing path.
 *
 * `authorizeEntry` computes the exact 32-byte payload the contract will
 * receive as `signature_payload` and hands it to this callback; what comes
 * back here is used AS-IS as the entry's signature ScVal, so its shape must
 * match the contract's `Signature` struct exactly (field names, in
 * alphabetical order, mirroring how `#[contracttype]` serializes a struct).
 *
 * The payload is signed by treating it as a WebAuthn assertion challenge:
 * the browser signs `authenticatorData ‖ SHA-256(clientDataJSON)`, and
 * `clientDataJSON.challenge` is required to equal base64url(payload) — the
 * contract checks precisely that binding, which is what stops a signature
 * collected for one transaction from authorizing a different one.
 */
export async function signSorobanAuthEntry(
  entry: xdr.SorobanAuthorizationEntry,
  opts: {
    validUntilLedgerSeq: number;
    networkPassphrase: string;
    credentialId: string;
  },
): Promise<xdr.SorobanAuthorizationEntry> {
  return authorizeEntry(
    entry,
    async (_preimage, payload) => {
      // `payload` arrives as a Node `Buffer` (per stellar-sdk's type), which
      // is a view over an ArrayBuffer but not structurally one — copy into a
      // fresh Uint8Array first so its `.buffer` is a plain ArrayBuffer, the
      // type `bufferToBase64URLString` actually wants.
      const challenge = bufferToBase64URLString(Uint8Array.from(payload).buffer);

      const assertion = await startAuthentication({
        optionsJSON: {
          challenge,
          rpId: window.location.hostname,
          allowCredentials: [{ id: opts.credentialId, type: 'public-key' }],
          userVerification: 'preferred',
          timeout: 60_000,
        },
      });

      const authenticatorData = new Uint8Array(
        base64URLStringToBuffer(assertion.response.authenticatorData),
      );
      const clientDataJSON = new Uint8Array(
        base64URLStringToBuffer(assertion.response.clientDataJSON),
      );
      const derSignature = new Uint8Array(
        base64URLStringToBuffer(assertion.response.signature),
      );
      const rawSignature = derSignatureToRaw(derSignature);

      const signatureScVal = nativeToScVal(
        {
          authenticator_data: authenticatorData,
          client_data_json: clientDataJSON,
          signature: rawSignature,
        },
        {
          type: {
            authenticator_data: ['symbol', null],
            client_data_json: ['symbol', null],
            signature: ['symbol', null],
          },
        },
      );

      return { signatureScVal };
    },
    opts.validUntilLedgerSeq,
    opts.networkPassphrase,
  );
}

export { hash };
