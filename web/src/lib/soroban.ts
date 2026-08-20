import { xdr } from '@stellar/stellar-sdk';
import { deployContract } from './soroban/deploy';

export async function deployPasskeyWallet(pkHex: string): Promise<string> {
  const wasmHashHex = process.env.PASSKEY_WALLET_WASM_HASH;
  if (!wasmHashHex) throw new Error('PASSKEY_WALLET_WASM_HASH is not configured');

  // Constructor for passkey_wallet: (pk: BytesN<65>) — 65-byte uncompressed
  // secp256r1 public key from the client.
  const pkBytes = Buffer.from(pkHex, 'hex');
  return deployContract(wasmHashHex, [xdr.ScVal.scvBytes(pkBytes)]);
}
