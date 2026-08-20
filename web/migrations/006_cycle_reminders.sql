-- Dedup for cycle reminders.
--
-- distribute() and penalize() are already guarded on-chain against being
-- run twice for the same cycle (deadline-gated, and penalize() has its own
-- AlreadyPenalizedThisCycle check), so a cron job hitting them repeatedly
-- is harmless — the contract just rejects the redundant call. A reminder
-- message has no such guard: without tracking what's already been sent,
-- every cron tick before a deadline would re-spam the group.
create table if not exists public.pool_reminders (
  pool_id uuid not null references public.pools(id) on delete cascade,
  cycle   integer not null,
  sent_at timestamptz not null default now(),
  primary key (pool_id, cycle)
);

alter table public.pool_reminders enable row level security;

create policy "Pool reminders are viewable by everyone."
  on public.pool_reminders for select
  using (true);

create policy "Pool reminders cannot be written by anon."
  on public.pool_reminders for all
  using (false)
  with check (false);
