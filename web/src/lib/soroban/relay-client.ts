'use client';

import { xdr } from '@stellar/stellar-sdk';
import { apiFetch } from '@/lib/api-client';
import { signSorobanAuthEntry } from './passkey-auth';

import type { ClientRelayAction } from './tx-relay';

type PreparedRelay = {
  relayId: string;
  authEntryXdr: string;
  validUntilLedgerSeq: number;
  networkPassphrase: string;
};

/**
 * Runs one allowlisted on-chain action end to end: ask the server to
 * prepare it, sign the resulting auth entry with the user's passkey, then
 * ask the server to submit it.
 *
 * This is the client-facing entry point every write action (join,
 * contribute, and — once Task 6 wires them up — vote/execute) should go
 * through, so the prepare→sign→submit sequencing and error handling live in
 * one place rather than being re-implemented per action.
 */
export async function relayAction(
  action: ClientRelayAction,
  credentialId: string,
): Promise<{ hash: string }> {
  const prepared = await apiFetch<PreparedRelay>('/api/tx/prepare', {
    method: 'POST',
    body: JSON.stringify(action),
  });

  const unsignedEntry = xdr.SorobanAuthorizationEntry.fromXDR(
    prepared.authEntryXdr,
    'base64',
  );

  const signedEntry = await signSorobanAuthEntry(unsignedEntry, {
    validUntilLedgerSeq: prepared.validUntilLedgerSeq,
    networkPassphrase: prepared.networkPassphrase,
    credentialId,
  });

  const result = await apiFetch<{ status: 'SUCCESS'; hash: string }>(
    '/api/tx/submit',
    {
      method: 'POST',
      body: JSON.stringify({
        relayId: prepared.relayId,
        signedAuthEntryXdr: signedEntry.toXDR('base64'),
      }),
    },
  );

  return { hash: result.hash };
}
