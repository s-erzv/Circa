import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { runDistribute } from '@/lib/soroban/cycle';
import { getPool } from '@/lib/soroban/read';
import { bot } from '@/lib/bot';

export async function POST(
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
    .select('contract_id, telegram_chat_id')
    .eq('id', id)
    .single();

  if (!pool || !pool.contract_id) {
    return NextResponse.json({ error: 'Pool not found or not active.' }, { status: 404 });
  }

  try {
    const distributed = await runDistribute(pool.contract_id);
    return NextResponse.json({ success: true, recipient: distributed.recipient });
  } catch (err) {
    console.error('Failed to distribute:', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
