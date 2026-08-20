-- Pools and membership, extended to reflect two real facts discovered while
-- wiring the bot to the chain:
--
--  1. Pool creation itself is a signed on-chain call (ArisanPool::create
--     requires organizer.require_auth()), so a pool starts life as a DRAFT
--     — captured entirely in chat, before any wallet or signature exists —
--     and only gets a contract_id once the organizer has completed the
--     passkey ceremony and actually signed the create() call in the Mini
--     App. contract_id therefore has to be nullable.
--
--  2. ArisanPool::join() ALSO requires member.require_auth() even though it
--     moves no tokens. "Tap to join in the group" cannot itself be that
--     signed call — a Telegram inline button click has no browser, no
--     WebAuthn, nothing to sign with. So membership has two stages:
--     expressing interest (free, in-chat, no wallet) and actually joining
--     on-chain (needs a passkey, happens in the Mini App). pool_members
--     tracks both explicitly rather than conflating them.

alter table public.pools
  alter column contract_id drop not null;

alter table public.pools
  add column if not exists telegram_chat_id text,
  add column if not exists status text not null default 'draft',
  add column if not exists organizer_telegram_id text,
  add column if not exists token_address text,
  add column if not exists contribution_amount bigint,
  add column if not exists member_count integer,
  add column if not exists cycle_length_secs bigint,
  add column if not exists deadline_offset_secs bigint,
  add column if not exists penalty_amount bigint,
  add column if not exists exit_penalty_amount bigint,
  add column if not exists reserve_bps integer;

alter table public.pools
  add constraint pools_status_check
  check (status in ('draft', 'deploying', 'forming', 'active', 'closed'));

-- One live (non-closed) pool per group at a time. Partial rather than
-- plain-unique: a group is free to start a new arisan after the previous
-- one closes. Multi-pool-per-group is explicitly out of scope for now (see
-- the design spec) — this index is what actually enforces that, not just a
-- convention in the bot's own logic.
create unique index if not exists pools_one_live_per_chat
  on public.pools (telegram_chat_id)
  where status != 'closed';

create table if not exists public.pool_members (
  pool_id     uuid not null references public.pools(id) on delete cascade,
  telegram_id text not null,
  -- 'interested': tapped the in-group join button, no wallet needed yet.
  -- 'joined': completed the passkey ceremony and their signed join() call
  -- landed on-chain. Only 'joined' rows correspond to real membership.
  status      text not null default 'interested',
  joined_at   timestamptz,
  created_at  timestamptz not null default now(),
  primary key (pool_id, telegram_id)
);

alter table public.pool_members
  add constraint pool_members_status_check
  check (status in ('interested', 'joined'));

alter table public.pool_members enable row level security;

create policy "Pool members are viewable by everyone."
  on public.pool_members for select
  using (true);

create policy "Pool members cannot be written by anon."
  on public.pool_members for all
  using (false)
  with check (false);
