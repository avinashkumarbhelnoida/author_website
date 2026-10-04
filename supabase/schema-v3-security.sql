-- ============================================================
-- Avinash Kumar — Security fix v3: admin-only access
-- Run in Supabase: Dashboard -> SQL Editor -> New query.
-- Safe to run more than once, and safe whether or not schema.sql (v1)
-- was ever run.
--
-- WHY: schema.sql (v1) treated ANY signed-in user as an admin
-- (auth.role() = 'authenticated'). Since schema-v2 lets any reader create
-- an account, a reader could edit/delete the `books` table and read every
-- email in `orders` and `subscribers`. Separately, the v2 "update own
-- profile" policy let a reader change their OWN `role` to 'admin'.
--
-- AFTER RUNNING: make yourself an admin (replace the email):
--   update public.profiles set role = 'admin'
--   where email = 'authoravinashkumar@gmail.com';
-- ============================================================

-- 1. is_admin(): true only for signed-in users whose profile role is 'admin'.
--    SECURITY DEFINER so it can read profiles regardless of RLS.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- 2. Readers may edit their own name/email, but never their role.
revoke update on public.profiles from anon, authenticated;
grant update (name, email) on public.profiles to authenticated;

-- 3. Replace the v1 "any signed-in user is admin" policies, if v1 exists.
do $$
begin
  if to_regclass('public.books') is not null then
    drop policy if exists "Admin can manage books" on public.books;
    create policy "Admin can manage books" on public.books
      for all using (public.is_admin()) with check (public.is_admin());
  end if;

  if to_regclass('public.orders') is not null then
    drop policy if exists "Admin can read/manage orders" on public.orders;
    drop policy if exists "Admin can update orders" on public.orders;
    create policy "Admin can read/manage orders" on public.orders
      for select using (public.is_admin());
    create policy "Admin can update orders" on public.orders
      for update using (public.is_admin());
  end if;

  if to_regclass('public.subscribers') is not null then
    drop policy if exists "Admin can read subscribers" on public.subscribers;
    create policy "Admin can read subscribers" on public.subscribers
      for select using (public.is_admin());
  end if;
end $$;

-- 4. Purchases are created only by the server (create-order function, which
--    uses the service role). Readers never need to insert them directly.
drop policy if exists "create own pending purchase" on public.purchases;
