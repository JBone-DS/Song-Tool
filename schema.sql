-- Song Tool: database setup for Supabase (version 2: player accounts, tournament directory, registration).
-- Paste this whole file into Supabase > SQL Editor > New query, then press Run. It is safe to run again later: it only
-- creates what is missing and refreshes the security rules. (If you set up the first version of this file earlier, run
-- migration-v1-to-v2.sql ONCE before this file. It removes the old test tables.)
--
-- Who can do what:
--   * Everyone who signs up (email link) has ONE profile of their own: first and last name, a REQUIRED nickname, club, country, picture.
--     The nickname is the public name; real names are shown only in match-ups, game history and to the person and their organisers.
--   * Anyone can create a tournament and becomes its organiser. Every tournament is public: it is shown in the directory and anyone can view it.
--   * A player asks to join. The organiser approves or declines. Approved players are shown publicly.
--   * A player's army list is private to them and the organiser until the organiser locks lists, then it is visible
--     to everyone who can view the tournament (or, if the organiser chose to, only once round 1 has been drawn).
--   * Players can report the victory points, destroyed units and result of THEIR OWN games while the round is open;
--     the organiser can change anything.
--   * Each person's saved army lists are a PRIVATE library: only the owner can read them. A list becomes visible to others
--     only by being entered in a tournament, under the list rules above.
--   * Team tournaments: teams of 2 to 4 sign up under a captain (no solo entries), the organiser approves the team, and each
--     round pairs team against team, with the players paired one-to-one inside each match-up (see the teams section).
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
  registration_open        boolean not null default true,
  max_players              integer check (max_players is null or max_players > 0),
  lists_locked             boolean not null default false,       -- once true, lists can no longer be changed
  hide_lists_until_round1  boolean not null default false,       -- no longer used: lists are private until a player is matched, and public when the tournament finishes
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
alter table public.tournaments add column if not exists format text not null default 'individual';
alter table public.tournaments add column if not exists team_size integer;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tournaments_format_check') then
    alter table public.tournaments add constraint tournaments_format_check check (format in ('individual', 'team'));
    alter table public.tournaments add constraint tournaments_team_size_check check ((format = 'individual' and team_size is null) or (format = 'team' and team_size between 2 and 4));
  end if;
end $$;

alter table public.entry_lists add column if not exists faction text;
alter table public.entry_lists add column if not exists commander text;
alter table public.entry_lists add column if not exists points integer;
-- every player enters TWO lists (they may be the same list twice) and secretly picks one of them for each game.
-- Both lists must be of the same faction, so `faction` above stands for both; the second list keeps its own commander and points.
alter table public.entry_lists add column if not exists list_code_2 text;
alter table public.entry_lists add column if not exists faction_2 text;
alter table public.entry_lists add column if not exists commander_2 text;
alter table public.entry_lists add column if not exists points_2 integer;

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

-- teams (only used by team tournaments)
create table if not exists public.teams (
  id             uuid primary key default gen_random_uuid(),
  tournament_id  uuid not null references public.tournaments(id) on delete cascade,
  name           text not null check (length(btrim(name)) > 0),
  captain        uuid not null default auth.uid() references public.profiles(id),
  created_at     timestamptz not null default now()
);
create unique index if not exists teams_name_idx on public.teams (tournament_id, lower(btrim(name)));
create index if not exists teams_tournament_idx on public.teams (tournament_id);
-- a team-versus-team pairing in one round; team_b is null when team_a has a bye
create table if not exists public.matches (
  id             uuid primary key default gen_random_uuid(),
  round_id       uuid not null references public.rounds(id) on delete cascade,
  tournament_id  uuid not null references public.tournaments(id) on delete cascade,
  team_a         uuid not null references public.teams(id) on delete cascade,
  team_b         uuid references public.teams(id) on delete cascade
);
create index if not exists matches_round_idx on public.matches (round_id);
alter table public.registrations add column if not exists team_id uuid references public.teams(id) on delete cascade;
alter table public.registrations add column if not exists team_ok boolean not null default false;   -- the captain has accepted this player
alter table public.games add column if not exists match_id uuid references public.matches(id) on delete cascade;
alter table public.games add column if not exists team uuid references public.teams(id) on delete cascade;          -- the team of player a (b is on the other team of the match)
-- has each player locked in a list for this game? (only the fact is public here; which list stays in game_picks until both have locked)
alter table public.games add column if not exists locked_a boolean not null default false;
alter table public.games add column if not exists locked_b boolean not null default false;

