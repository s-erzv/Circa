import { createHash, randomBytes } from 'node:crypto';
import {
  Address,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';

const RPC_URL = process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = Networks.TESTNET;

function server(): rpc.Server {
  return new rpc.Server(RPC_URL);
}

function sponsor(): Keypair {
  const secret = process.env.STELLAR_SPONSOR_SECRET;
  if (!secret) throw new Error('STELLAR_SPONSOR_SECRET is not configured');
  return Keypair.fromSecret(secret);
}

async function pollTransaction(
  rpcServer: rpc.Server,
  hash: string,
): Promise<rpc.Api.GetTransactionResponse> {
  for (let i = 0; i < 15; i++) {
    const status = await rpcServer.getTransaction(hash);
    if (status.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('deploy transaction timed out waiting for confirmation');
}

/**
 * Deploys a fresh instance of an already-uploaded wasm blob, sponsor-paid,
 * and returns the new contract's id.
 *
 * Shared by every "spin up a new contract instance for this user/group"
 * flow in the app (a passkey wallet, an arisan pool). `constructorArgs` is
 * empty for contracts like `ArisanPool` that use a separate `create()` call
 * instead of `__constructor` — the two are not interchangeable at the
 * contract level, but deployment itself works the same way either way.
 */
export async function deployContract(
  wasmHashHex: string,
  constructorArgs: xdr.ScVal[],
): Promise<string> {
  const rpcServer = server();
  const sponsorKp = sponsor();
  const sourceAccount = await rpcServer.getAccount(sponsorKp.publicKey());
  const wasmHash = Buffer.from(wasmHashHex, 'hex');
  const salt = randomBytes(32);

  const contractIdPreimage = xdr.ContractIdPreimage.contractIdPreimageFromAddress(
    new xdr.ContractIdPreimageFromAddress({
      address: Address.fromString(sponsorKp.publicKey()).toScAddress(),
      salt,
    }),
  );

  const deployOp = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeCreateContractV2(
      new xdr.CreateContractArgsV2({
        contractIdPreimage,
        executable: xdr.ContractExecutable.contractExecutableWasm(wasmHash),
        constructorArgs,
      }),
    ),
    auth: [],
  });

  const tx = new TransactionBuilder(sourceAccount, {
    fee: '10000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(deployOp)
    .setTimeout(30)
    .build();

  const prepared = await rpcServer.prepareTransaction(tx);
  prepared.sign(sponsorKp);

  const sendResult = await rpcServer.sendTransaction(prepared);
  if (sendResult.status === 'ERROR') {
    throw new Error(`deploy failed: ${JSON.stringify(sendResult)}`);
  }

  const result = await pollTransaction(rpcServer, sendResult.hash);
  if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
    throw new Error('deploy transaction failed on-chain');
  }

  // The deployed contract's id is deterministic from the preimage, so it
  // can be computed directly rather than parsed out of transaction meta.
  const networkId = createHash('sha256').update(NETWORK_PASSPHRASE).digest();
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({ networkId, contractIdPreimage }),
  );
  return Address.contract(
    createHash('sha256').update(preimage.toXDR()).digest(),
  ).toString();
}
