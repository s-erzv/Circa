import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { getPendingPrioritySwap } from '@/lib/soroban/read';

/**
 * Every open bid on the caller's own front-of-queue slot, highest first.
 * The contract only ever lets `accept_priority_swap` succeed for whichever
 * bid is currently highest (see priority.rs) — sorting here just makes that
 * rule visible before the caller commits to accepting one.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try {
    user = await requireUser(request);
  } catch {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  const { data: pool } = await supabase
    .from('pools')
    .select('contract_id')
    .eq('id', id)
    .maybeSingle();

  if (!pool?.contract_id) {
    return NextResponse.json({ error: 'Pool not found.' }, { status: 404 });
  }

  const { data: userData } = await supabase
    .from('users')
    .select('wallet_address')
    .eq('telegram_id', user.id)
    .maybeSingle();

  if (!userData?.wallet_address) {
    return NextResponse.json({ error: 'Wallet not configured.' }, { status: 409 });
  }

  const bids = await getPendingPrioritySwap(pool.contract_id, userData.wallet_address);
  if (bids.length === 0) {
    return NextResponse.json({ bids: [] });
  }

  const { data: requesterUsers } = await supabase
    .from('users')
    .select('wallet_address, telegram_username')
    .in('wallet_address', bids.map((b) => b.requester));

  const sorted = [...bids].sort((a, b) => Number(BigInt(b.fee) - BigInt(a.fee)));

  return NextResponse.json({
    bids: sorted.map((bid, i) => {
      const requesterUser = requesterUsers?.find((u) => u.wallet_address === bid.requester);
      return {
        requester: bid.requester,
        requesterName: requesterUser?.telegram_username ?? bid.requester.slice(0, 8) + '...',
        fee: bid.fee,
        isHighest: i === 0,
      };
    }),
  });
}