-- a player's secret choice of list 1 or 2 for one game. The database shows it to the opponent only once both players have locked in.
create table if not exists public.game_picks (
  game_id        uuid not null references public.games(id) on delete cascade,
  profile_id     uuid not null references public.profiles(id) on delete cascade,
  tournament_id  uuid not null references public.tournaments(id) on delete cascade,
  slot           smallint not null check (slot in (1, 2)),
  locked_at      timestamptz not null default now(),
  primary key (game_id, profile_id)
);
create index if not exists game_picks_tournament_idx on public.game_picks (tournament_id);

create index if not exists tournaments_owner_idx on public.tournaments (owner);
drop index if exists public.tournaments_listed_idx;
create index if not exists tournaments_date_idx on public.tournaments (date);
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
create or replace function public.can_view(tid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from tournaments t where t.id = tid) $$;   -- every tournament is public
create or replace function public.is_locked(tid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select lists_locked from tournaments where id = tid), false) $$;
create or replace function public.can_register(tid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from tournaments t where t.id = tid and t.registration_open and not t.lists_locked) $$;
create or replace function public.has_registration(tid uuid, pid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from registrations where tournament_id = tid and profile_id = pid and status in ('pending', 'approved')) $$;
create or replace function public.is_approved(tid uuid, pid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from registrations where tournament_id = tid and profile_id = pid and status = 'approved') $$;
-- are the army lists public yet? Only once the tournament has finished; until then a list is seen by its player, the organiser and
-- whoever the player has been matched with (see matched_with)
create or replace function public.lists_public(tid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from tournaments t where t.id = tid and t.lists_locked and t.status = 'finished') $$;
-- has the caller been drawn against this player in a game of the tournament? Then they may see both of the player's lists, to choose theirs with
-- the knowledge of what they face (which of the two the player picks stays secret until both have locked in).
create or replace function public.matched_with(tid uuid, pid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from games g where g.tournament_id = tid and g.b is not null
    and ((g.a = auth.uid() and g.b = pid) or (g.b = auth.uid() and g.a = pid))) $$;
create or replace function public.round_open(rid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from rounds where id = rid and not done) $$;
-- have both players of this game locked in their list? (until then neither choice may be seen by anybody else)
create or replace function public.picks_revealed(gid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from games g where g.id = gid and g.b is not null
    and exists (select 1 from game_picks p where p.game_id = g.id and p.profile_id = g.a)
    and exists (select 1 from game_picks p where p.game_id = g.id and p.profile_id = g.b)) $$;
-- may the organiser see this game's lock-ins early? Yes on every table except one they play at themselves (an organiser who is also a player
-- must not see their own opponent's choice)
create or replace function public.organiser_sees_picks(gid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from games g where g.id = gid and is_owner(g.tournament_id) and auth.uid() is distinct from g.a and auth.uid() is distinct from g.b) $$;
-- may the caller lock in a list for this game? (they play in it, it is not a bye and the round is still open)
create or replace function public.can_pick(gid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from games g where g.id = gid and g.b is not null and auth.uid() in (g.a, g.b) and round_open(g.round_id)) $$;
-- team helpers
create or replace function public.is_captain(tid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from teams where id = tid and captain = auth.uid()) $$;
create or replace function public.on_team(tid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from registrations where team_id = tid and profile_id = auth.uid() and team_ok) $$;
create or replace function public.is_team_event(tid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select format = 'team' from tournaments where id = tid), false) $$;

