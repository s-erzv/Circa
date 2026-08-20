-- Security foundation: closes V1 (unverified WebAuthn challenge) and
-- V3 (wallet address silently overwritable) from the design spec.
-- V2 (attacker-supplied telegram_id) is closed in application code by
-- deriving identity from verified Telegram initData.

-- V1: server-issued, single-use WebAuthn challenges.
--
-- The prototype read the "expected" challenge out of the client's own
-- response and compared it to itself, which always passes and removes
-- WebAuthn's replay protection entirely. The server must issue the
-- challenge, remember it, and check the response against what it
-- remembered.
--
-- Keyed by telegram_id (not a surrogate id) so the lookup happens with the
-- same verified identity the rest of the request uses, and so a second
-- registration attempt naturally replaces the first rather than leaving
-- multiple live challenges for one user.
create table if not exists public.webauthn_challenges (
  telegram_id text primary key,
  challenge   text        not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

alter table public.webauthn_challenges enable row level security;

-- No anon policies at all: this table is only ever touched by API routes
-- using the service role. An anon client has no legitimate reason to read
-- challenges (knowing a live challenge is half of a replay).

create index if not exists webauthn_challenges_expires_at
  on public.webauthn_challenges (expires_at);

-- V3: a wallet binding is single-shot.
--
-- Two independent guards, because this one redirects money:
--   1. this partial unique index stops one wallet being bound to two
--      accounts (the DB enforces it even if application code regresses),
--   2. the application's UPDATE is guarded on `wallet_address is null`,
--      so an existing binding is never replaced.
-- Partial, because wallet_address is legitimately null for every user who
-- has not yet made their first setoran — and a plain unique index would
-- treat those nulls as distinct anyway, so being explicit documents intent.
create unique index if not exists users_wallet_address_unique
  on public.users (wallet_address)
  where wallet_address is not null;

alter table public.users
  add column if not exists wallet_bound_at timestamptz;

comment on column public.users.wallet_bound_at is
  'When the passkey wallet was bound. Single-shot: once set, neither this '
  'nor wallet_address may be changed by any normal code path. Recovery '
  'after device loss is a separate, deliberately-designed flow.';
