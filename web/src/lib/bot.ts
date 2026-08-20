import { Bot, InlineKeyboard } from 'grammy';
import { supabase } from './supabase';
import { createDraftPool, listInterestedCount, markInterested } from './pools';
import OpenAI from 'openai';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  // Graceful degradation if env not set yet
  console.warn('TELEGRAM_BOT_TOKEN is not set');
}

export const bot = new Bot(token || 'dummy:token');

const webAppUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'circagram_bot';

/**
 * A one-tap button that opens the Mini App *inside* Telegram.
 *
 * This replaces the previous "copy this link and open it in Safari" flow.
 * Besides being the friction users actually complained about, the old flow
 * carried `?id=<telegram_id>` as identity — and Telegram IDs are visible to
 * anyone in the same group, so that URL was an account-takeover primitive.
 * A `web_app` button instead makes Telegram hand the page a signed
 * `initData` payload that the server verifies by HMAC.
 *
 * ONLY valid in messages sent to a PRIVATE chat — Telegram rejects a
 * `web_app` button on any message sent to a group with `BUTTON_TYPE_INVALID`.
 * Use `deepLinkKeyboard` below for group-context messages instead.
 */
export function openAppKeyboard(label: string, path = '/app') {
  return new InlineKeyboard().webApp(label, `${webAppUrl}${path}`);
}

/**
 * A group-safe alternative: a plain `url` button that deep-links into a
 * PRIVATE chat with the bot (`t.me/<bot>?start=<payload>`), where `/start`
 * below reads the payload and sends the real `web_app` button. This is
 * Telegram's own documented pattern for "launch a Mini App from a group
 * message" — a `web_app` button itself cannot appear outside a private
 * chat, but a `url` button pointing at a `?start=` deep link can, and
 * tapping it always opens a private chat regardless of where the button
 * was shown.
 *
 * `payload` must be `[A-Za-z0-9_-]`, Telegram's only allowed charset for a
 * start parameter — a UUID (hex + hyphens) already satisfies this.
 */
export function deepLinkUrl(payload: string) {
  return `https://t.me/${BOT_USERNAME}?start=${payload}`;
}

export function deepLinkKeyboard(label: string, payload: string) {
  return new InlineKeyboard().url(label, deepLinkUrl(payload));
}

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || 'dummy',
  baseURL: 'https://api.groq.com/openai/v1',
});

async function ensureUser(telegramId: string, username: string) {
  let { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (!user) {
    const { data: created } = await supabase
      .from('users')
      .insert([{ telegram_id: telegramId, telegram_username: username }])
      .select()
      .single();
    user = created;
  }
  return user;
}

/**
 * `/start` is also the landing point for every group-message deep link
 * (`deepLinkKeyboard` above) — Telegram always opens a private chat and
 * fires `/start <payload>` here when one of those buttons is tapped,
 * regardless of which group the button was shown in. `ctx.match` carries
 * the payload. This is the ONLY place in the bot that may send a real
 * `web_app` button in response to a group-originated action, because this
 * handler only ever runs in a private chat.
 */
bot.command('start', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  const username = ctx.from?.username || '';
  if (!telegramId) return;

  await ensureUser(telegramId, username);

  const payload = ctx.match?.toString().trim();
  if (payload) {
    const [kind, poolId] = payload.split('_');
    const routes: Record<string, { label: string; path: string }> = {
      confirm: { label: 'Konfirmasi & Buat', path: `/app/pool/${poolId}` },
      join: { label: 'Gabung Resmi', path: `/app/pool/${poolId}/join` },
      setor: { label: 'Setor Sekarang', path: `/app/pool/${poolId}/setor` },
      jadwal: { label: 'Lihat Jadwal', path: `/app/pool/${poolId}/jadwal` },
    };
    const route = poolId ? routes[kind] : undefined;
    if (route) {
      await ctx.reply('Lanjut di sini ya 👇', {
        reply_markup: openAppKeyboard(route.label, route.path),
      });
      return;
    }
  }

  // No wallet is required to get started, and none is created here.
  // ArisanPool::join() moves no tokens — only contribute() does — so the
  // passkey ceremony is deferred until it's actually needed: the first
  // signed on-chain action a member takes (joining an arisan they've
  // decided to commit to, or their first setoran).
  await ctx.reply(
    `Halo @${username || 'teman'}! 👋\n\n` +
      `Circa itu arisan bareng temen-temen, tapi uangnya nggak dipegang ` +
      `satu orang — dipegang kontrak yang aturannya udah disepakati di awal ` +
      `dan nggak bisa diubah diam-diam.\n\n` +
      `Kamu belum perlu bikin dompet atau setor apa-apa sekarang. ` +
      `Tambahin aku ke grup arisan kamu, terus ketik /mulai di sana ya.`,
    { reply_markup: openAppKeyboard('Lihat Arisanku') },
  );
});

