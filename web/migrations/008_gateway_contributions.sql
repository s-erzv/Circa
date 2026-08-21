-- Ties a payment_intent to a specific pool's setoran, distinguishing a
-- pool contribution from a generic wallet top-up (both share the same QRIS
-- bridge; this column is the only thing that tells the webhook which path
-- to take — see contribute_via_gateway in arisan-pool and the xendit
-- webhook route).
alter table public.payment_intents
  add column if not exists pool_id uuid references public.pools(id);

create index if not exists payment_intents_pool_id
  on public.payment_intents (pool_id)
  where pool_id is not null;
