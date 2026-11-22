-- Song Tool: database setup for Supabase (version 2: player accounts, tournament directory, registration).
-- Paste this whole file into Supabase > SQL Editor > New query, then press Run. It is safe to run again later: it only
-- creates what is missing and refreshes the security rules. (If you set up the first version of this file earlier, run
-- migration-v1-to-v2.sql ONCE before this file. It removes the old test tables.)
--
-- Who can do what:
--   * Everyone who signs up (email link) has ONE profile of their own: first and last name, a REQUIRED nickname, club, country, picture.
--     The nickname is the public name; real names are shown only in match-ups, game history and to the person and their organisers.
--   * Anyone can create a tournament and becomes its organiser. A tournament is "listed" (shown in the directory),
--     "link" (anyone with the link can view it) or "private" (only the organiser and approved players).
--   * A player asks to join. The organiser approves or declines. Approved players are shown publicly.
--   * A player's army list is private to them and the organiser until the organiser locks lists, then it is visible
--     to everyone who can view the tournament (or, if the organiser chose to, only once round 1 has been drawn).
--   * Players can report the victory points, destroyed units and result of THEIR OWN games while the round is open;
--     the organiser can change anything.
--   * Each person's saved army lists are a PRIVATE library: only the owner can read them. A list becomes visible to others
--     only by being entered in a tournament, under the list rules above.
--   * Ratings (Glicko-2) are worked out from finished tournaments with 16 or more players (see the ratings section).

-- ---- tables ---------------------------------------------------------------

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,   -- the account's id
  first_name  text not null check (length(btrim(first_name)) > 0),
  last_name   text not null default '',
  nickname    text not null check (length(btrim(nickname)) > 0),   -- REQUIRED: how the person is shown publicly (rankings, rosters, standings)
  club        text not null default '',
  country     text not null default '',
  avatar_updated_at timestamptz,             -- set when a profile picture is uploaded (the picture is in the 'avatars' storage bucket)
  created_at  timestamptz not null default now()
);

create table if not exists public.tournaments (
  id                       uuid primary key default gen_random_uuid(),
  owner                    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name                     text not null,
  date                     date,
  location                 text not null default '',
  description              text not null default '',
  points                   integer not null default 40,          -- army size in points
  planned_rounds           integer not null default 3,
  status                   text not null default 'setup' check (status in ('setup', 'running', 'finished')),
  rules                    jsonb not null default '{}'::jsonb,   -- pairing, scoring, margins, tie-breakers
  visibility               text not null default 'listed' check (visibility in ('listed', 'link', 'private')),
  registration_open        boolean not null default true,
  max_players              integer check (max_players is null or max_players > 0),
  lists_locked             boolean not null default false,       -- once true, lists can no longer be changed and become public
  hide_lists_until_round1  boolean not null default false,       -- if true, locked lists stay hidden until round 1 is drawn
  rating_override          boolean,                              -- site admin only: true = always counts for ratings, false = never, null = counts if 16+ players
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create table if not exists public.registrations (
  tournament_id  uuid not null references public.tournaments(id) on delete cascade,
  profile_id     uuid not null references public.profiles(id) on delete cascade,
  status         text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  dropped        boolean not null default false,
  created_at     timestamptz not null default now(),
  primary key (tournament_id, profile_id)
);

-- a player's army list is kept apart from the registration so it can have its own, stricter visibility
create table if not exists public.entry_lists (
  tournament_id  uuid not null,
  profile_id     uuid not null,
  list_code      text not null,                                   -- the share-link code of the army list
  faction        text,                                            -- faction id and commander id of that list, so records can be kept per faction
  commander      text,
  points         integer,
  updated_at     timestamptz not null default now(),
  primary key (tournament_id, profile_id),
  foreign key (tournament_id, profile_id) references public.registrations(tournament_id, profile_id) on delete cascade
);

-- profiles made before the nickname was required: use the first name until they choose one
update public.profiles set nickname = btrim(first_name) where btrim(nickname) = '';
alter table public.profiles alter column nickname drop default;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_nickname_required') then
    alter table public.profiles add constraint profiles_nickname_required check (length(btrim(nickname)) > 0);
  end if;
end $$;

-- Each person's private library of saved army lists (the Building page's "Saved lists", kept on their account so they follow them
-- between devices). Nobody but the owner can read it.
create table if not exists public.saved_lists (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null check (length(btrim(name)) > 0),
  list_code   text not null,
  faction     text,
  points      integer,
  updated_at  timestamptz not null default now(),
  unique (owner, name)
);