-- may the caller see this profile? their own, or a player in a tournament they can see (the organiser also sees people who asked to join)
create or replace function public.profile_visible(pid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select pid = auth.uid() or exists (select 1 from registrations r where r.profile_id = pid
    and ((r.status = 'approved' and can_view(r.tournament_id)) or is_owner(r.tournament_id)
         or (r.team_id is not null and (is_captain(r.team_id) or on_team(r.team_id))))) $$;

-- ---- triggers: rules that row-level security cannot express --------------------

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists tournaments_touch on public.tournaments;
create trigger tournaments_touch before update on public.tournaments for each row execute function public.touch_updated_at();
drop trigger if exists entry_lists_touch on public.entry_lists;
create trigger entry_lists_touch before update on public.entry_lists for each row execute function public.touch_updated_at();

-- both lists of an entry must be of the same faction; with no second list its details are cleared
create or replace function public.entry_lists_guard() returns trigger language plpgsql as $$
begin
  if new.list_code_2 is null then
    new.faction_2 := null; new.commander_2 := null; new.points_2 := null;
  elsif new.faction_2 is distinct from new.faction then
    raise exception 'Both of your lists must be of the same faction.';
  end if;
  return new;
end $$;
drop trigger if exists entry_lists_guard_check on public.entry_lists;
create trigger entry_lists_guard_check before insert or update on public.entry_lists for each row execute function public.entry_lists_guard();

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

-- team rules for registrations: no solo entries in a team event, the captain's own entry is accepted, a team never holds more than its size,
-- only the captain may accept players (and change nothing else), and the organiser approves only players the captain accepted
create or replace function public.registrations_team_rules() returns trigger language plpgsql security definer set search_path = public as $$
declare tsize integer; tfmt text; cap uuid; ttid uuid;
begin
  select format, team_size into tfmt, tsize from tournaments where id = new.tournament_id;
  if tg_op = 'INSERT' then
    if tfmt = 'team' then
      if new.team_id is null then raise exception 'This is a team tournament: sign up as part of a team.'; end if;
      select captain, tournament_id into cap, ttid from teams where id = new.team_id;
      if ttid is distinct from new.tournament_id then raise exception 'That team is not in this tournament.'; end if;
      new.team_ok := (cap = new.profile_id) or coalesce(current_setting('song.sub', true), '') = '1';   -- a substitute is placed by the organiser
    else
      new.team_id := null; new.team_ok := false;
    end if;
    return new;
  end if;
  -- update
  if new.team_id is distinct from old.team_id or new.profile_id <> old.profile_id or new.tournament_id <> old.tournament_id then
    raise exception 'A registration cannot be moved to another team.';
  end if;
  if not is_owner(new.tournament_id) and (new.status <> old.status or new.dropped <> old.dropped) then
    raise exception 'Only the organiser can change a registration.';
  end if;
  if new.team_ok and not old.team_ok and (select count(*) from registrations where team_id = new.team_id and team_ok and not dropped) >= tsize then
    raise exception 'This team is full.';
  end if;
  if tfmt = 'team' and new.status = 'approved' and old.status <> 'approved' and not new.team_ok then
    raise exception 'The team captain has not accepted this player.';
  end if;
  return new;
end $$;
drop trigger if exists registrations_team_check on public.registrations;
create trigger registrations_team_check before insert or update on public.registrations for each row execute function public.registrations_team_rules();

-- a captain who leaves disbands the team
create or replace function public.registrations_captain_left() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.team_id is not null then delete from teams where id = old.team_id and captain = old.profile_id; end if;
  return old;
end $$;
drop trigger if exists registrations_captain_left_check on public.registrations;
create trigger registrations_captain_left_check after delete on public.registrations for each row execute function public.registrations_captain_left();

-- a tournament cannot approve more players than its limit
create or replace function public.registrations_cap() returns trigger language plpgsql security definer set search_path = public as $$
declare cap integer;
begin
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    select max_players into cap from tournaments where id = new.tournament_id;
    if cap is not null and (select count(*) from registrations where tournament_id = new.tournament_id and status = 'approved' and not dropped) >= cap then
      raise exception 'This tournament is full.';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists registrations_cap_check on public.registrations;
create trigger registrations_cap_check before insert or update on public.registrations for each row execute function public.registrations_cap();

-- players may report their own games, but not move players between tables or change bonus points or an organiser-fixed result;
-- nobody may enter a game until both players have locked in one of their lists their lists
create or replace function public.games_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('song.pick', true), '') = '1' then return new; end if;   -- the lock-in trigger setting the flags
  if not is_owner(new.tournament_id) then
    if new.a is distinct from old.a or new.b is distinct from old.b or new.round_id <> old.round_id or new.table_no <> old.table_no
       or new.tournament_id <> old.tournament_id or new.match_id is distinct from old.match_id or new.team is distinct from old.team or new.bonus_a <> old.bonus_a or new.bonus_b <> old.bonus_b or new.manual <> old.manual
       or new.locked_a <> old.locked_a or new.locked_b <> old.locked_b then
      raise exception 'Players can only report victory points, destroyed units and the result of their own game.';
    end if;
    if old.manual and new.result is distinct from old.result then raise exception 'The organiser has fixed this result.'; end if;
  end if;
  -- a game cannot be entered, by anybody, until both players have locked in one of their lists
  if new.b is not null and not picks_revealed(new.id)
     and ((new.vp_a is not null and new.vp_a is distinct from old.vp_a) or (new.vp_b is not null and new.vp_b is distinct from old.vp_b)
          or (new.result is not null and new.result is distinct from old.result)
          or (new.killed_by_a <> '{}' and new.killed_by_a is distinct from old.killed_by_a) or (new.killed_by_b <> '{}' and new.killed_by_b is distinct from old.killed_by_b)) then
    raise exception 'Both players must lock in one of their lists before the game is entered.';
  end if;
  if is_owner(new.tournament_id) and (new.a is distinct from old.a or new.b is distinct from old.b) then
    -- somebody else now sits at this table: the old lock-ins no longer apply
    perform set_config('song.reset', '1', true);
    delete from game_picks where game_id = new.id;
    perform set_config('song.reset', '', true);
    new.locked_a := false; new.locked_b := false;
  end if;
  new.updated_by = auth.uid(); new.updated_at = now();
  return new;
