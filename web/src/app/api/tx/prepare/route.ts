import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { assertRelayActionShape, prepareRelay } from '@/lib/soroban/tx-relay';

/**
 * Builds and simulates a sponsor-paid Soroban transaction for one
 * allowlisted arisan action, returning only a handle to it plus the
 * caller's own unsigned auth entry for them to sign with their passkey.
 *
 * Two checks stand between this and being an open relay, both required:
 *
 *  - The `member` address in the request must belong to the verified
 *    caller — checked against `users.wallet_address`, not trusted from the
 *    body. Without this, any caller could ask the sponsor to prepare a
 *    transaction claiming to act as someone else's wallet.
 *
 *  - The `poolId` must be a contract this app actually deployed — checked
 *    against `pools.contract_id`, not trusted from the body. Without this,
 *    a caller could point `join`/`contribute` at any arbitrary contract
 *    address with a same-shaped method (`fn(member: Address)`) — including
 *    one they deployed themselves — and get the sponsor to pay fees to
 *    invoke it. `buildInvocation`'s method allowlist alone is not enough;
 *    it constrains *which method name* runs, not *which contract*.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireUser(request);
  } catch {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const action = assertRelayActionShape(body);

    const { data } = await supabase
      .from('users')
      .select('wallet_address')
      .eq('telegram_id', user.id)
      .maybeSingle();

    if (!data?.wallet_address) {
      return NextResponse.json(
        { error: 'Kamu belum punya dompet.' },
        { status: 409 },
      );
    }
    let actionAuthAddress: string | null = null;
    if ('member' in action) actionAuthAddress = action.member;
    else if ('requester' in action && action.kind !== 'pool_accept_priority_swap') actionAuthAddress = action.requester;
    else if ('target' in action) actionAuthAddress = action.target;
    else if ('organizer' in action) actionAuthAddress = action.organizer;

    if (!actionAuthAddress || data.wallet_address !== actionAuthAddress) {
      return NextResponse.json(
        { error: 'Alamat dompet tidak sesuai dengan permintaan transaksi.' },
        { status: 403 },
      );
    }

    const { data: pool } = await supabase
      .from('pools')
      .select('status')
      .eq('contract_id', action.poolId)
      .maybeSingle();

    if (!pool) {
      return NextResponse.json({ error: 'Arisan tidak ditemukan.' }, { status: 404 });
    }
    if (!['forming', 'active'].includes(pool.status)) {
      return NextResponse.json(
        { error: 'Arisan ini belum atau tidak lagi bisa dijalankan.' },
        { status: 409 },
      );
    }

    const prepared = await prepareRelay(action);
    return NextResponse.json(prepared);
  } catch (error) {
    console.error('tx/prepare failed:', error);
    return NextResponse.json(
      { error: 'Gagal menyiapkan transaksi. Coba lagi ya.' },
      { status: 500 },
    );
  }
}
