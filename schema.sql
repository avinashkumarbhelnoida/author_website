-- ============================================================
-- Avinash Kumar Author Portal — Supabase schema
-- Run this in Supabase: Dashboard -> SQL Editor -> New query
-- ============================================================

-- 1. BOOKS -----------------------------------------------------
create table if not exists books (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,          -- e.g. 'invisible-threads'
  title           text not null,
  genres          text[] not null default '{}',  -- e.g. {'psychological-thriller','mystery'}
  price           numeric(6,2),                  -- null if not for sale yet
  status          text not null default 'coming_soon'
                    check (status in ('available','coming_soon')),
  blurb           text,
  front_cover_url text,                          -- Supabase Storage public URL
  full_cover_url  text,                          -- wraparound cover
  book_page_slug  text,                          -- e.g. 'invisible-threads.html', null if none yet
  sort_order      int default 0,
  created_at      timestamptz default now()
);

-- 2. ORDERS ------------------------------------------------------
-- One row per purchase attempt/interest. Starts as 'pending' until
-- Stripe (or manual fulfillment) marks it 'paid'.
create table if not exists orders (
  id              uuid primary key default gen_random_uuid(),
  book_id         uuid references books(id),
  customer_email  text not null,
  amount          numeric(6,2),
  status          text not null default 'pending'
                    check (status in ('pending','paid','cancelled')),
  created_at      timestamptz default now()
);

-- 3. SUBSCRIBERS (journal / "notify me" signups) ------------------
create table if not exists subscribers (
  id              uuid primary key default gen_random_uuid(),
  email           text unique not null,
  interested_book uuid references books(id),     -- optional: which coming-soon book
  created_at      timestamptz default now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- Public (anon key, i.e. your live website) can READ books,
-- and INSERT into orders/subscribers, but cannot write books.
-- Only an authenticated admin (you, logged into /admin.html)
-- can insert/update/delete books or read orders/subscribers.
-- ============================================================

alter table books enable row level security;
alter table orders enable row level security;
alter table subscribers enable row level security;

-- Public can read all books
create policy "Public can read books"
  on books for select
  using (true);

-- Only logged-in users (admin) can modify books
create policy "Admin can manage books"
  on books for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- Public can create orders (checkout / interest), but not read others' orders
create policy "Public can create orders"
  on orders for insert
  with check (true);

create policy "Admin can read/manage orders"
  on orders for select
  using (auth.role() = 'authenticated');

create policy "Admin can update orders"
  on orders for update
  using (auth.role() = 'authenticated');

-- Public can sign up, only admin can read the list
create policy "Public can subscribe"
  on subscribers for insert
  with check (true);

create policy "Admin can read subscribers"
  on subscribers for select
  using (auth.role() = 'authenticated');