end $$;
drop trigger if exists games_guard_check on public.games;
create trigger games_guard_check before update on public.games for each row execute function public.games_guard();

-- locking in: the choice must be one the player really has, the lists must be locked, and the public flag on the game is raised
create or replace function public.game_picks_guard() returns trigger language plpgsql security definer set search_path = public as $$
declare g record; e record;
begin
  select * into g from games where id = new.game_id;
  if not found or g.b is null then raise exception 'There is no game to lock in a list for.'; end if;
  if new.profile_id is distinct from g.a and new.profile_id is distinct from g.b then raise exception 'You are not playing in this game.'; end if;
  new.tournament_id := g.tournament_id;
  if not (select lists_locked from tournaments where id = g.tournament_id) then raise exception 'The organiser has not locked the army lists yet.'; end if;
  select * into e from entry_lists where tournament_id = g.tournament_id and profile_id = new.profile_id;
  if not found then raise exception 'You have no army list in this tournament.'; end if;
  if new.slot = 2 and e.list_code_2 is null then raise exception 'You have not entered a second list.'; end if;
  return new;
end $$;
drop trigger if exists game_picks_guard_check on public.game_picks;
create trigger game_picks_guard_check before insert on public.game_picks for each row execute function public.game_picks_guard();

create or replace function public.game_picks_flag() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform set_config('song.pick', '1', true);
  if tg_op = 'INSERT' then
    update games set locked_a = locked_a or (a = new.profile_id), locked_b = locked_b or (b = new.profile_id) where id = new.game_id;
  elsif coalesce(current_setting('song.reset', true), '') <> '1' then   -- the organiser clearing a lock-in
    update games set locked_a = locked_a and (a <> old.profile_id), locked_b = locked_b and (b is distinct from old.profile_id) where id = old.game_id;
  end if;
  perform set_config('song.pick', '', true);
  return null;
