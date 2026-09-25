-- ============================================================
-- Avinash Kumar — Digital Edition + Private Library
-- Supabase schema v2. Run in Dashboard -> SQL Editor -> New query.
-- Safe to run even if schema.sql (v1: books/orders/subscribers)
-- was already run — this adds the new system alongside it.
-- ============================================================

-- ------------------------------------------------------------
-- PROFILES  (one row per authenticated user, role-aware)
-- ------------------------------------------------------------
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text,
  email       text,
  role        text not null default 'reader' check (role in ('reader','admin')),
  created_at  timestamptz default now()
);

-- Auto-create a profile row whenever someone signs up via Supabase Auth
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', ''), new.email);
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- ------------------------------------------------------------
-- BOOKS  (digital editions catalog — authoritative price lives here)
-- ------------------------------------------------------------
create table if not exists books_catalog (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,
  title         text not null,
  subtitle      text,
  author        text not null default 'Avinash Kumar',
  description   text,
  cover_url     text,
  edition_type  text not null default 'digital',
  price_inr     numeric(8,2) not null,
  price_usd     numeric(8,2) not null,
  storage_path  text not null,   -- path inside the PRIVATE 'digital-books' bucket
  status        text not null default 'active' check (status in ('active','inactive')),
  created_at    timestamptz default now()
);

insert into books_catalog (slug, title, subtitle, description, price_inr, price_usd, storage_path)
values (
  'invisible-threads',
  'THE MIND FILES',
  'VOL-I: INVISIBLE THREADS',
  'Ten case files exploring the hidden forces that shape human behaviour, perception and choice.',
  249.00,
  9.99,
  'invisible-threads/invisible-threads-digital-edition.pdf'
)
on conflict (slug) do nothing;

-- ------------------------------------------------------------
-- PURCHASES  (one row per checkout attempt)
-- ------------------------------------------------------------
create table if not exists purchases (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  book_id             uuid not null references books_catalog(id),
  razorpay_order_id   text,
  razorpay_payment_id text,
  razorpay_signature  text,
  amount              numeric(8,2) not null,
  currency            text not null default 'INR',
  payment_status      text not null default 'created'
                         check (payment_status in ('created','paid','failed','refunded')),
  purchased_at        timestamptz default now()
);

-- ------------------------------------------------------------
-- LIBRARY  (entitlement — the ONLY table the reader checks)
-- ------------------------------------------------------------
create table if not exists library (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  book_id       uuid not null references books_catalog(id),
  purchase_id   uuid references purchases(id),
  access_status text not null default 'active' check (access_status in ('active','revoked')),
  granted_at    timestamptz default now(),
  unique (user_id, book_id)
);

-- ------------------------------------------------------------
-- READING PROGRESS  (optional now, wired for later)
-- ------------------------------------------------------------
create table if not exists reading_progress (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  book_id             uuid not null references books_catalog(id),
  chapter             text,
  page_or_section     text,
  progress_percentage numeric(5,2) default 0,
  last_read_at        timestamptz default now(),
  unique (user_id, book_id)
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table profiles          enable row level security;
alter table books_catalog     enable row level security;
alter table purchases         enable row level security;
alter table library           enable row level security;
alter table reading_progress  enable row level security;

-- PROFILES: a user can read/update only their own profile
create policy "read own profile"   on profiles for select using (auth.uid() = id);
create policy "update own profile" on profiles for update using (auth.uid() = id);
-- inserts happen only via the handle_new_user() trigger (security definer) — no public insert policy

-- BOOKS: anyone can read the active catalog; nobody writes from the browser
create policy "public can read active books" on books_catalog
  for select using (status = 'active');
-- No insert/update/delete policy exists for anon/authenticated roles —
-- catalog changes must go through the service_role key (admin tooling / SQL editor).

-- PURCHASES: a user can see their own purchase history, and can INSERT
-- a 'created' row for themselves (the pending record before paying) —
-- but can NEVER set payment_status themselves; only the server (service_role,
-- via verify-payment function) can move a row to 'paid'.
create policy "read own purchases" on purchases
  for select using (auth.uid() = user_id);

create policy "create own pending purchase" on purchases
  for insert with check (
    auth.uid() = user_id
    and payment_status = 'created'
  );
-- Deliberately NO update policy for authenticated/anon roles.
-- Only the service_role key (used inside verify-payment.js, which bypasses RLS)
-- may transition a purchase to 'paid'/'failed'.

-- LIBRARY: a user can read their own library only. No insert/update policy
-- for normal users — access is granted exclusively by the server after
-- verified payment, using the service_role key.
create policy "read own library" on library
  for select using (auth.uid() = user_id);

-- READING PROGRESS: a user can read/write only their own progress
create policy "read own progress" on reading_progress
  for select using (auth.uid() = user_id);
create policy "upsert own progress" on reading_progress
  for insert with check (auth.uid() = user_id);
create policy "update own progress" on reading_progress
  for update using (auth.uid() = user_id);

-- ============================================================
-- PRIVATE STORAGE BUCKET
-- Run this once (or create it via Dashboard -> Storage -> New bucket,
-- and UNCHECK "Public bucket"). Bucket name must be 'digital-books'.
-- ============================================================
insert into storage.buckets (id, name, public)
values ('digital-books', 'digital-books', false)
on conflict (id) do nothing;

-- No storage.objects policy is created for the anon/authenticated role on
-- this bucket — that's intentional. The ONLY way to read a file out of it
-- is a short-lived signed URL minted server-side (service_role) by the
-- get-read-url function, after it confirms an 'active' library row exists.
