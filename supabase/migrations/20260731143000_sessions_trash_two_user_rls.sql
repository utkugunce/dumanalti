-- Dumanaltı v7.3.0: oturumlar, 7 günlük çöp kutusu ve iki hesaplı erişim.
-- Güvenlik kilidi bilinçli olarak iki kullanıcı eklenene kadar etkinleşmez.

do $$
declare table_name text;
begin
  foreach table_name in array array['dumanalti_entries', 'dumanalti_sigara', 'dumanalti_icki']
  loop
    execute format('alter table public.%I add column if not exists session_id text', table_name);
    execute format('alter table public.%I add column if not exists deleted_at timestamptz', table_name);
    execute format('alter table public.%I add column if not exists updated_at timestamptz not null default now()', table_name);
  end loop;
end $$;

create or replace function public.dumanalti_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare table_name text;
begin
  foreach table_name in array array['dumanalti_entries', 'dumanalti_sigara', 'dumanalti_icki']
  loop
    execute format('drop trigger if exists dumanalti_touch_updated_at on public.%I', table_name);
    execute format('create trigger dumanalti_touch_updated_at before update on public.%I for each row execute function public.dumanalti_touch_updated_at()', table_name);
  end loop;
end $$;

create table if not exists public.dumanalti_allowed_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 40),
  created_at timestamptz not null default now()
);

alter table public.dumanalti_allowed_users enable row level security;
drop policy if exists "allowed users can read allowlist" on public.dumanalti_allowed_users;
create policy "allowed users can read allowlist" on public.dumanalti_allowed_users
  for select to authenticated
  using (user_id = auth.uid());

create or replace function public.dumanalti_is_allowed()
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.dumanalti_allowed_users where user_id = auth.uid()) $$;

-- Yalnızca allowlist'te tam iki hesap varsa RLS'yi açar; yanlışlıkla canlı uygulamayı
-- anonim kullanıcıların tamamına kapatmayı önler. SQL Editor'da iki UUID eklendikten
-- sonra `select public.dumanalti_activate_rls();` çalıştırılır.
create or replace function public.dumanalti_activate_rls()
returns void language plpgsql security definer set search_path = public
as $$
declare table_name text;
begin
  if (select count(*) from public.dumanalti_allowed_users) <> 2 then
    raise exception 'RLS etkinleştirmek için allowlist tam olarak iki kullanıcı içermeli';
  end if;
  foreach table_name in array array['dumanalti_entries', 'dumanalti_sigara', 'dumanalti_icki']
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists "two users full access" on public.%I', table_name);
    execute format('create policy "two users full access" on public.%I for all to authenticated using (public.dumanalti_is_allowed()) with check (public.dumanalti_is_allowed())', table_name);
  end loop;
end $$;

revoke all on function public.dumanalti_activate_rls() from public, anon, authenticated;
grant execute on function public.dumanalti_activate_rls() to service_role;