/**
 * Introduces the bot the moment it's added to a group — the group is where
 * the whole arisan lifecycle plays out, so this is the real "onboarding"
 * moment, not /start in a private chat.
 */
bot.on('my_chat_member', async (ctx) => {
  const me = ctx.me.id;
  const update = ctx.myChatMember;
  if (update.new_chat_member.user.id !== me) return;

  const wasMember = ['member', 'administrator', 'creator'].includes(
    update.old_chat_member.status,
  );
  const isMember = ['member', 'administrator', 'creator'].includes(
    update.new_chat_member.status,
  );
  if (wasMember || !isMember) return; // only fire on a genuine join

  await ctx.api.sendMessage(
    update.chat.id,
    `Halo semua! 👋 Aku Circa, bakal jadi pemandu arisan di grup ini.\n\n` +
      `Uang arisan nggak dipegang satu orang — dipegang kontrak yang aturannya ` +
      `disepakati di awal dan nggak bisa diubah diam-diam. Kocokan, giliran, ` +
      `sampai keputusan keluarin/skip anggota semuanya tercatat, bukan kata mulut.\n\n` +
      `Siap mulai? Ketik /mulai di grup ini ya.`,
  );
});

type DraftState =
  | { step: 'basic' }
  | { step: 'frequency'; name: string; memberCount: number; contributionAmount: number }
  | {
      step: 'deadline';
      name: string;
      memberCount: number;
      contributionAmount: number;
      cycleLengthSecs: number;
    }
  | {
      step: 'confirm';
      name: string;
      memberCount: number;
      contributionAmount: number;
      cycleLengthSecs: number;
      deadlineOffsetSecs: number;
    };

const draftStates = new Map<string, DraftState>();
function draftKey(chatId: string, telegramId: string) {
  return `${chatId}:${telegramId}`;
}

/**
 * Renders a projected payout calendar: cycle number → approximate date.
 *
 * WHO gets which cycle is decided by the on-chain draw at activation, not
 * here — a draft has no members yet, let alone a queue. What this can
 * honestly tell someone deciding whether to join is the CADENCE: if you're
 * in this arisan, here's roughly when each of the memberCount payouts
 * lands. It's a projection from "now", so it visibly shifts if the pool
 * takes a while to fill — that's accurate, not a bug: the real clock only
 * starts at activation.
 */
function projectScheduleDates(memberCount: number, cycleLengthSecs: number): string[] {
  const fmt = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  const now = Date.now();
  const dates: string[] = [];
  for (let i = 1; i <= memberCount; i++) {
    dates.push(`Siklus ${i}: sekitar ${fmt.format(new Date(now + i * cycleLengthSecs * 1000))}`);
  }
  return dates;
}

async function extractBasicTerms(
  userMessage: string,
): Promise<{ name: string; memberCount: number; contributionAmount: number } | null> {
  const response = await groq.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    messages: [
      {
        role: 'system',
        content:
          'Ekstrak nama arisan, jumlah anggota, dan nominal setoran per orang per siklus ' +
          '(dalam Rupiah) dari pesan user pakai fungsi draft_pool.',
      },
      { role: 'user', content: userMessage },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'draft_pool',
          description: 'Detail dasar arisan',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Nama arisan' },
              member_count: { type: 'integer', description: 'Jumlah anggota' },
              contribution_amount: {
                type: 'integer',
                description: 'Nominal setoran per orang per siklus, dalam Rupiah',
              },
            },
            required: ['name'],
          },
        },
      },
    ],
    tool_choice: 'required',
  });

  const toolCall = response.choices[0].message.tool_calls?.[0];
  if (!toolCall || toolCall.type !== 'function') return null;
  const args = JSON.parse(toolCall.function.arguments);
  if (!args.name) return null;

  return {
    name: String(args.name),
    memberCount: Math.max(2, Number(args.member_count) || 10),
    contributionAmount: Math.max(1, Number(args.contribution_amount) || 100000),
  };
}

