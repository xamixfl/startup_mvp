-- Auth/session schema (profiles-based).
-- Assumes you already have table `profiles` with primary key `id` (uuid).

create extension if not exists "uuid-ossp";

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
