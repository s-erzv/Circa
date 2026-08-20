-- QRIS top-up tracking (Task 7).
--
-- The bridge model: Xendit confirms a real QRIS payment happened, then WE
-- mint/transfer the equivalent IDRT to the payer's wallet — Stellar itself
-- has no way to know a QRIS payment occurred, since QRIS is a domestic bank
-- rail, not a blockchain. This table is what ties "Xendit says this
-- external_id got paid" to "credit this wallet", and stops the same
-- confirmed payment from ever being credited twice.
create table if not exists public.payment_intents (
  id             uuid primary key default uuid_generate_v4(),
  telegram_id    text        not null,
  wallet_address text        not null,
  amount         bigint      not null,
  xendit_qr_id   text        not null unique,
  external_id    text        not null unique,
  status         text        not null default 'pending'
    check (status in ('pending', 'paid', 'expired', 'failed')),
  minted_at      timestamptz,
  created_at     timestamptz not null default now()
);

alter table public.payment_intents enable row level security;
-- No anon policies: only API routes using the service role touch this —
-- same reasoning as webauthn_challenges. A readable/writable intents table
-- would let anyone claim someone else's payment or fake a "paid" status.

create index if not exists payment_intents_telegram_id
  on public.payment_intents (telegram_id);