/** Converts a free-form answer like "sebulan sekali" or "2 minggu" into a
 *  day count, for both the cycle-frequency and deadline-grace questions —
 *  same shape, different meaning, so one extractor serves both steps. */
async function extractDays(userMessage: string, description: string): Promise<number | null> {
  const response = await groq.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    messages: [
      {
        role: 'system',
        content:
          'Konversi jawaban user jadi jumlah HARI dalam bilangan bulat. ' +
          '"sebulan"/"bulanan" = 30, "2 minggu" = 14, "seminggu"/"mingguan" = 7, ' +
          '"10 hari" = 10, dst. Pakai fungsi extract_days.',
      },
      { role: 'user', content: userMessage },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'extract_days',
          description,
          parameters: {
            type: 'object',
            properties: { days: { type: 'integer', description: 'Jumlah hari' } },
            required: ['days'],
          },
        },
      },
    ],
    tool_choice: 'required',
  });

  const toolCall = response.choices[0].message.tool_calls?.[0];
  if (!toolCall || toolCall.type !== 'function') return null;
  const args = JSON.parse(toolCall.function.arguments);
  const days = Number(args.days);
  return Number.isFinite(days) && days > 0 ? days : null;
}

/**
 * Starts drafting a new arisan as a short, multi-step interview — name,
 * headcount, and nominal first; then how often it collects; then how much
 * grace before a missed setoran counts as late — rather than one message
 * with silent defaults filled in. Nothing here touches the chain: a draft
 * is just a row in Supabase, freely discardable, right up until the
 * organizer's own passkey signature confirms it for real in the Mini App.
 */
bot.command('mulai', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  const chatId = ctx.chat.id.toString();
  if (!telegramId) return;
  if (ctx.chat.type === 'private') {
    await ctx.reply('Ketik /mulai di grup arisan kamu ya, bukan di chat pribadi.');
    return;
  }

  const user = await ensureUser(telegramId, ctx.from?.username || '');
  if (!user) {
    await ctx.reply('Waduh, aku gagal nyimpen datamu. Coba lagi bentar ya 🙏');
    return;
  }

  draftStates.set(draftKey(chatId, telegramId), { step: 'basic' });
  await ctx.reply(
    'Oke, mau bikin arisan kayak gimana? Kasih tau nama, jumlah anggota, ' +
      'dan nominal setorannya ya. Contoh: "Arisan Kantor, 8 orang, setoran 100rb".',
  );
});

bot.on('message:text', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  const chatId = ctx.chat.id.toString();
  if (!telegramId) return;

  const key = draftKey(chatId, telegramId);
  const state = draftStates.get(key);
  if (state) {
    await handleDraftStep(ctx.message.text, ctx, key, state);
    return;
  }

  await handleGeneralMessage(ctx);
});

