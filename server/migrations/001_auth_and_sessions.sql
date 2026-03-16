-- Auth/session schema (profiles-based).
-- Assumes you already have table `profiles` with primary key `id` (uuid).

create extension if not exists "uuid-ossp";

-- Ensure profiles.id exists and can be referenced by foreign keys.
-- Some older schemas may have `profiles` without a PK/unique constraint on `id`.
do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'id'
  ) then
    alter table profiles add column id uuid;
  end if;

  -- Backfill missing ids (safe for existing rows).
  update profiles set id = uuid_generate_v4() where id is null;

  -- Ensure not-null for PK.
  begin
    alter table profiles alter column id set not null;
  exception when others then
    -- If the column type/constraint is incompatible, fail with a clearer message.
    raise exception 'Cannot enforce profiles.id NOT NULL. Check profiles.id column type and existing data.';
  end;

  -- Guard against duplicates before adding PK/unique constraint.
  if exists (
    select 1
    from profiles
    group by id
    having count(*) > 1
  ) then
    raise exception 'profiles.id contains duplicates. Deduplicate before applying sessions FK.';
  end if;

  -- Add a primary key on id if none exists (Postgres has no IF NOT EXISTS for PK).
  if not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relname = 'profiles'
      and c.contype = 'p'
  ) then
    alter table profiles add constraint profiles_pkey primary key (id);
  end if;
end $$;

alter table profiles
  add column if not exists email text unique,
  add column if not exists password_hash text,
  add column if not exists last_login timestamptz;

create index if not exists idx_profiles_email on profiles(email);

create table if not exists sessions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references profiles(id) on delete cascade,
  token text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists sessions_user_id_idx on sessions(user_id);
create index if not exists sessions_token_idx on sessions(token);