-- columns added after the first release of this file (safe to repeat)
alter table public.tournaments add column if not exists rating_override boolean;
alter table public.entry_lists add column if not exists faction text;
alter table public.entry_lists add column if not exists commander text;
alter table public.entry_lists add column if not exists points integer;

-- Final standings of a finished tournament, one row per player, saved by the organiser's page when the tournament is finished.
-- This is what "tournament wins" and "podium finishes" are counted from (rank 1 = winner; players level on everything share a rank).
create table if not exists public.tournament_results (
  tournament_id    uuid not null references public.tournaments(id) on delete cascade,
  profile_id       uuid not null references public.profiles(id) on delete cascade,
  rank             integer not null,
  field_size       integer not null,                  -- how many players were in the tournament
  tournament_pts   integer not null default 0,
  played           integer not null default 0,
  wins             integer not null default 0,
  draws            integer not null default 0,
  losses           integer not null default 0,
  byes             integer not null default 0,
  major_wins       integer not null default 0,
  vp_for           integer not null default 0,
  vp_against       integer not null default 0,
  pts_destroyed    integer not null default 0,        -- enemy army points destroyed
  pts_lost         integer not null default 0,
  finished_at      timestamptz not null default now(),
  primary key (tournament_id, profile_id)
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
  b              uuid references public.profiles(id),            -- null = a bye for player a
  result         text check (result in ('a', 'b', 'draw')),
  manual         boolean not null default false,                 -- result fixed by the organiser, not worked out
  vp_a           integer,
  vp_b           integer,
  bonus_a        integer not null default 0,
  bonus_b        integer not null default 0,
  killed_by_a    integer[] not null default '{}',                -- positions in B's list that A destroyed
  killed_by_b    integer[] not null default '{}',
  updated_by     uuid,
  updated_at     timestamptz not null default now(),
  unique (round_id, table_no)
);

create index if not exists tournaments_owner_idx on public.tournaments (owner);
create index if not exists tournaments_listed_idx on public.tournaments (visibility, date);
create index if not exists registrations_profile_idx on public.registrations (profile_id);
create index if not exists saved_lists_owner_idx on public.saved_lists (owner);
create index if not exists entry_lists_faction_idx on public.entry_lists (faction);
create index if not exists results_profile_idx on public.tournament_results (profile_id);
create index if not exists rounds_tournament_idx on public.rounds (tournament_id);
create index if not exists games_tournament_idx on public.games (tournament_id);
create index if not exists games_a_idx on public.games (a);
create index if not exists games_b_idx on public.games (b);

-- ---- helper questions the security rules ask --------------------------------
-- These run with their own rights so the rules can look at other tables without looping.

create or replace function public.is_owner(tid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from tournaments where id = tid and owner = auth.uid()) $$;
create or replace function public.is_member(tid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from registrations where tournament_id = tid and profile_id = auth.uid() and status = 'approved') $$;
create or replace function public.can_view(tid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from tournaments t where t.id = tid and (t.owner = auth.uid() or t.visibility in ('listed', 'link') or is_member(tid))) $$;
create or replace function public.is_locked(tid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select lists_locked from tournaments where id = tid), false) $$;
create or replace function public.can_register(tid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from tournaments t where t.id = tid and t.registration_open and not t.lists_locked and t.visibility in ('listed', 'link')) $$;
create or replace function public.has_registration(tid uuid, pid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from registrations where tournament_id = tid and profile_id = pid and status in ('pending', 'approved')) $$;
create or replace function public.is_approved(tid uuid, pid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from registrations where tournament_id = tid and profile_id = pid and status = 'approved') $$;
-- are the locked lists public yet? (locked, and either no "hide until round 1" or round 1 has been drawn)
create or replace function public.lists_public(tid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from tournaments t where t.id = tid and t.lists_locked
    and (not t.hide_lists_until_round1 or exists (select 1 from rounds r where r.tournament_id = t.id))) $$;
