-- Lets the organizer choose, at draft time, whether the payout order is
-- drawn once upfront (fixed for the pool's whole life) or re-drawn every
-- cycle among whoever's left (only the very next recipient is ever settled).
-- Mirrors arisan-pool's DrawMode enum — 'per_cycle' is the default, matching
-- what every pool created before this migration already behaves as.
alter table public.pools
  add column if not exists draw_mode text not null default 'per_cycle'
    check (draw_mode in ('per_cycle', 'upfront'));
