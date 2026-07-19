-- =========================================================
-- ATERO FILES — SCHEMA, STORAGE, RLS E FUNÇÕES
-- Execute este arquivo inteiro no SQL Editor do Supabase.
-- O script é idempotente e pode ser executado novamente.
-- =========================================================

begin;

create extension if not exists pgcrypto;

insert into public.apps (
  id, name, description, icon_path, launch_url, active, sort_order, category
)
values (
  'files',
  'Atero Files',
  'Organize arquivos, pastas e projetos dos aplicativos Atero.',
  'assets/logos/files.png',
  'https://files.atero.space',
  true,
  9,
  'produtividade'
)
on conflict (id)
do update set
  name = excluded.name,
  description = excluded.description,
  icon_path = excluded.icon_path,
  launch_url = excluded.launch_url,
  active = excluded.active,
  sort_order = excluded.sort_order,
  category = excluded.category;

-- Limites iniciais: Grátis 1 GB, Pro 50 GB, Ultra 200 GB.
alter table public.plans
  add column if not exists storage_limit_bytes bigint;

update public.plans
set storage_limit_bytes = case id
  when 'gratis' then 1073741824
  when 'pro' then 53687091200
  when 'ultra' then 214748364800
  else coalesce(storage_limit_bytes, 1073741824)
end
where storage_limit_bytes is null;

create table if not exists public.files_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  parent_id uuid,
  name text not null check (char_length(btrim(name)) between 1 and 180),
  item_type text not null check (item_type in ('file', 'folder')),
  storage_path text,
  mime_type text,
  extension text,
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  is_favorite boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id),
  constraint files_item_storage_consistency check (
    (item_type = 'folder' and storage_path is null and size_bytes = 0)
    or (item_type = 'file' and storage_path is not null)
  ),
  constraint files_parent_owner_fk
    foreign key (parent_id, owner_id)
    references public.files_items(id, owner_id)
    on delete cascade
);

create index if not exists files_items_owner_parent_idx
  on public.files_items(owner_id, parent_id, item_type, name);
create index if not exists files_items_owner_updated_idx
  on public.files_items(owner_id, updated_at desc)
  where deleted_at is null;
create index if not exists files_items_owner_favorites_idx
  on public.files_items(owner_id, is_favorite, updated_at desc)
  where deleted_at is null and is_favorite;
create index if not exists files_items_owner_trash_idx
  on public.files_items(owner_id, deleted_at desc)
  where deleted_at is not null;
create unique index if not exists files_items_active_name_unique
  on public.files_items (
    owner_id,
    coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name)
  )
  where deleted_at is null;

create or replace function public.files_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists files_items_updated_at on public.files_items;
create trigger files_items_updated_at
before update on public.files_items
for each row execute function public.files_set_updated_at();

alter table public.files_items enable row level security;

drop policy if exists files_items_select_own on public.files_items;
drop policy if exists files_items_insert_own on public.files_items;
drop policy if exists files_items_update_own on public.files_items;
drop policy if exists files_items_delete_own on public.files_items;

create policy files_items_select_own
on public.files_items for select to authenticated
using ((select auth.uid()) = owner_id);

create policy files_items_insert_own
on public.files_items for insert to authenticated
with check (
  (select auth.uid()) = owner_id
  and (
    parent_id is null
    or exists (
      select 1
      from public.files_items parent
      where parent.id = parent_id
        and parent.owner_id = (select auth.uid())
        and parent.item_type = 'folder'
        and parent.deleted_at is null
    )
  )
);

create policy files_items_update_own
on public.files_items for update to authenticated
using ((select auth.uid()) = owner_id)
with check (
  (select auth.uid()) = owner_id
  and (
    parent_id is null
    or exists (
      select 1
      from public.files_items parent
      where parent.id = parent_id
        and parent.owner_id = (select auth.uid())
        and parent.item_type = 'folder'
        and parent.deleted_at is null
    )
  )
);

create policy files_items_delete_own
on public.files_items for delete to authenticated
using ((select auth.uid()) = owner_id);

grant select, insert, update, delete on public.files_items to authenticated;