create or replace function public.round_open(rid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from rounds where id = rid and not done) $$;
-- may the caller see this profile? their own, or a player in a tournament they can see (the organiser also sees people who asked to join)
create or replace function public.profile_visible(pid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select pid = auth.uid() or exists (select 1 from registrations r where r.profile_id = pid
    and ((r.status = 'approved' and can_view(r.tournament_id)) or is_owner(r.tournament_id))) $$;

-- ---- triggers: rules that row-level security cannot express --------------------

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists tournaments_touch on public.tournaments;
create trigger tournaments_touch before update on public.tournaments for each row execute function public.touch_updated_at();
drop trigger if exists entry_lists_touch on public.entry_lists;
create trigger entry_lists_touch before update on public.entry_lists for each row execute function public.touch_updated_at();

-- only the site administrator (working in the Supabase dashboard, not through the website) may set rating_override
create or replace function public.tournaments_guard() returns trigger language plpgsql as $$
begin
  if auth.uid() is not null and (tg_op = 'INSERT' and new.rating_override is not null
      or tg_op = 'UPDATE' and new.rating_override is distinct from old.rating_override) then
    raise exception 'Only the site administrator can change whether a tournament counts for ratings.';
  end if;
  return new;
end $$;
drop trigger if exists tournaments_guard_check on public.tournaments;
create trigger tournaments_guard_check before insert or update on public.tournaments for each row execute function public.tournaments_guard();

-- a tournament cannot approve more players than its limit
create or replace function public.registrations_cap() returns trigger language plpgsql security definer set search_path = public as $$
declare cap integer;
begin
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    select max_players into cap from tournaments where id = new.tournament_id;
    if cap is not null and (select count(*) from registrations where tournament_id = new.tournament_id and status = 'approved') >= cap then
      raise exception 'This tournament is full.';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists registrations_cap_check on public.registrations;
create trigger registrations_cap_check before insert or update on public.registrations for each row execute function public.registrations_cap();

-- players may report their own games, but not move players between tables or change bonus points or an organiser-fixed result
create or replace function public.games_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not is_owner(new.tournament_id) then
    if new.a is distinct from old.a or new.b is distinct from old.b or new.round_id <> old.round_id or new.table_no <> old.table_no
       or new.tournament_id <> old.tournament_id or new.bonus_a <> old.bonus_a or new.bonus_b <> old.bonus_b or new.manual <> old.manual then
      raise exception 'Players can only report victory points, destroyed units and the result of their own game.';
    end if;
    if old.manual and new.result is distinct from old.result then raise exception 'The organiser has fixed this result.'; end if;
  end if;
  new.updated_by = auth.uid(); new.updated_at = now();
  return new;
end $$;
drop trigger if exists games_guard_check on public.games;
create trigger games_guard_check before update on public.games for each row execute function public.games_guard();

-- ---- security: row level security on every table -----------------------------

alter table public.profiles       enable row level security;
alter table public.tournaments    enable row level security;
alter table public.registrations  enable row level security;
alter table public.saved_lists    enable row level security;
alter table public.entry_lists    enable row level security;
alter table public.tournament_results enable row level security;
alter table public.rounds         enable row level security;
alter table public.games          enable row level security;

-- profiles
drop policy if exists "profiles: read" on public.profiles;
create policy "profiles: read" on public.profiles for select to anon, authenticated using (public.profile_visible(id));
drop policy if exists "profiles: create own" on public.profiles;
create policy "profiles: create own" on public.profiles for insert to authenticated with check (id = auth.uid());
drop policy if exists "profiles: change own" on public.profiles;
create policy "profiles: change own" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists "profiles: delete own" on public.profiles;
create policy "profiles: delete own" on public.profiles for delete to authenticated using (id = auth.uid());

-- tournaments
drop policy if exists "tournaments: read" on public.tournaments;
create policy "tournaments: read" on public.tournaments for select to anon, authenticated
  using (owner = auth.uid() or visibility in ('listed', 'link') or public.is_member(id));
drop policy if exists "tournaments: create" on public.tournaments;
create policy "tournaments: create" on public.tournaments for insert to authenticated with check (owner = auth.uid());
drop policy if exists "tournaments: organiser changes" on public.tournaments;
create policy "tournaments: organiser changes" on public.tournaments for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
drop policy if exists "tournaments: organiser deletes" on public.tournaments;
create policy "tournaments: organiser deletes" on public.tournaments for delete to authenticated using (owner = auth.uid());

-- registrations: players ask to join (always "pending"); only the organiser approves or declines
drop policy if exists "registrations: read" on public.registrations;
create policy "registrations: read" on public.registrations for select to anon, authenticated
  using (profile_id = auth.uid() or public.is_owner(tournament_id) or (status = 'approved' and public.can_view(tournament_id)));
drop policy if exists "registrations: ask to join" on public.registrations;
create policy "registrations: ask to join" on public.registrations for insert to authenticated
  with check (profile_id = auth.uid() and status = 'pending' and not dropped and public.can_register(tournament_id));
drop policy if exists "registrations: organiser decides" on public.registrations;
create policy "registrations: organiser decides" on public.registrations for update to authenticated
  using (public.is_owner(tournament_id)) with check (public.is_owner(tournament_id));
drop policy if exists "registrations: withdraw or remove" on public.registrations;
create policy "registrations: withdraw or remove" on public.registrations for delete to authenticated
  using (public.is_owner(tournament_id) or (profile_id = auth.uid() and not public.is_locked(tournament_id)));

-- army lists: private until the organiser locks lists (and, if chosen, round 1 is drawn)
drop policy if exists "entry_lists: read" on public.entry_lists;
create policy "entry_lists: read" on public.entry_lists for select to anon, authenticated
  using (profile_id = auth.uid() or public.is_owner(tournament_id)
         or (public.lists_public(tournament_id) and public.can_view(tournament_id) and public.is_approved(tournament_id, profile_id)));
drop policy if exists "entry_lists: write" on public.entry_lists;
create policy "entry_lists: write" on public.entry_lists for insert to authenticated
  with check (public.is_owner(tournament_id) or (profile_id = auth.uid() and not public.is_locked(tournament_id) and public.has_registration(tournament_id, profile_id)));
drop policy if exists "entry_lists: change" on public.entry_lists;
create policy "entry_lists: change" on public.entry_lists for update to authenticated
  using (public.is_owner(tournament_id) or (profile_id = auth.uid() and not public.is_locked(tournament_id)))
  with check (public.is_owner(tournament_id) or (profile_id = auth.uid() and not public.is_locked(tournament_id)));
drop policy if exists "entry_lists: remove" on public.entry_lists;
create policy "entry_lists: remove" on public.entry_lists for delete to authenticated
  using (public.is_owner(tournament_id) or (profile_id = auth.uid() and not public.is_locked(tournament_id)));

-- saved lists: private to their owner
drop policy if exists "saved_lists: owner only" on public.saved_lists;
create policy "saved_lists: owner only" on public.saved_lists for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

-- final results: readable by anyone who can see the tournament; only the organiser writes them
drop policy if exists "results: read" on public.tournament_results;
create policy "results: read" on public.tournament_results for select to anon, authenticated using (public.can_view(tournament_id));
drop policy if exists "results: organiser writes" on public.tournament_results;
create policy "results: organiser writes" on public.tournament_results for all to authenticated
  using (public.is_owner(tournament_id)) with check (public.is_owner(tournament_id));

-- rounds: anyone who can see the tournament reads; the organiser writes
drop policy if exists "rounds: read" on public.rounds;
create policy "rounds: read" on public.rounds for select to anon, authenticated using (public.can_view(tournament_id));
drop policy if exists "rounds: organiser writes" on public.rounds;
create policy "rounds: organiser writes" on public.rounds for all to authenticated using (public.is_owner(tournament_id)) with check (public.is_owner(tournament_id));

-- games: the organiser writes; the two players in a game may report it while the round is open
drop policy if exists "games: read" on public.games;
create policy "games: read" on public.games for select to anon, authenticated using (public.can_view(tournament_id));
drop policy if exists "games: organiser adds" on public.games;
create policy "games: organiser adds" on public.games for insert to authenticated with check (public.is_owner(tournament_id));
drop policy if exists "games: organiser removes" on public.games;
create policy "games: organiser removes" on public.games for delete to authenticated using (public.is_owner(tournament_id));
drop policy if exists "games: report" on public.games;
create policy "games: report" on public.games for update to authenticated
  using (public.is_owner(tournament_id) or (auth.uid() in (a, b) and public.round_open(round_id)))
  with check (public.is_owner(tournament_id) or (auth.uid() in (a, b) and public.round_open(round_id)));

-- ---- access: the API may only do what the rules above allow ---------------------

grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.tournaments, public.registrations, public.entry_lists, public.tournament_results, public.rounds, public.games to anon;
grant select, insert, update, delete on public.profiles, public.tournaments, public.registrations, public.entry_lists, public.tournament_results, public.rounds, public.games to authenticated;
grant select, insert, update, delete on public.saved_lists to authenticated;   -- no access for anon: the library is private

-- ---- real names ----------------------------------------------------------------
-- The nickname is the public name. Real names (first_name, last_name) cannot be read from the profiles table by anyone through the API;
-- they are served by the view profile_names, which returns a real name only to: the person themselves, anyone who can view a tournament
-- in which that person has a game (match-ups and game history), and the organiser of a tournament the person registered for.
revoke select on public.profiles from anon, authenticated;
grant select (id, nickname, club, country, avatar_updated_at, created_at) on public.profiles to anon, authenticated;
create or replace function public.can_see_real_name(pid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select pid = auth.uid()
    or exists (select 1 from games g where (g.a = pid or g.b = pid) and can_view(g.tournament_id))
    or exists (select 1 from registrations r where r.profile_id = pid and is_owner(r.tournament_id)) $$;
-- (deliberately runs with the view owner's rights so it can read the hidden columns; the where clause is the rule)
create or replace view public.profile_names as select id, first_name, last_name from public.profiles where public.can_see_real_name(id);
grant select on public.profile_names to anon, authenticated;

-- ---- profile pictures (Supabase Storage) ----------------------------------------------
-- A public bucket 'avatars'; each person may only add, replace or delete files in a folder named after their own account id.
-- Pictures are small (the page shrinks them to 256 pixels) and the bucket refuses anything over 512 KB or not an image.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('avatars', 'avatars', true, 524288, array['image/jpeg', 'image/png', 'image/webp'])
      on conflict (id) do update set public = true, file_size_limit = 524288, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];
    drop policy if exists "avatars: read" on storage.objects;
    create policy "avatars: read" on storage.objects for select to anon, authenticated using (bucket_id = 'avatars');
    drop policy if exists "avatars: add own" on storage.objects;
    create policy "avatars: add own" on storage.objects for insert to authenticated
      with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
    drop policy if exists "avatars: replace own" on storage.objects;
    create policy "avatars: replace own" on storage.objects for update to authenticated
      using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
      with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
    drop policy if exists "avatars: delete own" on storage.objects;
    create policy "avatars: delete own" on storage.objects for delete to authenticated
      using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
end $$;

-- ---- player statistics (for profiles, achievements and trophies) ------------------
-- One row per profile, worked out from finished rounds and finished tournaments. The views run with the viewer's own rights
-- (security_invoker), so a person's record counts only games and tournaments the viewer is allowed to see: someone looking at a
-- profile sees the public part of it, and the owner of the profile sees their own full record.
-- To grant an achievement (e.g. "10 games played", "tournament winner"), test these columns. More can be added here.

create or replace view public.player_stats with (security_invoker = true) as
select p.id as profile_id,
       coalesce(g.games, 0)        as games_played,
       coalesce(g.wins, 0)         as game_wins,
       coalesce(g.draws, 0)        as game_draws,
       coalesce(g.losses, 0)       as game_losses,
       coalesce(g.byes, 0)         as byes,
       coalesce(r.tournaments, 0)  as tournaments_played,
       coalesce(r.firsts, 0)       as tournament_wins,
       coalesce(r.podiums, 0)      as podium_finishes,
       coalesce(r.major_wins, 0)   as major_wins,
       coalesce(r.pts_destroyed, 0) as points_destroyed
from public.profiles p
left join (
  select pl.profile_id,
         count(*) filter (where g.b is not null and g.result is not null)                                          as games,
         count(*) filter (where g.b is not null and ((g.result = 'a' and pl.profile_id = g.a) or (g.result = 'b' and pl.profile_id = g.b))) as wins,
         count(*) filter (where g.b is not null and g.result = 'draw')                                              as draws,
         count(*) filter (where g.b is not null and ((g.result = 'b' and pl.profile_id = g.a) or (g.result = 'a' and pl.profile_id = g.b))) as losses,
         count(*) filter (where g.b is null)                                                                        as byes
  from public.games g
  join public.rounds rd on rd.id = g.round_id and rd.done
  cross join lateral (values (g.a), (g.b)) as pl(profile_id)
  where pl.profile_id is not null
  group by pl.profile_id
) g on g.profile_id = p.id
left join (
  select profile_id, count(*) as tournaments, count(*) filter (where rank = 1) as firsts, count(*) filter (where rank <= 3) as podiums,
         sum(major_wins) as major_wins, sum(pts_destroyed) as pts_destroyed
  from public.tournament_results group by profile_id
) r on r.profile_id = p.id;
grant select on public.player_stats to anon, authenticated;

-- ---- ratings (Glicko-2) -----------------------------------------------------------
-- Everyone starts at 1500 with a rating deviation (RD) of 350; RD shrinks as they play and the number is "provisional" until
-- they have played enough games. One finished tournament is one rating period. Draws score 0.5, byes are ignored.
-- Only RATED tournaments count: finished, not private, with 16 or more players (or forced either way by the site administrator
-- through tournaments.rating_override). Two kinds of rating are kept: 'overall' (the main one) and one per faction, where the
-- faction rating is earned with that faction's games against opponents' OVERALL ratings.
-- recompute_ratings() rebuilds everything from the games, so reopening or deleting a tournament can never leave stale numbers.

create table if not exists public.player_ratings (
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  scope       text not null,                    -- 'overall' or a faction id
  rating      double precision not null default 1500,
  rd          double precision not null default 350,
  vol         double precision not null default 0.06,
  games       integer not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (profile_id, scope)
);
create table if not exists public.rating_history (
  profile_id     uuid not null references public.profiles(id) on delete cascade,
  scope          text not null,
  tournament_id  uuid not null references public.tournaments(id) on delete cascade,
  rating         double precision not null,    -- after this tournament
  rd             double precision not null,
  games          integer not null,             -- games played in this tournament
  score          double precision not null,    -- wins + 0.5 per draw in this tournament
  primary key (profile_id, scope, tournament_id)
);
create index if not exists rating_history_tournament_idx on public.rating_history (tournament_id);

-- does this tournament count for ratings?
create or replace function public.is_rated(tid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select t.status = 'finished' and t.visibility <> 'private'
      and coalesce(t.rating_override, coalesce((select max(r.field_size) from tournament_results r where r.tournament_id = t.id), 0) >= 16)
    from tournaments t where t.id = tid), false) $$;

-- one Glicko-2 rating period for one player: current rating, rd, volatility and the opponents' ratings, rds and scores
create or replace function public.glicko2_update(r0 double precision, rd0 double precision, vol0 double precision,
    opp_r double precision[], opp_rd double precision[], score double precision[])
  returns table (r double precision, rd double precision, vol double precision) language plpgsql immutable as $$
declare
  q constant double precision := 173.7178; tau constant double precision := 0.5; pi_ constant double precision := pi();
  mu double precision := (r0 - 1500) / q;  phi double precision := rd0 / q;
  n integer := coalesce(array_length(opp_r, 1), 0);
  v_inv double precision := 0; dsum double precision := 0;
  gj double precision; ej double precision; v double precision; delta double precision;
  a double precision; aa double precision; bb double precision; cc double precision; fa double precision; fb double precision; fc double precision;
  k integer := 1; sigma double precision; phistar double precision; phinew double precision; munew double precision;
begin
  if n = 0 then return query select r0, rd0, vol0; return; end if;
  for i in 1 .. n loop
    gj := 1 / sqrt(1 + 3 * power(opp_rd[i] / q, 2) / power(pi_, 2));
    ej := 1 / (1 + exp(-gj * (mu - (opp_r[i] - 1500) / q)));
    v_inv := v_inv + gj * gj * ej * (1 - ej);
    dsum := dsum + gj * (score[i] - ej);
  end loop;
  v := 1 / v_inv;  delta := v * dsum;  a := ln(vol0 * vol0);
  -- volatility (Illinois algorithm); f is defined inline as an expression of x
  aa := a;
  if delta * delta > phi * phi + v then bb := ln(delta * delta - phi * phi - v);
  else
    loop
      exit when (exp(a - k * tau) * (delta*delta - phi*phi - v - exp(a - k * tau)) / (2 * power(phi*phi + v + exp(a - k * tau), 2)) - (-k * tau) / (tau*tau)) >= 0;
      k := k + 1;
    end loop;
    bb := a - k * tau;
  end if;
  fa := exp(aa) * (delta*delta - phi*phi - v - exp(aa)) / (2 * power(phi*phi + v + exp(aa), 2)) - (aa - a) / (tau*tau);
  fb := exp(bb) * (delta*delta - phi*phi - v - exp(bb)) / (2 * power(phi*phi + v + exp(bb), 2)) - (bb - a) / (tau*tau);
  k := 0;
  while abs(bb - aa) > 0.000001 and k < 100 loop
    cc := aa + (aa - bb) * fa / (fb - fa);
    fc := exp(cc) * (delta*delta - phi*phi - v - exp(cc)) / (2 * power(phi*phi + v + exp(cc), 2)) - (cc - a) / (tau*tau);
    if fc * fb <= 0 then aa := bb; fa := fb; else fa := fa / 2; end if;
    bb := cc; fb := fc; k := k + 1;
  end loop;
  sigma := exp(aa / 2);
  phistar := sqrt(phi * phi + sigma * sigma);
  phinew := 1 / sqrt(1 / (phistar * phistar) + 1 / v);
  munew := mu + phinew * phinew * dsum;
  return query select q * munew + 1500, q * phinew, sigma;
end $$;

-- rebuild every rating from the games of rated tournaments, one tournament (rating period) at a time, oldest first
create or replace function public.recompute_ratings() returns void language plpgsql security definer set search_path = public as $$
declare t record;
begin
  perform pg_advisory_xact_lock(7001);
  delete from rating_history; delete from player_ratings;
  create temp table if not exists _pg (profile_id uuid, scope text, opp_r double precision, opp_rd double precision, score double precision) on commit drop;
  create temp table if not exists _up (profile_id uuid, scope text, r double precision, rd double precision, vol double precision, games integer, score double precision) on commit drop;
  for t in
    select tr.id from tournaments tr where is_rated(tr.id) order by coalesce(tr.date, tr.created_at::date), tr.created_at, tr.id
  loop
    truncate _pg; truncate _up;
    -- every finished game of this tournament, from each player's side, with the opponent's rating before this tournament
    insert into _pg
    select s.me, sc.scope, coalesce(o.rating, 1500), coalesce(o.rd, 350), s.score
    from (
      select g.a as me, g.b as opp, case g.result when 'a' then 1.0 when 'draw' then 0.5 else 0.0 end as score
        from games g join rounds rd on rd.id = g.round_id and rd.done where g.tournament_id = t.id and g.b is not null and g.result is not null
      union all
      select g.b, g.a, case g.result when 'b' then 1.0 when 'draw' then 0.5 else 0.0 end
        from games g join rounds rd on rd.id = g.round_id and rd.done where g.tournament_id = t.id and g.b is not null and g.result is not null
    ) s
    left join player_ratings o on o.profile_id = s.opp and o.scope = 'overall'
    left join entry_lists el on el.tournament_id = t.id and el.profile_id = s.me
    cross join lateral (select 'overall' as scope union all select el.faction where el.faction is not null and el.faction <> '') sc;
    insert into _up
    select x.profile_id, x.scope, u.r, u.rd, u.vol, x.n, x.sc
    from (select profile_id, scope, array_agg(opp_r) as orr, array_agg(opp_rd) as ord_, array_agg(score) as scs, count(*)::int as n, sum(score) as sc
            from _pg group by profile_id, scope) x
    left join player_ratings cur on cur.profile_id = x.profile_id and cur.scope = x.scope
    cross join lateral glicko2_update(coalesce(cur.rating, 1500), coalesce(cur.rd, 350), coalesce(cur.vol, 0.06), x.orr, x.ord_, x.scs) u;
    insert into player_ratings (profile_id, scope, rating, rd, vol, games, updated_at)
      select u.profile_id, u.scope, u.r, u.rd, u.vol, u.games, now() from _up u
      on conflict (profile_id, scope) do update set rating = excluded.rating, rd = excluded.rd, vol = excluded.vol,
        games = player_ratings.games + excluded.games, updated_at = now();
    insert into rating_history (profile_id, scope, tournament_id, rating, rd, games, score)
      select u.profile_id, u.scope, t.id, u.r, u.rd, u.games, u.score from _up u;
  end loop;
end $$;
revoke all on function public.recompute_ratings() from public, anon;
grant execute on function public.recompute_ratings() to authenticated;

alter table public.player_ratings enable row level security;
alter table public.rating_history enable row level security;
drop policy if exists "ratings: read" on public.player_ratings;
create policy "ratings: read" on public.player_ratings for select to anon, authenticated using (true);
drop policy if exists "rating history: read" on public.rating_history;
create policy "rating history: read" on public.rating_history for select to anon, authenticated using (true);
grant select on public.player_ratings, public.rating_history to anon, authenticated;

-- leaderboard positions: overall needs 5 rated games, a faction rating needs 3 (below that the rating is "provisional")
create or replace view public.rating_ranks with (security_invoker = true) as
select profile_id, scope, rating, rd, games,
       rank() over (partition by scope order by rating desc) as position,
       count(*) over (partition by scope) as ranked_players
from public.player_ratings
where games >= case when scope = 'overall' then 5 else 3 end;
grant select on public.rating_ranks to anon, authenticated;

-- one row per game a player has played (byes excluded) in finished rounds: the base of game history, faction records and matchups.
-- Runs with the viewer's rights, so only games of tournaments they may see appear, and the faction columns are filled only
-- where the viewer may see the army lists (locked lists, or their own).
create or replace view public.player_games with (security_invoker = true) as
select s.profile_id, s.game_id, s.tournament_id, t.name as tournament_name, t.date as tournament_date, s.round_n, s.table_no,
       s.opp_id, s.outcome, s.vp_for, s.vp_against,
       me.faction as faction, me.commander as commander, opp.faction as opp_faction, public.is_rated(s.tournament_id) as rated
from (
  select g.a as profile_id, g.id as game_id, g.tournament_id, rd.n as round_n, g.table_no, g.b as opp_id,
         case g.result when 'a' then 'win' when 'draw' then 'draw' else 'loss' end as outcome, g.vp_a as vp_for, g.vp_b as vp_against
    from public.games g join public.rounds rd on rd.id = g.round_id and rd.done where g.b is not null and g.result is not null
  union all
  select g.b, g.id, g.tournament_id, rd.n, g.table_no, g.a,
         case g.result when 'b' then 'win' when 'draw' then 'draw' else 'loss' end, g.vp_b, g.vp_a
    from public.games g join public.rounds rd on rd.id = g.round_id and rd.done where g.b is not null and g.result is not null
) s
join public.tournaments t on t.id = s.tournament_id
left join public.entry_lists me on me.tournament_id = s.tournament_id and me.profile_id = s.profile_id
left join public.entry_lists opp on opp.tournament_id = s.tournament_id and opp.profile_id = s.opp_id;
grant select on public.player_games to anon, authenticated;

-- ---- live updates (Realtime) ----------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['games', 'rounds', 'registrations', 'entry_lists', 'tournaments'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- make the API pick up any new or changed columns straight away
notify pgrst, 'reload schema';
