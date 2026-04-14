-- Add missing profile columns that the application expects
-- These columns are used by the frontend and API

alter table profiles
  add column if not exists username text unique,
  add column if not exists full_name text,
  add column if not exists age integer,
  add column if not exists location text,
  add column if not exists city text,
  add column if not exists about text,
  add column if not exists bio text,
  add column if not exists description text,
  add column if not exists role text default 'user';

-- Add default values for new columns where needed
update profiles set username = email where username is null and email is not null;
