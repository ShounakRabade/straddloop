-- Straddloop market data (Dhan 1-minute option candles) for the website's real-data backtests.
-- Run after schema.sql. Safe to re-run.
--
-- Layout: one gzip JSON file per trading day per expiry series in the private Storage bucket
-- `market-data` at <UNDERLYING>/<WEEK|MONTH>/<YYYY-MM-DD>.json.gz, plus one row per file in
-- public.market_days. Only accounts listed in public.data_readers can read either. Writes come only
-- from the local uploader (`straddloop supabase-upload`), which uses the secret key and bypasses RLS.

create table if not exists public.data_readers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.data_readers enable row level security;
drop policy if exists "data_readers: self reads" on public.data_readers;
create policy "data_readers: self reads" on public.data_readers for select using ((select auth.uid()) = user_id);

-- Security invoker: the "self reads" policy above already lets a user see their own row.
create or replace function public.is_data_reader() returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from public.data_readers where user_id = (select auth.uid()));
$$;
revoke all on function public.is_data_reader() from public, anon;
grant execute on function public.is_data_reader() to authenticated;

create table if not exists public.market_days (
  underlying text not null,
  expiry_flag text not null check (expiry_flag in ('WEEK', 'MONTH')),
  trade_date date not null,
  path text not null,
  format_version smallint not null default 1,
  series smallint not null,            -- option series in the file (42 at ATM+-10, CE and PE)
  option_bars integer not null,        -- 1-minute option bars in the file
  index_bars smallint not null,        -- 1-minute index bars (0 when only Dhan's spot was available)
  expiry date,                         -- ASSUMED until the bhavcopy step confirms it
  expiry_source text not null default 'assumed',
  lot_size integer,
  lot_source text not null default 'assumed',
  quality text not null default 'unchecked',
  sha256 text not null,
  bytes integer not null,
  uploaded_at timestamptz not null default now(),
  primary key (underlying, expiry_flag, trade_date)
);
alter table public.market_days enable row level security;
drop policy if exists "market_days: readers read" on public.market_days;
create policy "market_days: readers read" on public.market_days for select to authenticated
  using ((select public.is_data_reader()));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('market-data', 'market-data', false, 5242880, array['application/gzip'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "market-data: readers read" on storage.objects;
create policy "market-data: readers read" on storage.objects for select to authenticated
  using (bucket_id = 'market-data' and (select public.is_data_reader()));

-- Read access: give it to your own account. Replace the email with the one you sign in with.
insert into public.data_readers (user_id)
select id from auth.users where lower(email) = lower('you@example.com')
on conflict do nothing;
