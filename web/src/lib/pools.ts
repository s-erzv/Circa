import { supabase } from './supabase';

export type PoolRow = {
  id: string;
  contract_id: string | null;
  name: string;
  description: string | null;
  organizer_id: string;
  telegram_chat_id: string | null;
  status: 'draft' | 'deploying' | 'forming' | 'active' | 'closed';
  organizer_telegram_id: string | null;
  token_address: string | null;
  contribution_amount: number | null;
  member_count: number | null;
  cycle_length_secs: number | null;
  deadline_offset_secs: number | null;
  penalty_amount: number | null;
  exit_penalty_amount: number | null;
  reserve_bps: number | null;
};

export type DraftTerms = {
  name: string;
  memberCount: number;
  contributionAmount: number;
  cycleLengthSecs: number;
  deadlineOffsetSecs: number;
  penaltyAmount: number;
  exitPenaltyAmount: number;
  reserveBps: number;
};

/**
 * Creates a draft arisan straight from the group conversation. No contract
 * exists yet — `contract_id` stays null until the organizer completes the
 * signed deploy+create flow in the Mini App (see `/api/pools/[id]/deploy`).
 * This split exists because create() needs a real passkey signature, which
 * a Telegram chat message cannot produce.
 */
export async function createDraftPool(
  organizerUserId: string,
  organizerTelegramId: string,
  telegramChatId: string,
  terms: DraftTerms,
): Promise<PoolRow> {
  const { data, error } = await supabase
    .from('pools')
    .insert({
      name: terms.name,
      description: null,
      organizer_id: organizerUserId,
      organizer_telegram_id: organizerTelegramId,
      telegram_chat_id: telegramChatId,
      status: 'draft',
      contract_id: null,
      member_count: terms.memberCount,
      contribution_amount: terms.contributionAmount,
      cycle_length_secs: terms.cycleLengthSecs,
      deadline_offset_secs: terms.deadlineOffsetSecs,
      penalty_amount: terms.penaltyAmount,
      exit_penalty_amount: terms.exitPenaltyAmount,
      reserve_bps: terms.reserveBps,
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`failed to create draft pool: ${error?.message}`);
  }
  return data;
}

export async function getPool(id: string): Promise<PoolRow | null> {
  const { data } = await supabase.from('pools').select('*').eq('id', id).maybeSingle();
  return data;
}

export async function listInterestedCount(poolId: string): Promise<number> {
  const { count } = await supabase
    .from('pool_members')
    .select('*', { count: 'exact', head: true })
    .eq('pool_id', poolId)
    .eq('status', 'interested');
  return count ?? 0;
}

export async function markInterested(
  poolId: string,
  telegramId: string,
): Promise<void> {
  await supabase
    .from('pool_members')
    .upsert(
      { pool_id: poolId, telegram_id: telegramId, status: 'interested' },
      { onConflict: 'pool_id,telegram_id', ignoreDuplicates: true },
    );
}

export async function isInterested(
  poolId: string,
  telegramId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('pool_members')
    .select('status')
    .eq('pool_id', poolId)
    .eq('telegram_id', telegramId)
    .maybeSingle();
  return Boolean(data);
}

export async function getMemberStatus(
  poolId: string,
  telegramId: string,
): Promise<'interested' | 'joined' | null> {
  const { data } = await supabase
    .from('pool_members')
    .select('status')
    .eq('pool_id', poolId)
    .eq('telegram_id', telegramId)
    .maybeSingle();
  return (data?.status as 'interested' | 'joined' | undefined) ?? null;
}

export async function markJoinedOnChain(
  poolId: string,
  telegramId: string,
): Promise<void> {
  await supabase
    .from('pool_members')
    .update({ status: 'joined', joined_at: new Date().toISOString() })
    .eq('pool_id', poolId)
    .eq('telegram_id', telegramId);
}
