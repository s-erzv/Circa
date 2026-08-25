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

/**
 * The rules governing one arisan, in plain language, using its actual
 * configured numbers — not a generic explainer. Shared by the `/aturan` bot
 * command and the Mini App's rules page so the two never drift apart.
 *
 * Every clause here reflects something actually enforced on-chain today
 * (verified against the current contract, not aspirational): the reserve
 * split on close (cycle.rs's distribute()), the auction-only-on-queue[0]
 * restriction (priority.rs), the debt-blocks-exit guard regardless of
 * payout status (exit.rs) — this list should be updated whenever any of
 * those actually change, not treated as fixed copy.
 */
export function formatArisanRules(pool: PoolRow): string {
  const cycleDays = pool.cycle_length_secs ? Math.round(pool.cycle_length_secs / 86400) : null;
  const deadlineDays = pool.deadline_offset_secs
    ? Math.round(pool.deadline_offset_secs / 86400)
    : null;
  const amount = pool.contribution_amount ?? 0;
  const penalty = pool.penalty_amount ?? 0;
  const exitPenalty = pool.exit_penalty_amount ?? 0;
  const reservePct = pool.reserve_bps != null ? (pool.reserve_bps / 100).toString() : '?';

  return (
    `Aturan main "${pool.name}":\n\n` +
    `Setoran\n` +
    `• Rp${amount.toLocaleString('id-ID')} tiap ${cycleDays ?? '?'} hari, langsung lewat QRIS — nggak perlu tanda tangan, bayar itu sendiri udah jadi buktinya.\n` +
    `• Batas kumpul: ${deadlineDays ?? '?'} hari sebelum dianggap telat.\n\n` +
    `Telat setor\n` +
    `• Kena denda Rp${penalty.toLocaleString('id-ID')}, masuk kas cadangan.\n\n` +
    `Kocokan giliran\n` +
    `• Diacak ulang tiap kali ada yang cair — cuma urutan siklus BERIKUTNYA yang pasti, bukan urutan satu musim penuh.\n\n` +
    `Tukar giliran (Piauw)\n` +
    `• Cuma bisa nawar buat posisi paling depan (satu-satunya yang beneran pasti).\n` +
    `• Boleh lebih dari satu orang nawar bareng — yang berlaku cuma tawaran tertinggi, otomatis, bukan pilihan orangnya.\n` +
    `• Kalah tawar? Fee balik utuh.\n\n` +
    `Keluar di tengah jalan\n` +
    `• Udah pernah dapet giliran: bebas keluar, nggak ada refund maupun potongan.\n` +
    `• Belum dapet giliran, udah setor siklus ini: setoran balik dikurangi potongan Rp${exitPenalty.toLocaleString('id-ID')}.\n` +
    `• Belum dapet giliran, belum setor siklus ini: keluar gratis.\n` +
    `• Masih punya utang (dari denda telat): harus dilunasi dulu sebelum bisa keluar — nggak bisa kabur bawa utang.\n\n` +
    `Kas cadangan\n` +
    `• ${reservePct}% dari tiap pencairan disisihkan buat nutupin kalau ada yang nunggak.\n` +
    `• Sisanya dibagi rata ke semua anggota begitu arisan ini kelar.\n\n` +
    `Keputusan soal keluarin/skip anggota diputusin lewat voting, bukan sepihak organizer.`
  );
}

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

/**
 * The one non-closed pool for a group chat — `pools_one_live_per_chat`
 * (migration 004) guarantees there's at most one, so "the arisan in this
 * group" is a well-defined thing to ask for.
 */
export async function getLivePoolForChat(chatId: string): Promise<PoolRow | null> {
  const { data } = await supabase
    .from('pools')
    .select('*')
    .eq('telegram_chat_id', chatId)
    .neq('status', 'closed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
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
