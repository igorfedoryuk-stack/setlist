-- Сетлист гурту: налаштування бази Supabase (вхід через Google + список дозволених пошт).
-- Встав увесь скрипт у Supabase → SQL Editor → New query і натисни Run.
-- Скрипт можна запускати повторно — дані й список учасників не зникнуть.
-- Пошти учасників додаються окремо: Table Editor → members (див. README).

-- Усі дані сайту: пісні, пресети, матеріали, коментарі, шпаргалка.
create table if not exists public.docs (
  collection text not null,
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);
alter table public.docs enable row level security;   -- без політик: напряму таблицю не прочитати
revoke all on public.docs from anon, authenticated;

-- Хто має доступ: Google-пошта і ім'я, яким підписуються коментарі.
create table if not exists public.members (
  email      text primary key check (email = lower(email)),
  name       text,
  created_at timestamptz not null default now()
);
alter table public.members enable row level security;
revoke all on public.members from anon, authenticated;

-- Прибираємо залишки попередньої версії з паролем гурту, якщо вона запускалась.
drop function if exists public.api_check(text);
drop function if exists public.api_list(text, text);
drop function if exists public.api_stamp(text);
drop function if exists public.api_set(text, text, text, jsonb);
drop function if exists public.api_update(text, text, text, jsonb);
drop function if exists public.api_delete(text, text, text);
drop function if exists public._band_guard(text);
drop function if exists public._band_ok(text);
drop policy if exists "band files read"   on storage.objects;
drop policy if exists "band files upload" on storage.objects;
drop policy if exists "band files delete" on storage.objects;
drop function if exists public.is_band_folder(text);
drop function if exists public.files_folder();
drop table if exists public.band_secret;

-- Чи є пошта того, хто увійшов, у списку учасників.
create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members m
                 where m.email = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

create or replace function public._member_guard() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member() then
    raise exception 'not a band member' using errcode = '42501';
  end if;
end $$;

-- Хто я: пошта, ім'я зі списку й чи є доступ.
create or replace function public.api_me() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'email',  lower(coalesce(auth.jwt() ->> 'email', '')),
    'member', public.is_member(),
    'name',   (select m.name from public.members m where m.email = lower(coalesce(auth.jwt() ->> 'email', '')))
  );
$$;

create or replace function public.api_list(p_collection text)
returns table (id text, data jsonb, updated_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._member_guard();
  return query select d.id, d.data, d.updated_at from public.docs d where d.collection = p_collection;
end $$;

-- Швидка перевірка, чи щось змінилося (для автооновлення сторінки).
create or replace function public.api_stamp()
returns table (collection text, n bigint, last timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._member_guard();
  return query select d.collection, count(*), max(d.updated_at) from public.docs d group by d.collection;
end $$;

create or replace function public.api_set(p_collection text, p_id text, p_data jsonb)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare t timestamptz := clock_timestamp();
begin
  perform public._member_guard();
  insert into public.docs (collection, id, data, updated_at) values (p_collection, p_id, coalesce(p_data, '{}'::jsonb), t)
  on conflict (collection, id) do update set data = excluded.data, updated_at = t;
  return t;
end $$;

create or replace function public.api_update(p_collection text, p_id text, p_patch jsonb)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare t timestamptz := clock_timestamp();
begin
  perform public._member_guard();
  insert into public.docs (collection, id, data, updated_at) values (p_collection, p_id, coalesce(p_patch, '{}'::jsonb), t)
  on conflict (collection, id) do update set data = public.docs.data || excluded.data, updated_at = t;
  return t;
end $$;

create or replace function public.api_delete(p_collection text, p_id text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._member_guard();
  delete from public.docs where collection = p_collection and id = p_id;
end $$;

revoke execute on function public._member_guard() from public, anon, authenticated;
revoke execute on function public.is_member(), public.api_me(), public.api_list(text), public.api_stamp(),
  public.api_set(text, text, jsonb), public.api_update(text, text, jsonb), public.api_delete(text, text)
  from public, anon;
grant execute on function public.is_member(), public.api_me(), public.api_list(text), public.api_stamp(),
  public.api_set(text, text, jsonb), public.api_update(text, text, jsonb), public.api_delete(text, text)
  to authenticated;

-- Файли (PDF): завантажувати й видаляти можуть лише учасники гурту.
-- Відкрити файл можна за прямим посиланням із випадковою назвою, яке бачать лише учасники.
insert into storage.buckets (id, name, public, file_size_limit)
values ('files', 'files', true, 20971520)
on conflict (id) do update set public = true, file_size_limit = 20971520;

drop policy if exists "members files read"   on storage.objects;
drop policy if exists "members files upload" on storage.objects;
drop policy if exists "members files delete" on storage.objects;
create policy "members files read" on storage.objects for select to authenticated
  using (bucket_id = 'files' and public.is_member());
create policy "members files upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'files' and public.is_member());
create policy "members files delete" on storage.objects for delete to authenticated
  using (bucket_id = 'files' and public.is_member());

select 'Готово: базу налаштовано' as result;
