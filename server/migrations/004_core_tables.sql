-- Core tables for meetings, chats, and participants
-- Run after migrations 001, 002, 003

-- Topics table (referenced by meetings)
create table if not exists topics (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  sort_order integer,
  is_group boolean default false,
  color text,
  icon text,
  created_at timestamptz not null default now()
);

-- Cities table
create table if not exists cities (
  id uuid primary key default uuid_generate_v4(),
  name text not null unique
);

-- Meetings table
create table if not exists meetings (
  id uuid primary key default uuid_generate_v4(),
  creator_id uuid not null references profiles(id) on delete cascade,
  chat_id uuid references chats(id) on delete set null,
  title text not null,
  full_description text,
  topic uuid references topics(id) on delete set null,
  location text,
  max_slots integer,
  current_slots integer default 0,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Table-connector: meeting participants
create table if not exists "table-connector" (
  id uuid primary key default uuid_generate_v4(),
  meeting_id uuid not null references meetings(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Chats table
create table if not exists chats (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid not null references profiles(id) on delete cascade,
  meeting_id uuid references meetings(id) on delete set null,
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Chat members table
create table if not exists chat_members (
  id uuid primary key default uuid_generate_v4(),
  chat_id uuid not null references chats(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  status text default 'pending' check (status in ('pending', 'approved', 'rejected')),
  role text default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(chat_id, user_id)
);

-- Chat messages table
create table if not exists chat_messages (
  id uuid primary key default uuid_generate_v4(),
  chat_id uuid not null references chats(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete set null,
  content text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Reports table
create table if not exists reports (
  id uuid primary key default uuid_generate_v4(),
  report_type text not null check (report_type in ('user', 'event', 'chat')),
  reported_item_id uuid,
  reported_by_user_id uuid references profiles(id) on delete set null,
  reason text,
  description text,
  status text default 'pending' check (status in ('pending', 'resolved', 'dismissed')),
  admin_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Bans table
create table if not exists bans (
  id uuid primary key default uuid_generate_v4(),
  ban_type text not null,
  banned_item_id uuid,
  banned_by_user_id uuid references profiles(id) on delete set null,
  reason text,
  is_permanent boolean default false,
  ban_until timestamptz,
  is_active boolean default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Ban appeals table
create table if not exists ban_appeals (
  id uuid primary key default uuid_generate_v4(),
  ban_id uuid not null references bans(id) on delete cascade,
  appealed_by_user_id uuid references profiles(id) on delete set null,
  appeal_reason text,
  status text default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Notifications table
create table if not exists notifications (
  id uuid primary key default uuid_generate_v4(),
  admin_profile_id uuid references profiles(id) on delete cascade,
  notification_type text,
  related_table text,
  related_id uuid,
  title text,
  message text,
  is_read boolean default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