create or replace function public.files_move_to_trash(target_item_id uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  affected_count integer;
begin
  if not exists (
    select 1 from public.files_items
    where id = target_item_id
      and owner_id = (select auth.uid())
      and deleted_at is null
  ) then
    raise exception 'Item não encontrado.';
  end if;

  with recursive item_tree as (
    select id from public.files_items
    where id = target_item_id and owner_id = (select auth.uid())
    union all
    select child.id
    from public.files_items child
    join item_tree parent on child.parent_id = parent.id
    where child.owner_id = (select auth.uid())
  )
  update public.files_items item
  set deleted_at = now()
  where item.id in (select id from item_tree)
    and item.owner_id = (select auth.uid());

  get diagnostics affected_count = row_count;
  return affected_count;
end;
$$;

create or replace function public.files_restore_tree(target_item_id uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  affected_count integer;
begin
  if not exists (
    select 1 from public.files_items
    where id = target_item_id
      and owner_id = (select auth.uid())
      and deleted_at is not null
  ) then
    raise exception 'Item não encontrado na lixeira.';
  end if;

  with recursive item_tree as (
    select id from public.files_items
    where id = target_item_id and owner_id = (select auth.uid())
    union all
    select child.id
    from public.files_items child
    join item_tree parent on child.parent_id = parent.id
    where child.owner_id = (select auth.uid())
  )
  update public.files_items item
  set deleted_at = null
  where item.id in (select id from item_tree)
    and item.owner_id = (select auth.uid());

  get diagnostics affected_count = row_count;
  return affected_count;
end;
$$;

create or replace function public.files_delete_tree(target_item_id uuid)
returns table(storage_path text)
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.files_items
    where id = target_item_id
      and owner_id = (select auth.uid())
      and deleted_at is not null
  ) then
    raise exception 'O item precisa estar na lixeira antes da exclusão permanente.';
  end if;

  return query
  with recursive item_tree as (
    select id from public.files_items
    where id = target_item_id and owner_id = (select auth.uid())
    union all
    select child.id
    from public.files_items child
    join item_tree parent on child.parent_id = parent.id
    where child.owner_id = (select auth.uid())
  )
  delete from public.files_items item
  using item_tree tree
  where item.id = tree.id
    and item.owner_id = (select auth.uid())
  returning item.storage_path;
end;
$$;

create or replace function public.files_empty_trash()
returns table(storage_path text)
language plpgsql
security invoker
set search_path = public
as $$
begin
  return query
  delete from public.files_items item
  where item.owner_id = (select auth.uid())
    and item.deleted_at is not null
  returning item.storage_path;
end;
$$;

create or replace function public.files_get_usage()
returns table(used_bytes bigint, limit_bytes bigint, plan_id text)
language sql
security invoker
stable
set search_path = public
as $$
  select
    coalesce((
      select sum(item.size_bytes)
      from public.files_items item
      where item.owner_id = (select auth.uid())
        and item.item_type = 'file'
    ), 0)::bigint,
    plan.storage_limit_bytes,
    subscription.plan_id
  from public.subscriptions subscription
  join public.plans plan on plan.id = subscription.plan_id
  where subscription.user_id = (select auth.uid())
  limit 1;
$$;

revoke all on function public.files_move_to_trash(uuid) from public;
revoke all on function public.files_restore_tree(uuid) from public;
revoke all on function public.files_delete_tree(uuid) from public;
revoke all on function public.files_empty_trash() from public;
revoke all on function public.files_get_usage() from public;
grant execute on function public.files_move_to_trash(uuid) to authenticated;
grant execute on function public.files_restore_tree(uuid) to authenticated;
grant execute on function public.files_delete_tree(uuid) to authenticated;
grant execute on function public.files_empty_trash() to authenticated;
grant execute on function public.files_get_usage() to authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('atero-files', 'atero-files', false, 52428800)
on conflict (id)
do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists atero_files_storage_select_own on storage.objects;
drop policy if exists atero_files_storage_insert_own on storage.objects;
drop policy if exists atero_files_storage_update_own on storage.objects;
drop policy if exists atero_files_storage_delete_own on storage.objects;

create policy atero_files_storage_select_own
on storage.objects for select to authenticated
using (
  bucket_id = 'atero-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy atero_files_storage_insert_own
on storage.objects for insert to authenticated
with check (
  bucket_id = 'atero-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy atero_files_storage_update_own
on storage.objects for update to authenticated
using (
  bucket_id = 'atero-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text
)
with check (
  bucket_id = 'atero-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy atero_files_storage_delete_own
on storage.objects for delete to authenticated
using (
  bucket_id = 'atero-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

commit;
