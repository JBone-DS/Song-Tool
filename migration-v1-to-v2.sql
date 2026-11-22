-- ONE-OFF: run this ONLY if you ran the first version of schema.sql. It removes the old tables and ALL tournament data
-- in them (profiles, tournaments, players, rounds, games), because version 2 stores things differently. Then run schema.sql.
-- If you have not run the first version, skip this file.
drop table if exists public.games cascade;
drop table if exists public.rounds cascade;
drop table if exists public.tournament_players cascade;
drop table if exists public.entry_lists cascade;
drop table if exists public.registrations cascade;
drop table if exists public.tournaments cascade;
drop table if exists public.profiles cascade;
drop function if exists public.touch_updated_at() cascade;
