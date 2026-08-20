-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- USERS TABLE
create table public.users (
  id uuid primary key default uuid_generate_v4(),
  telegram_id text unique not null,
  telegram_username text,

  -- WebAuthn Passkey details
  credential_id text unique,
  public_key bytea,
  counter bigint,

  -- Soroban Contract Wallet
  wallet_address text unique,

  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- POOLS TABLE
create table public.pools (
  id uuid primary key default uuid_generate_v4(),
  contract_id text unique not null,
  name text not null,
  description text,
  organizer_id uuid references public.users(id) on delete restrict not null,

  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- ROW LEVEL SECURITY (RLS)

-- Enable RLS on all tables
alter table public.users enable row level security;
alter table public.pools enable row level security;

-- Catatan Penting:
-- Karena aplikasi kita menggunakan Telegram Bot dan Custom WebAuthn (bukan Supabase Auth bawaan),
-- backend Next.js (API Routes) dan Telegram Bot akan mengakses database menggunakan SERVICE_ROLE_KEY.
-- SERVICE_ROLE_KEY otomatis mem-bypass RLS.
-- RLS di bawah ini disiapkan sebagai pengaman ekstra untuk mencegah akses publik melalui ANON_KEY.

-- Policies untuk Users
create policy "Users are viewable by everyone."
  on public.users for select
  using ( true );

create policy "Users cannot be inserted by anon."
  on public.users for insert
  with check ( false );

create policy "Users cannot be updated by anon."
  on public.users for update
  using ( false );

create policy "Users cannot be deleted by anon."
  on public.users for delete
  using ( false );

-- Policies untuk Pools
create policy "Pools are viewable by everyone."
  on public.pools for select
  using ( true );

create policy "Pools cannot be inserted by anon."
  on public.pools for insert
  with check ( false );

create policy "Pools cannot be updated by anon."
  on public.pools for update
  using ( false );

create policy "Pools cannot be deleted by anon."
  on public.pools for delete
  using ( false );

-- Trigger untuk Updated At
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger on_users_updated
  before update on public.users
  for each row execute procedure public.handle_updated_at();

create trigger on_pools_updated
  before update on public.pools
  for each row execute procedure public.handle_updated_at();