async function handleDraftStep(
  userMessage: string,
  ctx: { reply: (text: string, extra?: Record<string, unknown>) => Promise<unknown> },
  key: string,
  state: DraftState,
) {
  try {
    if (state.step === 'basic') {
      const parsed = await extractBasicTerms(userMessage);
      if (!parsed) {
        await ctx.reply(
          'Hmm, belum ketangkep. Coba sebutin nama arisan, jumlah anggota, sama ' +
            'nominal setorannya ya — contoh: "Arisan Kantor, 8 orang, setoran 100rb".',
        );
        return;
      }
      draftStates.set(key, { step: 'frequency', ...parsed });
      await ctx.reply(
        `Oke, "${parsed.name}" — ${parsed.memberCount} orang, ` +
          `Rp${parsed.contributionAmount.toLocaleString('id-ID')} per orang.\n\n` +
          'Setorannya tiap berapa lama? (misal: "sebulan sekali", "2 minggu sekali", "tiap 10 hari")',
      );
      return;
    }

    if (state.step === 'frequency') {
      const days = await extractDays(userMessage, 'Jumlah hari per satu siklus setoran');
      if (!days) {
        await ctx.reply('Sori, belum ketangkep. Coba sebutin dalam hari/minggu/bulan ya, misal "sebulan sekali".');
        return;
      }
      draftStates.set(key, { ...state, step: 'deadline', cycleLengthSecs: days * 86400 });
      await ctx.reply(
        `Oke, tiap ${days} hari.\n\n` +
          'Dikasih waktu berapa hari buat kumpulin sebelum dianggap telat? (biasanya 2-3 hari)',
      );
      return;
    }

    if (state.step === 'deadline') {
      const cycleDays = state.cycleLengthSecs / 86400;
      const rawDays = await extractDays(userMessage, 'Jumlah hari batas toleransi sebelum telat');
      // Grace period has to fit inside the cycle it belongs to — clamped
      // rather than rejected, since "kasih waktu sebulan" for a 7-day
      // cycle is a real answer, just one that needs capping to make sense.
      const days = Math.max(1, Math.min(rawDays ?? 3, cycleDays - 1 || 1));

      const next = {
        ...state,
        step: 'confirm' as const,
        deadlineOffsetSecs: days * 86400,
      };
      draftStates.set(key, next);

      const schedule = projectScheduleDates(next.memberCount, next.cycleLengthSecs).join('\n');

      await ctx.reply(
        `Ringkasan "${next.name}":\n` +
          `• ${next.memberCount} anggota\n` +
          `• Setoran Rp${next.contributionAmount.toLocaleString('id-ID')} / siklus\n` +
          `• Tiap ${cycleDays} hari, batas kumpul ${days} hari sebelum telat\n\n` +
          `Proyeksi jadwal (siapa dapet giliran baru ketauan pas kocokan — ini baru perkiraan tanggalnya):\n${schedule}\n\n` +
          `⚠️ Testnet: token uji, belum Rupiah beneran.\n\nUdah pas?`,
        {
          reply_markup: new InlineKeyboard()
            .text('✅ Ya, buat drafnya', 'draftok')
            .text('✏️ Ulang dari awal', 'draftredo'),
        },
      );
      return;
    }
  } catch (error) {
    console.error('Draft step failed:', error);
    await ctx.reply('Waduh, otak AI ku lagi ngelag nih 😵 Coba /mulai lagi ya.');
  }
}

bot.callbackQuery('draftok', async (ctx) => {
  const telegramId = ctx.from.id.toString();
  const chatId = ctx.chat?.id.toString() ?? ctx.callbackQuery.message?.chat.id.toString() ?? '';
  const key = draftKey(chatId, telegramId);
  const state = draftStates.get(key);

  if (!state || state.step !== 'confirm') {
    await ctx.answerCallbackQuery({ text: 'Sesi drafnya udah kadaluwarsa, /mulai lagi ya.' });
    return;
  }
  draftStates.delete(key);
  await ctx.answerCallbackQuery();

  const user = await ensureUser(telegramId, ctx.from.username || '');
  if (!user) {
    await ctx.reply('Waduh, gagal nyimpen. Coba /mulai lagi ya.');
    return;
  }

  // Penalty/exit-penalty/reserve stay fixed small fractions of the
  // contribution rather than another interview question — these are
  // recovery-mechanism tuning, not something a first-time organizer has an
  // informed opinion on yet.
  const pool = await createDraftPool(user.id, telegramId, chatId, {
    name: state.name,
    memberCount: state.memberCount,
    contributionAmount: state.contributionAmount,
    cycleLengthSecs: state.cycleLengthSecs,
    deadlineOffsetSecs: state.deadlineOffsetSecs,
    penaltyAmount: Math.round(state.contributionAmount * 0.05),
    exitPenaltyAmount: Math.round(state.contributionAmount * 0.025),
    reserveBps: 100,
  });

  await ctx
    .editMessageText(`Draf "${state.name}" udah dicatat! Belum ada yang dibikin on-chain.`)
    .catch(() => {});
  await ctx.reply(
    'Kamu yang mulai /mulai tadi, buka tombol di bawah buat konfirmasi dan bikin ' +
      'kontraknya beneran — bakal diminta FaceID/sidik jari sekali buat tanda tangan.',
    { reply_markup: deepLinkKeyboard('Konfirmasi & Buat', `confirm_${pool.id}`) },
  );
});

