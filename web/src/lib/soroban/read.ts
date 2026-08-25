import { Address, Contract, Keypair, Networks, TransactionBuilder, rpc, scValToNative } from '@stellar/stellar-sdk';

const RPC_URL = process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = Networks.TESTNET;

/**
 * Calls a read-only contract method and returns its decoded result.
 *
 * A Soroban view call needs no signature and moves nothing, so it never
 * goes through the relay: it's just a simulation, thrown away rather than
 * submitted. The sponsor account is only used as a throwaway transaction
 * source to make the simulation well-formed — nothing about its identity
 * matters or is asserted on-chain.
 */
export async function readContract<T>(
  contractId: string,
  method: string,
  args: Parameters<Contract['call']>[1][] = [],
): Promise<T> {
  const secret = process.env.STELLAR_SPONSOR_SECRET;
  if (!secret) throw new Error('STELLAR_SPONSOR_SECRET is not configured');

  const rpcServer = new rpc.Server(RPC_URL);
  const sponsorKp = Keypair.fromSecret(secret);
  const sourceAccount = await rpcServer.getAccount(sponsorKp.publicKey());

  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simulated = await rpcServer.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulated)) {
    throw new Error(`read ${method} failed: ${simulated.error}`);
  }
  if (!simulated.result) {
    throw new Error(`read ${method} returned no result`);
  }
  return scValToNative(simulated.result.retval) as T;
}

export async function isPoolActivated(poolId: string): Promise<boolean> {
  return readContract<boolean>(poolId, 'is_activated');
}

export async function listPoolMembers(poolId: string): Promise<string[]> {
  return readContract<string[]>(poolId, 'list_members');
}

/** `scValToNative` already decodes nested Address fields in `Pool` to plain
 *  G.../C... strings, so `queue` needs no further conversion. */
export async function getPoolQueue(poolId: string): Promise<string[]> {
  const pool = await readContract<{ queue: string[] }>(poolId, 'get_pool');
  return pool.queue;
}

export type OnChainPool = {
  organizer: string;
  token: string;
  contribution_amount: bigint;
  member_count: number;
  cycle_length_secs: bigint;
  deadline_offset_secs: bigint;
  members: string[];
  queue: string[];
  activated: boolean;
  current_cycle: number;
  cycle_deadline: bigint;
  cycle_pot: bigint;
  reserve_balance: bigint;
  closed: boolean;
};

export async function getPool(poolId: string): Promise<OnChainPool> {
  return readContract<OnChainPool>(poolId, 'get_pool');
}

export type OnChainMember = {
  address: string;
  total_contributed: bigint;
  contributed_this_cycle: boolean;
  penalized_this_cycle: boolean;
  received_payout: boolean;
  balance_owed: bigint;
  delinquent: boolean;
  exited: boolean;
};

export async function getMember(poolId: string, member: string): Promise<OnChainMember> {
  return readContract<OnChainMember>(poolId, 'get_member', [new Address(member).toScVal()]);
}

export type PriorityBid = { requester: string; fee: string };

/**
 * Every open bid on `target`'s front-of-queue slot — a plain array, not one
 * request, since the contract now runs this as an auction: any number of
 * members may bid at once, and only whichever bid is currently highest can
 * ever be accepted (see priority.rs). Empty array means no bids, not `null`.
 */
export async function getPendingPrioritySwap(
  poolId: string,
  targetAddress: string,
): Promise<PriorityBid[]> {
  const { Contract, Address, rpc, xdr, scValToBigInt } = await import('@stellar/stellar-sdk');
  const contract = new Contract(poolId);
  const key = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('PndPriSwap'),
    new Address(targetAddress).toScVal(),
  ]);

  const rpcServer = new rpc.Server(RPC_URL);
  try {
    const entry = await rpcServer.getContractData(contract, key as any);
    const vec = (entry.val as any).vec();
    if (!vec) return [];

    const bids: PriorityBid[] = [];
    for (const bidScVal of vec) {
      const map = (bidScVal as any).map();
      if (!map) continue;
      let requester = '';
      let fee = '0';
      for (const item of map) {
        const sym = item.key().sym().toString();
        if (sym === 'requester') requester = Address.fromScVal(item.val()).toString();
        if (sym === 'fee') fee = scValToBigInt(item.val()).toString();
      }
      bids.push({ requester, fee });
    }
    return bids;
  } catch (e) {
    return [];
  }
}



// -----------------------------------------------------------------------------
// Parsing (ScVal -> JS Objects)
// -----------------------------------------------------------------------------

/**
 * A SEP-41 token's own `balance` — used for the IDRT held directly in a
 * wallet, separate from whatever's already inside a pool contract. The app
 * mints/moves IDRT as raw integer Rupiah (see mint.ts), so this returns the
 * same unscaled units, not 7-decimal stroops.
 */
export async function getTokenBalance(tokenAddress: string, owner: string): Promise<bigint> {
  return readContract<bigint>(tokenAddress, 'balance', [new Address(owner).toScVal()]);
}
