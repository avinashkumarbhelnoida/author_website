-- ============================================================
-- v4: Reader bookmarks
-- Run once in the Supabase SQL Editor, after schema-v2.sql and
-- schema-v3-security.sql. Safe to re-run.
--
-- Reading progress already lives in `reading_progress` (v2); the reader
-- writes "Page N" to page_or_section and the % to progress_percentage.
-- ============================================================

create table if not exists public.reader_bookmarks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  book_id     uuid not null references public.books_catalog(id),
  page        integer not null check (page > 0),
  label       text,
  created_at  timestamptz default now(),
  unique (user_id, book_id, page)
);

alter table public.reader_bookmarks enable row level security;

-- A reader can see, add and remove only their own bookmarks, and only for
-- books that are actively in their library.
drop policy if exists "read own bookmarks" on public.reader_bookmarks;
create policy "read own bookmarks" on public.reader_bookmarks
  for select using (auth.uid() = user_id);

drop policy if exists "add own bookmarks" on public.reader_bookmarks;
create policy "add own bookmarks" on public.reader_bookmarks
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.library l
      where l.user_id = auth.uid() and l.book_id = reader_bookmarks.book_id and l.access_status = 'active'
    )
  );

drop policy if exists "remove own bookmarks" on public.reader_bookmarks;
create policy "remove own bookmarks" on public.reader_bookmarks
  for delete using (auth.uid() = user_id);
