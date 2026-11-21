-- Song Tool: database setup for Supabase.
-- Paste this whole file into Supabase > SQL Editor > New query, then press Run.
-- Safe to read first: it only creates tables, security rules and live-update settings. It deletes nothing.
--
-- Who can do what:
--   * Organisers sign in (email link) and can create, edit and delete ONLY their own profiles and tournaments.
--   * Anyone, signed in or not, can READ a tournament marked is_public (the default) and its players, rounds and games.
--     That is what lets players see standings on their phones without an account.

-- ---- tables ---------------------------------------------------------------

create table if not exists public.profiles (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null,
  club        text not null default '',
  country     text not null default '',
  faction     text not null default '',
  created_at  timestamptz not null default now()
);

create table if not exists public.tournaments (
  id             uuid primary key default gen_random_uuid(),
  owner          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name           text not null,
  date           date,
  location       text not null default '',
  points         integer not null default 40,          -- army size in points
  planned_rounds integer not null default 3,
  status         text not null default 'setup' check (status in ('setup', 'running', 'finished')),
  rules          jsonb not null default '{}'::jsonb,   -- pairing, scoring, margins, tie-breakers
  is_public      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.tournament_players (
  id             uuid primary key default gen_random_uuid(),
  tournament_id  uuid not null references public.tournaments(id) on delete cascade,
  profile_id     uuid not null references public.profiles(id) on delete restrict,
  list_code      text not null default '',             -- the share-link code of the locked army list
  locked         boolean not null default false,
  dropped        boolean not null default false,
  unique (tournament_id, profile_id)
);

create table if not exists public.rounds (
  id             uuid primary key default gen_random_uuid(),
  tournament_id  uuid not null references public.tournaments(id) on delete cascade,
  n              integer not null check (n > 0),
  done           boolean not null default false,
  unique (tournament_id, n)
);

create table if not exists public.games (
  id             uuid primary key default gen_random_uuid(),
  round_id       uuid not null references public.rounds(id) on delete cascade,
  tournament_id  uuid not null references public.tournaments(id) on delete cascade,
  table_no       integer not null,
  a              uuid not null references public.profiles(id),
  b              uuid references public.profiles(id),   -- null = a bye for player a
  result         text check (result in ('a', 'b', 'draw')),
  manual         boolean not null default false,        -- result picked by hand, not worked out
  vp_a           integer,
  vp_b           integer,
  bonus_a        integer not null default 0,
  bonus_b        integer not null default 0,
  killed_by_a    integer[] not null default '{}',       -- positions in B's list that A destroyed
  killed_by_b    integer[] not null default '{}',
  unique (round_id, table_no)
);

create index if not exists tournaments_owner_idx on public.tournaments (owner);
create index if not exists profiles_owner_idx on public.profiles (owner);
create index if not exists players_tournament_idx on public.tournament_players (tournament_id);
create index if not exists rounds_tournament_idx on public.rounds (tournament_id);
create index if not exists games_tournament_idx on public.games (tournament_id);

-- keep updated_at honest
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists tournaments_touch on public.tournaments;
create trigger tournaments_touch before update on public.tournaments
  for each row execute function public.touch_updated_at();

-- ---- security: row level security on every table -----------------------------

alter table public.profiles            enable row level security;
alter table public.tournaments         enable row level security;
alter table public.tournament_players  enable row level security;
alter table public.rounds              enable row level security;
alter table public.games               enable row level security;

-- profiles: the organiser who made one manages it; names, clubs and factions are readable so standings can show them
drop policy if exists "profiles: owner manages" on public.profiles;
create policy "profiles: owner manages" on public.profiles for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
drop policy if exists "profiles: public read" on public.profiles;
create policy "profiles: public read" on public.profiles for select to anon, authenticated using (true);

-- tournaments
drop policy if exists "tournaments: owner manages" on public.tournaments;
create policy "tournaments: owner manages" on public.tournaments for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
drop policy if exists "tournaments: public read" on public.tournaments;
create policy "tournaments: public read" on public.tournaments for select to anon, authenticated using (is_public);

-- players, rounds and games follow their tournament
do $$
declare t text;
begin
  foreach t in array array['tournament_players', 'rounds', 'games'] loop
    execute format('drop policy if exists "%1$s: owner manages" on public.%1$s', t);
    execute format($p$create policy "%1$s: owner manages" on public.%1$s for all to authenticated
      using (exists (select 1 from public.tournaments x where x.id = %1$s.tournament_id and x.owner = auth.uid()))
      with check (exists (select 1 from public.tournaments x where x.id = %1$s.tournament_id and x.owner = auth.uid()))$p$, t);
    execute format('drop policy if exists "%1$s: public read" on public.%1$s', t);
    execute format($p$create policy "%1$s: public read" on public.%1$s for select to anon, authenticated
      using (exists (select 1 from public.tournaments x where x.id = %1$s.tournament_id and x.is_public))$p$, t);
  end loop;
end $$;

-- ---- access: the API may only do what the rules above allow ---------------------

grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.tournaments, public.tournament_players, public.rounds, public.games to anon;
grant select, insert, update, delete on public.profiles, public.tournaments, public.tournament_players, public.rounds, public.games to authenticated;

-- ---- live updates (Realtime) for the pages that watch a tournament ----------------

do $$
declare t text;
begin
  foreach t in array array['games', 'rounds', 'tournament_players', 'tournaments'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
