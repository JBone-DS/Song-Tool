-- ONE-OFF: run this ONLY if you already ran schema.sql (version 2) before profiles had first name / last name / nickname.
-- It keeps your existing profiles: the old single name becomes the first name. Then run schema.sql (it is safe to re-run).
-- If you have not run schema.sql yet, or you ran migration-v1-to-v2.sql and then the new schema.sql, skip this file.
alter table public.profiles add column if not exists first_name text;
alter table public.profiles add column if not exists last_name text not null default '';
alter table public.profiles add column if not exists nickname text not null default '';
alter table public.profiles add column if not exists avatar_updated_at timestamptz;
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'name') then
    update public.profiles set first_name = coalesce(nullif(btrim(first_name), ''), name);
    alter table public.profiles drop column name;
  end if;
  update public.profiles set first_name = 'Player' where first_name is null or btrim(first_name) = '';
  alter table public.profiles alter column first_name set not null;
  if not exists (select 1 from pg_constraint where conname = 'profiles_first_name_check') then
    alter table public.profiles add constraint profiles_first_name_check check (length(btrim(first_name)) > 0);
  end if;
end $$;
alter table public.profiles drop column if exists faction;
