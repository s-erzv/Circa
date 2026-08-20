import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { getPool } from '@/lib/pools';
import { deployPoolContract, prepareCreatePool } from '@/lib/soroban/pool';

/**
 * Deploys the pool's contract (if it doesn't have one yet) and prepares the
 * organizer-signed `create()` call, returning the same shape
 * `/api/tx/prepare` does so the client's existing sign-and-submit flow
 * handles it unmodified.
 *
 * Organizer-only: only the person who ran /mulai for this draft may deploy
 * it. Idempotent on the deploy half — if a previous attempt got a contract
 * id but the organizer never completed signing `create()`, this reuses that
 * contract rather than deploying a second one and orphaning the first.
 */
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
  const pool = await getPool(id);
  if (!pool) {
    return NextResponse.json({ error: 'Arisan tidak ditemukan.' }, { status: 404 });
  }
  if (pool.organizer_telegram_id !== user.id) {
    return NextResponse.json(
      { error: 'Cuma yang bikin draf ini yang bisa konfirmasi.' },
      { status: 403 },
    );
  }
  if (!['draft', 'deploying'].includes(pool.status)) {
    return NextResponse.json(
      { error: 'Arisan ini sudah dibuat sebelumnya.' },
      { status: 409 },
    );
  }
  if (
    !pool.member_count ||
    !pool.contribution_amount ||
    !pool.cycle_length_secs ||
    !pool.deadline_offset_secs ||
    pool.penalty_amount == null ||
    pool.exit_penalty_amount == null ||
    pool.reserve_bps == null
  ) {
    return NextResponse.json({ error: 'Draf arisan belum lengkap.' }, { status: 409 });
  }

  const { data: userRow } = await supabase
    .from('users')
    .select('wallet_address')
    .eq('telegram_id', user.id)
    .maybeSingle();
  if (!userRow?.wallet_address) {
    return NextResponse.json({ error: 'Kamu belum punya dompet.' }, { status: 409 });
  }

  const tokenAddress = process.env.ARISAN_TOKEN_ADDRESS;
  if (!tokenAddress) {
    return NextResponse.json(
      { error: 'internal: ARISAN_TOKEN_ADDRESS not configured' },
      { status: 500 },
    );
  }

  try {
    let contractId = pool.contract_id;
    if (!contractId) {
      contractId = await deployPoolContract();
      await supabase
        .from('pools')
        .update({ contract_id: contractId, status: 'deploying' })
        .eq('id', id);
    }

    const prepared = await prepareCreatePool(contractId, {
      organizer: userRow.wallet_address,
      token: tokenAddress,
      contributionAmount: String(pool.contribution_amount),
      memberCount: pool.member_count,
      cycleLengthSecs: pool.cycle_length_secs,
      deadlineOffsetSecs: pool.deadline_offset_secs,
      penaltyAmount: String(pool.penalty_amount),
      exitPenaltyAmount: String(pool.exit_penalty_amount),
      reserveBps: pool.reserve_bps,
    });

    return NextResponse.json(prepared);
  } catch (error) {
    console.error('pool deploy failed:', error);
    return NextResponse.json(
      { error: 'Gagal bikin kontrak arisan. Coba lagi ya.' },
      { status: 500 },
    );
  }
}