end $$;
drop trigger if exists game_picks_flag_check on public.game_picks;
create trigger game_picks_flag_check after insert or delete on public.game_picks for each row execute function public.game_picks_flag();

-- ---- security: row level security on every table -----------------------------

alter table public.profiles       enable row level security;
alter table public.tournaments    enable row level security;
alter table public.registrations  enable row level security;
alter table public.saved_lists    enable row level security;
alter table public.entry_lists    enable row level security;
alter table public.tournament_results enable row level security;
alter table public.rounds         enable row level security;
alter table public.games          enable row level security;
alter table public.game_picks     enable row level security;

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
-- every tournament is public: the old "visibility" setting is gone
alter table public.tournaments drop column if exists visibility;
create policy "tournaments: read" on public.tournaments for select to anon, authenticated using (true);
drop function if exists public.is_member(uuid);
drop policy if exists "tournaments: create" on public.tournaments;
create policy "tournaments: create" on public.tournaments for insert to authenticated with check (owner = auth.uid());
drop policy if exists "tournaments: organiser changes" on public.tournaments;
create policy "tournaments: organiser changes" on public.tournaments for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
drop policy if exists "tournaments: organiser deletes" on public.tournaments;
create policy "tournaments: organiser deletes" on public.tournaments for delete to authenticated using (owner = auth.uid());

-- registrations: players ask to join (always "pending"); only the organiser approves or declines
drop policy if exists "registrations: read" on public.registrations;
create policy "registrations: read" on public.registrations for select to anon, authenticated
  using (profile_id = auth.uid() or public.is_owner(tournament_id) or (status = 'approved' and public.can_view(tournament_id))
         or (team_id is not null and (public.is_captain(team_id) or public.on_team(team_id))));
drop policy if exists "registrations: ask to join" on public.registrations;
create policy "registrations: ask to join" on public.registrations for insert to authenticated
  with check (profile_id = auth.uid() and status = 'pending' and not dropped and public.can_register(tournament_id));
drop policy if exists "registrations: organiser decides" on public.registrations;
create policy "registrations: organiser decides" on public.registrations for update to authenticated
  using (public.is_owner(tournament_id)) with check (public.is_owner(tournament_id));
drop policy if exists "registrations: captain accepts" on public.registrations;
create policy "registrations: captain accepts" on public.registrations for update to authenticated
  using (team_id is not null and public.is_captain(team_id)) with check (team_id is not null and public.is_captain(team_id));
drop policy if exists "registrations: withdraw or remove" on public.registrations;
create policy "registrations: withdraw or remove" on public.registrations for delete to authenticated
  using (public.is_owner(tournament_id) or (profile_id = auth.uid() and not public.is_locked(tournament_id))
         or (team_id is not null and public.is_captain(team_id) and not public.is_locked(tournament_id)));

-- teams and matches: anyone who can view the tournament reads; the captain creates, renames and disbands; the organiser runs matches
alter table public.teams   enable row level security;
alter table public.matches enable row level security;
drop policy if exists "teams: read" on public.teams;
create policy "teams: read" on public.teams for select to anon, authenticated using (public.can_view(tournament_id));
drop policy if exists "teams: create" on public.teams;
create policy "teams: create" on public.teams for insert to authenticated
  with check (captain = auth.uid() and public.can_register(tournament_id) and public.is_team_event(tournament_id) and not public.has_registration(tournament_id, auth.uid()));
drop policy if exists "teams: rename" on public.teams;
create policy "teams: rename" on public.teams for update to authenticated
  using (captain = auth.uid() and not public.is_locked(tournament_id)) with check (captain = auth.uid() and not public.is_locked(tournament_id));
