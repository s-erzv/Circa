-- Server-held storage for prepared-but-unsigned relay transactions.
--
-- /api/tx/submit must NEVER accept a client-supplied transaction XDR: the
-- allowlist in tx-relay.ts's buildInvocation() only runs at PREPARE time,
-- so if submit trusted a client-supplied tx blob, a caller could skip
-- /api/tx/prepare entirely, hand-build a transaction invoking any contract
-- and method they like, sign their own auth entry for it (which they are
-- perfectly able to do for their own wallet), and get the sponsor to pay
-- fees and countersign it — an open relay for arbitrary contract calls at
-- the sponsor's expense.
--
-- The fix is indirection: prepare stores the tx it built under a random
-- single-use id and hands the client only that id (plus the one auth entry
-- to sign). Submit looks the transaction up by id — it is never something
-- the client can supply or influence — so whatever prepareRelay's allowlist
-- decided is exactly what gets submitted, with no path around it.
create table if not exists public.pending_relays (
  relay_id   text primary key,
  tx_xdr     text        not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.pending_relays enable row level security;
-- No anon policies: only API routes using the service role touch this, same
-- as webauthn_challenges and wallet_handoff_tokens. A readable relay table
-- would hand out a sponsor-paid transaction for the taking.

create index if not exists pending_relays_expires_at
  on public.pending_relays (expires_at);
