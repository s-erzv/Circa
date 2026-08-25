import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { getPendingPrioritySwap } from '@/lib/soroban/read';

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
    .single();

  if (!pool || !pool.contract_id) {
    return NextResponse.json({ error: 'Pool not found.' }, { status: 404 });
  }

  const { data: userData } = await supabase
    .from('users')
    .select('wallet_address')
    .eq('telegram_id', user.id)
    .single();

  if (!userData?.wallet_address) {
    return NextResponse.json({ error: 'Wallet not configured.' }, { status: 409 });
  }

  const pending = await getPendingPrioritySwap(pool.contract_id, userData.wallet_address);
  
  if (!pending) {
    return NextResponse.json({ pending: null });
  }

  const { data: requesterUser } = await supabase
    .from('users')
    .select('telegram_username')
    .eq('wallet_address', pending.requester)
    .maybeSingle();

  return NextResponse.json({
    pending: {
      requester: pending.requester,
      requesterName: requesterUser?.telegram_username ?? pending.requester.slice(0, 8) + '...',
      fee: pending.fee,
    }
  });
}
