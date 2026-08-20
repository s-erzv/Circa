import { Contract, Keypair, Networks, TransactionBuilder, nativeToScVal, rpc } from '@stellar/stellar-sdk';

const RPC_URL = process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = Networks.TESTNET;

/**
 * The QRIS→Stellar bridge. This is the ONE place in the app where an
 * off-chain event (a confirmed bank/e-wallet payment, attested by Xendit)
 * turns into an on-chain balance change — everything downstream of this
 * function (contribute, join, vote, payout) is enforced entirely by the
 * contracts and needs no further trust in this backend.
 *
 * Deliberately narrow and explicit about what it is: the issuer account
 * signs a transfer of Circa's own testnet IDRT to the payer's wallet. This
 * is a demo/testnet bridge suitable for proving the flow works, NOT a
 * licensed money-service integration — issuing an IDR-pegged asset backed
 * by real QRIS collections in production requires being (or partnering
 * with) a licensed PJSP. Swapping this out for a real Stellar SEP-24 anchor
 * later, once one exists for IDR, does not touch any other part of the
 * app: the pool contracts only ever see "a token arrived", never how.
 */
export async function mintIdrt(toWallet: string, amountIdr: number): Promise<string> {
  const secret = process.env.IDRT_ISSUER_SECRET;
  const tokenAddress = process.env.IDRT_TOKEN_ADDRESS;
  if (!secret) throw new Error('IDRT_ISSUER_SECRET is not configured');
  if (!tokenAddress) throw new Error('IDRT_TOKEN_ADDRESS is not configured');

  const rpcServer = new rpc.Server(RPC_URL);
  const issuer = Keypair.fromSecret(secret);
  const issuerAccount = await rpcServer.getAccount(issuer.publicKey());

  const contract = new Contract(tokenAddress);
  const tx = new TransactionBuilder(issuerAccount, {
    fee: '1000000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        'transfer',
        nativeToScVal(issuer.publicKey(), { type: 'address' }),
        nativeToScVal(toWallet, { type: 'address' }),
        nativeToScVal(BigInt(amountIdr), { type: 'i128' }),
      ),
    )
    .setTimeout(60)
    .build();

  // The issuer transferring its own freshly-issued asset needs only the
  // issuer's own signature — no third-party auth entry to assemble, unlike
  // the relay's member-signed calls.
  const prepared = await rpcServer.prepareTransaction(tx);
  prepared.sign(issuer);

  const sendResult = await rpcServer.sendTransaction(prepared);
  if (sendResult.status === 'ERROR') {
    throw new Error(`mint failed: ${JSON.stringify(sendResult)}`);
  }

  for (let i = 0; i < 20; i++) {
    const status = await rpcServer.getTransaction(sendResult.hash);
    if (status.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return sendResult.hash;
    }
    if (status.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`mint transaction failed on-chain: ${sendResult.hash}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('mint transaction confirmation timed out');
}
