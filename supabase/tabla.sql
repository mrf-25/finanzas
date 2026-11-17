-- Un documento JSON por usuario con todos los datos de la app.
create table public.finanzas (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null,
  rev bigint not null default 1,
  updated_at timestamptz not null default now(),
  constraint finanzas_tamano check (pg_column_size(data) < 5000000)
);

alter table public.finanzas enable row level security;

create policy "leer mis datos" on public.finanzas
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "crear mis datos" on public.finanzas
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "cambiar mis datos" on public.finanzas
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

revoke all on public.finanzas from anon, authenticated;
grant select, insert, update on public.finanzas to authenticated;

create function public.finanzas_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger finanzas_touch before update on public.finanzas
  for each row execute function public.finanzas_touch();

-- Historial: antes de cada cambio se guarda la versión anterior (las 100 últimas).
create table public.finanzas_historial (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  rev bigint not null,
  data jsonb not null,
  saved_at timestamptz not null default now()
);
create index finanzas_historial_user on public.finanzas_historial (user_id, id desc);

alter table public.finanzas_historial enable row level security;
create policy "leer mi historial" on public.finanzas_historial
  for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.finanzas_historial from anon, authenticated;
grant select on public.finanzas_historial to authenticated;

create function public.finanzas_guardar_historial() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.finanzas_historial (user_id, rev, data) values (old.user_id, old.rev, old.data);
  delete from public.finanzas_historial h
   where h.user_id = old.user_id
     and h.id < (select min(x.id) from (select id from public.finanzas_historial
                                         where user_id = old.user_id order by id desc limit 100) x);
  return new;
end $$;
create trigger finanzas_historial after update on public.finanzas
  for each row when (old.data is distinct from new.data)
  execute function public.finanzas_guardar_historial();

-- Registro cerrado: solo se admite la primera cuenta (la de Mario).
create function public.solo_una_cuenta() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from auth.users) then
    raise exception 'Registro cerrado';
  end if;
  return new;
end $$;
create trigger solo_una_cuenta before insert on auth.users
  for each row execute function public.solo_una_cuenta();

revoke execute on function public.finanzas_touch() from public, anon, authenticated;
revoke execute on function public.finanzas_guardar_historial() from public, anon, authenticated;
revoke execute on function public.solo_una_cuenta() from public, anon, authenticated;
grant execute on function public.solo_una_cuenta() to supabase_auth_admin;