drop policy if exists "teams: disband" on public.teams;
create policy "teams: disband" on public.teams for delete to authenticated
  using (public.is_owner(tournament_id) or (captain = auth.uid() and not public.is_locked(tournament_id)));
drop policy if exists "matches: read" on public.matches;
create policy "matches: read" on public.matches for select to anon, authenticated using (public.can_view(tournament_id));
drop policy if exists "matches: organiser writes" on public.matches;
create policy "matches: organiser writes" on public.matches for all to authenticated using (public.is_owner(tournament_id)) with check (public.is_owner(tournament_id));

-- army lists: private to their player and the organiser; an opponent sees both lists once they are matched; everyone once the tournament has finished
drop policy if exists "entry_lists: read" on public.entry_lists;
create policy "entry_lists: read" on public.entry_lists for select to anon, authenticated
  using (profile_id = auth.uid() or public.is_owner(tournament_id) or public.matched_with(tournament_id, profile_id)
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

-- game_picks: you always see your own choice; the other player's (and everyone else's) only once both players have locked in.
-- The organiser also sees them early, except on a table they play at themselves.
-- A player can lock in once and cannot change it; the organiser can clear a lock-in (clear_lock_in).
drop policy if exists "game_picks: read" on public.game_picks;
create policy "game_picks: read" on public.game_picks for select to anon, authenticated
  using (profile_id = auth.uid() or public.picks_revealed(game_id) or public.organiser_sees_picks(game_id));
drop policy if exists "game_picks: lock in" on public.game_picks;
create policy "game_picks: lock in" on public.game_picks for insert to authenticated
  with check (profile_id = auth.uid() and public.can_pick(game_id));
drop policy if exists "game_picks: organiser clears" on public.game_picks;   -- (replaced by clear_lock_in below: the organiser cannot read a hidden choice, so cannot delete it directly)
-- the organiser locks in a list for a player who cannot or will not (absent, no connection). The same checks apply as for the player's own lock-in
create or replace function public.organiser_lock_in(gid uuid, pid uuid, slot integer) returns void language plpgsql security definer set search_path = public as $$
declare g record;
begin
  select * into g from games where id = gid;
  if not found or not is_owner(g.tournament_id) then raise exception 'Only the organiser can lock in a list for a player.'; end if;
  if not round_open(g.round_id) then raise exception 'That round has finished.'; end if;
  if exists (select 1 from game_picks where game_id = gid and profile_id = pid) then raise exception 'That player has already locked in.'; end if;
  insert into game_picks (game_id, profile_id, tournament_id, slot) values (gid, pid, g.tournament_id, slot::smallint);   -- the guard trigger validates it
end $$;
-- the organiser clears both lock-ins of a game, e.g. after a mistake
create or replace function public.clear_lock_in(gid uuid) returns void language plpgsql security definer set search_path = public as $$
declare tid uuid;
begin
  select tournament_id into tid from games where id = gid;
  if tid is null or not is_owner(tid) then raise exception 'Only the organiser can clear a lock-in.'; end if;
  delete from game_picks where game_id = gid;   -- the trigger lowers the flags on the game
end $$;

-- ---- access: the API may only do what the rules above allow ---------------------

grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.tournaments, public.registrations, public.entry_lists, public.tournament_results, public.rounds, public.games, public.teams, public.matches, public.game_picks to anon;
grant select, insert, update, delete on public.profiles, public.tournaments, public.registrations, public.entry_lists, public.tournament_results, public.rounds, public.games, public.teams, public.matches to authenticated;
grant select, insert on public.game_picks to authenticated;   -- a lock-in is never changed, only made (the organiser can clear one with clear_lock_in)
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
  select coalesce((select t.status = 'finished'
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
-- ---- substitutes: the organiser can replace a player (a team member or anyone else) with any other person with a profile ----
-- find_profiles: the organiser searches nicknames for somebody who is not already playing
create or replace function public.find_profiles(tid uuid, q text) returns table(id uuid, nickname text, club text, country text)
language sql stable security definer set search_path = public as $$
  select p.id, p.nickname, p.club, p.country from profiles p
  where is_owner(tid) and length(trim(q)) >= 2
    and p.nickname ilike '%' || replace(replace(replace(trim(q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
    and not exists (select 1 from registrations r where r.tournament_id = tid and r.profile_id = p.id and r.status = 'approved' and not r.dropped)
  order by p.nickname limit 8 $$;
-- substitute_player: marks the old player as dropped and enters the new one, approved, in the same team
create or replace function public.substitute_player(tid uuid, old_pid uuid, new_pid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare tm uuid; oldrow registrations%rowtype; newrow registrations%rowtype;
begin
  if not is_owner(tid) then raise exception 'Only the organiser can substitute players.'; end if;
  select * into oldrow from registrations where tournament_id = tid and profile_id = old_pid and status = 'approved';
  if not found then raise exception 'That player is not in this tournament.'; end if;
  if old_pid = new_pid then raise exception 'Choose somebody else.'; end if;
  select * into newrow from registrations where tournament_id = tid and profile_id = new_pid;
  if found then
    if newrow.status = 'approved' and not newrow.dropped then raise exception 'That person is already playing in this tournament.'; end if;
    if newrow.team_id is not null and exists (select 1 from teams where id = newrow.team_id and captain = new_pid) then raise exception 'That person is the captain of a team here.'; end if;
    delete from registrations where tournament_id = tid and profile_id = new_pid;
  end if;
  update registrations set dropped = true where tournament_id = tid and profile_id = old_pid;
  perform set_config('song.sub', '1', true);
  insert into registrations (tournament_id, profile_id, status, dropped, team_id, team_ok)
    values (tid, new_pid, 'approved', false, oldrow.team_id, oldrow.team_id is not null);
  perform set_config('song.sub', '', true);
end $$;
revoke all on function public.find_profiles(uuid, text) from public, anon;
grant execute on function public.find_profiles(uuid, text) to authenticated;
revoke all on function public.substitute_player(uuid, uuid, uuid) from public, anon;
grant execute on function public.substitute_player(uuid, uuid, uuid) to authenticated;

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

-- the Rankings page: ranked players with their public details (nickname, club, country), by scope ('overall' or a faction id)
create or replace view public.ranking_board with (security_invoker = true) as
select r.profile_id, r.scope, r.rating, r.rd, r.games, p.nickname, p.club, p.country, p.avatar_updated_at
from public.rating_ranks r join public.profiles p on p.id = r.profile_id;
grant select on public.ranking_board to anon, authenticated;

-- one row per game a player has played (byes excluded) in finished rounds: the base of game history, faction records and matchups.
-- Runs with the viewer's rights, so only games of tournaments they may see appear, and the faction columns are filled only
-- where the viewer may see the army lists (locked lists, or their own).
create or replace view public.player_games with (security_invoker = true) as
select s.profile_id, s.game_id, s.tournament_id, t.name as tournament_name, t.date as tournament_date, s.round_n, s.table_no,
       s.opp_id, s.outcome, s.vp_for, s.vp_against,
       me.faction as faction, case when pk.slot = 2 then me.commander_2 else me.commander end as commander, opp.faction as opp_faction, public.is_rated(s.tournament_id) as rated
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
left join public.game_picks pk on pk.game_id = s.game_id and pk.profile_id = s.profile_id
left join public.entry_lists opp on opp.tournament_id = s.tournament_id and opp.profile_id = s.opp_id;
grant select on public.player_games to anon, authenticated;

-- ---- live updates (Realtime) ----------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['games', 'rounds', 'registrations', 'entry_lists', 'tournaments', 'teams', 'matches', 'game_picks'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- make the API pick up any new or changed columns straight away
notify pgrst, 'reload schema';
