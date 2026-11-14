-- Straddloop schema. Paste into the Supabase SQL editor and run once. Safe to re-run.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  focus text check (focus in ('index', 'stocks', 'exploring')),
  first_strategy text check (first_strategy in ('straddle', 'orb', 'fourleg')),
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  strategy text not null check (strategy in ('straddle', 'orb', 'fourleg')),
  params jsonb not null default '{}'::jsonb,
  summary jsonb not null default '{}'::jsonb,
  note text not null default '' check (char_length(note) <= 280),
  created_at timestamptz not null default now()
);

create index if not exists runs_user_created_idx on public.runs (user_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.runs enable row level security;

drop policy if exists "profiles: owner reads" on public.profiles;
drop policy if exists "profiles: owner inserts" on public.profiles;
drop policy if exists "profiles: owner updates" on public.profiles;
create policy "profiles: owner reads" on public.profiles for select using ((select auth.uid()) = id);
create policy "profiles: owner inserts" on public.profiles for insert with check ((select auth.uid()) = id);
create policy "profiles: owner updates" on public.profiles for update using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

drop policy if exists "runs: owner reads" on public.runs;
drop policy if exists "runs: owner inserts" on public.runs;
drop policy if exists "runs: owner updates" on public.runs;
drop policy if exists "runs: owner deletes" on public.runs;
create policy "runs: owner reads" on public.runs for select using ((select auth.uid()) = user_id);
create policy "runs: owner inserts" on public.runs for insert with check ((select auth.uid()) = user_id);
create policy "runs: owner updates" on public.runs for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "runs: owner deletes" on public.runs for delete using ((select auth.uid()) = user_id);
