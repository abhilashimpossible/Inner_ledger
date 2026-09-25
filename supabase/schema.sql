-- ThoughtPattern: run this once in Supabase → SQL Editor.
-- Journals are encrypted on the user's device before upload; the server only ever sees ciphertext.

create table if not exists public.profiles (
  user_id    uuid primary key references auth.users on delete cascade,
  salt       text not null,          -- for deriving the key from the user's passphrase
  key_check  text not null,          -- a small encrypted marker used to verify the passphrase
  created_at timestamptz not null default now()
);

create table if not exists public.entries (
  user_id    uuid not null references auth.users on delete cascade,
  id         text not null,           -- entry id (or "__analysis" for the latest Pattern reading)
  iv         text not null default '',
  cipher     text not null default '',
  deleted    boolean not null default false,
  updated_at bigint not null,         -- ms since epoch, set by the device
  primary key (user_id, id)
);
create index if not exists entries_user_updated on public.entries (user_id, updated_at);

alter table public.profiles enable row level security;
alter table public.entries  enable row level security;

-- Each signed-in user can only see and change their own rows.
drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own entries" on public.entries;
create policy "own entries" on public.entries for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