bot.callbackQuery('draftredo', async (ctx) => {
  const telegramId = ctx.from.id.toString();
  const chatId = ctx.chat?.id.toString() ?? ctx.callbackQuery.message?.chat.id.toString() ?? '';
  draftStates.set(draftKey(chatId, telegramId), { step: 'basic' });
  await ctx.answerCallbackQuery();
  await ctx.reply(
    'Oke, ulang dari awal. Kasih tau nama, jumlah anggota, dan nominal setorannya ya.',
  );
});

/**
 * Free-form chat: private messages, or an @-mention in a group. Answers
 * questions and points people at /mulai or the Mini App — it does NOT
 * create anything itself. Pool creation only ever happens through /mulai's
 * explicit draft flow, which is the one path that ends in the organizer
 * seeing terms spelled out and signing to confirm them; a conversational
 * aside should never be able to conjure an arisan as a side effect.
 */
async function handleGeneralMessage(ctx: {
  chat: { type: string };
  message?: { text?: string };
  from?: { id: number };
  reply: (text: string, extra?: Record<string, unknown>) => Promise<unknown>;
  replyWithChatAction: (action: 'typing') => Promise<unknown>;
}) {
  const text = ctx.message?.text ?? '';
  const isPrivate = ctx.chat.type === 'private';
  const isMentioned = text.includes(`@${BOT_USERNAME}`);
  if (!isPrivate && !isMentioned) return;

  const userMessage = text.replace(`@${BOT_USERNAME}`, '').trim();
  if (!userMessage) return;

  await ctx.replyWithChatAction('typing');

  try {
    const response = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [
        {
          role: 'system',
          content:
            'Kamu adalah Circa, asisten Telegram Arisan berbasis blockchain yang ramah dan gaul. ' +
            'Gunakan bahasa Indonesia santai (aku/kamu atau gue/lu). ' +
            'Kalau user mau bikin arisan baru, arahkan mereka ketik /mulai di grup arisannya — ' +
            'jangan pernah membuat arisan sendiri dari percakapan biasa.',
        },
        { role: 'user', content: userMessage },
      ],
    });
    const reply = response.choices[0].message.content;
    if (reply) await ctx.reply(reply);
  } catch (error) {
    console.error('Groq AI Error:', error);
    await ctx.reply('Waduh, otak AI ku lagi ngelag nih 😵 Coba lagi nanti ya.');
  }
}

/**
 * "Gabung" in the group: pure social intent, no wallet, no signature.
 * Recorded as `interested`, not `joined` — the real on-chain join() still
 * needs the member's own passkey and happens in the Mini App.
 *
 * Once enough members have tapped in to fill the roster, the bot invites
 * everyone to complete the real signed join — that step can't happen from
 * a callback button, since it needs a passkey ceremony no server-side
 * handler can run on someone's behalf.
 */
bot.callbackQuery(/^gabung:(.+)$/, async (ctx) => {
  const poolId = ctx.match[1];
  const telegramId = ctx.from.id.toString();
  await ensureUser(telegramId, ctx.from.username || '');
  await markInterested(poolId, telegramId);

  const count = await listInterestedCount(poolId);
  await ctx.answerCallbackQuery({ text: 'Sip, kamu tercatat mau ikut!' });
  await ctx.editMessageText(
    `${ctx.callbackQuery.message?.text ?? ''}\n\n👥 ${count} orang tertarik ikut.`,
    { reply_markup: ctx.callbackQuery.message?.reply_markup },
  ).catch(() => {});

  const { data: pool } = await supabase
    .from('pools')
    .select('member_count, name')
    .eq('id', poolId)
    .maybeSingle();

  if (pool && count >= (pool.member_count ?? Infinity)) {
    await ctx.api.sendMessage(
      ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id ?? '',
      `Slot "${pool.name}" udah penuh peminat! 🎉\n\n` +
        `Yang tadi tap "Gabung", buka tombol di bawah buat resmi gabung — ` +
        `bakal diminta FaceID/sidik jari sekali buat tanda tangan.`,
      { reply_markup: deepLinkKeyboard('Gabung Resmi', `join_${poolId}`) },
    );
  }
});

// Error handling
bot.catch((err) => {
  console.error(`Error while handling update ${err.ctx.update.update_id}:`);
  console.error(err.error);
});
