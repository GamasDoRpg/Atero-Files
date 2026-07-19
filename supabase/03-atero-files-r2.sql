-- =========================================================
-- ATERO FILES — MIGRAÇÃO PARA CLOUDFLARE R2
-- Execute depois de:
--   1. supabase/atero-files.sql
--   2. supabase/02-atero-files-restore-policy.sql
-- =========================================================

begin;

alter table public.files_items
  add column if not exists storage_provider text not null default 'supabase',
  add column if not exists upload_status text not null default 'ready',
  add column if not exists upload_expires_at timestamptz,
  add column if not exists upload_final_path text;

update public.files_items set storage_provider = 'supabase' where storage_provider is null;
update public.files_items set upload_status = 'ready' where upload_status is null;

alter table public.files_items
  alter column storage_provider set default 'r2',
  alter column storage_provider set not null,
  alter column upload_status set default 'ready',
  alter column upload_status set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'files_items_storage_provider_check'
      and conrelid = 'public.files_items'::regclass
  ) then
    alter table public.files_items
      add constraint files_items_storage_provider_check
      check (storage_provider in ('supabase', 'r2'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'files_items_upload_status_check'
      and conrelid = 'public.files_items'::regclass
  ) then
    alter table public.files_items
      add constraint files_items_upload_status_check
      check (upload_status in ('pending', 'ready'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'files_items_pending_expiry_check'
      and conrelid = 'public.files_items'::regclass
  ) then
    alter table public.files_items
      add constraint files_items_pending_expiry_check
      check (
        (upload_status = 'ready' and upload_final_path is null)
        or
        (upload_status = 'pending' and upload_expires_at is not null and upload_final_path is not null)
      );
  end if;
end;
$$;

drop index if exists public.files_items_active_name_unique;
create unique index files_items_active_name_unique
on public.files_items (
  owner_id,
  coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
  lower(name)
)
where deleted_at is null and upload_status in ('pending', 'ready');

create index if not exists files_items_pending_uploads_idx
on public.files_items (owner_id, upload_expires_at)
where upload_status = 'pending';

-- Escritas passam somente pelas RPCs abaixo.
revoke insert, update, delete on public.files_items from authenticated;
grant select on public.files_items to authenticated;

create or replace function public.files_create_folder(
  folder_name text,
  target_parent_id uuid default null
)
returns setof public.files_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  normalized_name text := btrim(folder_name);
begin
  if current_user_id is null then raise exception 'É necessário entrar na sua conta.'; end if;
  if char_length(normalized_name) not between 1 and 180 then
    raise exception 'O nome da pasta precisa ter entre 1 e 180 caracteres.';
  end if;

  if target_parent_id is not null and not exists (
    select 1 from public.files_items parent
    where parent.id = target_parent_id
      and parent.owner_id = current_user_id
      and parent.item_type = 'folder'
      and parent.upload_status = 'ready'
      and parent.deleted_at is null
  ) then
    raise exception 'A pasta de destino não existe.';
  end if;

  return query
  insert into public.files_items (
    owner_id, parent_id, name, item_type, storage_path, mime_type,
    extension, size_bytes, is_favorite, storage_provider,
    upload_status, upload_expires_at, upload_final_path
  ) values (
    current_user_id, target_parent_id, normalized_name, 'folder', null, null,
    null, 0, false, 'r2', 'ready', null, null
  )
  returning public.files_items.*;
end;
$$;

create or replace function public.files_update_item(
  target_item_id uuid,
  new_name text default null,
  new_is_favorite boolean default null
)
returns setof public.files_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  normalized_name text;
begin
  if current_user_id is null then raise exception 'É necessário entrar na sua conta.'; end if;
  if new_name is null and new_is_favorite is null then raise exception 'Informe ao menos uma alteração.'; end if;

  if new_name is not null then
    normalized_name := btrim(new_name);
    if char_length(normalized_name) not between 1 and 180 then
      raise exception 'O nome precisa ter entre 1 e 180 caracteres.';
    end if;
  end if;

  return query
  update public.files_items item
  set name = coalesce(normalized_name, item.name),
      is_favorite = coalesce(new_is_favorite, item.is_favorite)
  where item.id = target_item_id
    and item.owner_id = current_user_id
    and item.upload_status = 'ready'
    and item.deleted_at is null
  returning item.*;
end;
$$;

create or replace function public.files_begin_r2_upload(
  target_item_id uuid,
  target_parent_id uuid,
  target_name text,
  target_storage_path text,
  target_final_storage_path text,
  target_mime_type text,
  target_extension text,
  target_size_bytes bigint,
  target_expires_at timestamptz
)
returns setof public.files_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  normalized_name text := btrim(target_name);
  storage_limit bigint;
  used_storage bigint;
begin
  if current_user_id is null then raise exception 'É necessário entrar na sua conta.'; end if;
  if char_length(normalized_name) not between 1 and 180 then raise exception 'Nome de arquivo inválido.'; end if;
  if target_size_bytes <= 0 then raise exception 'O arquivo está vazio.'; end if;
  if target_size_bytes > 5363466240 then raise exception 'O arquivo excede o limite atual de upload único.'; end if;
  if target_expires_at is null or target_expires_at <= now() then raise exception 'A autorização precisa ter validade futura.'; end if;

  if target_storage_path not like ('pending/users/' || current_user_id::text || '/%') then
    raise exception 'Caminho temporário inválido.';
  end if;
  if target_final_storage_path not like ('users/' || current_user_id::text || '/%') then
    raise exception 'Caminho definitivo inválido.';
  end if;

  if target_parent_id is not null and not exists (
    select 1 from public.files_items parent
    where parent.id = target_parent_id
      and parent.owner_id = current_user_id
      and parent.item_type = 'folder'
      and parent.upload_status = 'ready'
      and parent.deleted_at is null
  ) then
    raise exception 'A pasta de destino não existe.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(current_user_id::text, 0));

  select plan.storage_limit_bytes
  into storage_limit
  from public.subscriptions subscription
  join public.plans plan on plan.id = subscription.plan_id
  where subscription.user_id = current_user_id
  limit 1;

  if not found then raise exception 'A assinatura do usuário não foi encontrada.'; end if;

  select coalesce(sum(item.size_bytes), 0)::bigint
  into used_storage
  from public.files_items item
  where item.owner_id = current_user_id
    and item.item_type = 'file'
    and (
      item.upload_status = 'ready'
      or (item.upload_status = 'pending' and item.upload_expires_at > now())
    );

  if storage_limit is not null and used_storage + target_size_bytes > storage_limit then
    raise exception 'Este upload ultrapassa o limite de armazenamento do seu plano.';
  end if;

  return query
  insert into public.files_items (
    id, owner_id, parent_id, name, item_type, storage_path, mime_type,
    extension, size_bytes, is_favorite, storage_provider, upload_status,
    upload_expires_at, upload_final_path
  ) values (
    target_item_id, current_user_id, target_parent_id, normalized_name, 'file',
    target_storage_path, coalesce(nullif(btrim(target_mime_type), ''), 'application/octet-stream'),
    nullif(btrim(target_extension), ''), target_size_bytes, false, 'r2', 'pending',
    target_expires_at, target_final_storage_path
  )
  returning public.files_items.*;
end;
$$;

create or replace function public.files_complete_r2_upload(target_item_id uuid)
returns setof public.files_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  current_item public.files_items%rowtype;
begin
  if current_user_id is null then raise exception 'É necessário entrar na sua conta.'; end if;

  select * into current_item
  from public.files_items item
  where item.id = target_item_id and item.owner_id = current_user_id
  for update;

  if not found then raise exception 'Upload não encontrado.'; end if;
  if current_item.upload_status = 'ready' then
    return query select * from public.files_items where id = target_item_id and owner_id = current_user_id;
    return;
  end if;
  if current_item.storage_provider <> 'r2' or current_item.upload_status <> 'pending' then
    raise exception 'Este registro não representa um upload R2 pendente.';
  end if;
  if current_item.upload_expires_at <= now() then raise exception 'A autorização do upload expirou.'; end if;

  return query
  update public.files_items item
  set storage_path = item.upload_final_path,
      upload_status = 'ready',
      upload_expires_at = null,
      upload_final_path = null
  where item.id = target_item_id and item.owner_id = current_user_id
  returning item.*;
end;
$$;

create or replace function public.files_cancel_r2_upload(target_item_id uuid)
returns table(storage_path text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then raise exception 'É necessário entrar na sua conta.'; end if;

  return query
  delete from public.files_items item
  where item.id = target_item_id
    and item.owner_id = current_user_id
    and item.storage_provider = 'r2'
    and item.upload_status = 'pending'
  returning item.storage_path;
end;
$$;

create or replace function public.files_move_to_trash(target_item_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  affected_count integer;
begin
  if current_user_id is null then raise exception 'É necessário entrar na sua conta.'; end if;
  if not exists (
    select 1 from public.files_items
    where id = target_item_id and owner_id = current_user_id
      and upload_status = 'ready' and deleted_at is null
  ) then raise exception 'Item não encontrado.'; end if;

  with recursive item_tree as (
    select id from public.files_items
    where id = target_item_id and owner_id = current_user_id and upload_status = 'ready'
    union all
    select child.id from public.files_items child
    join item_tree parent on child.parent_id = parent.id
    where child.owner_id = current_user_id and child.upload_status = 'ready'
  )
  update public.files_items item
  set deleted_at = now()
  where item.id in (select id from item_tree) and item.owner_id = current_user_id;

  get diagnostics affected_count = row_count;
  return affected_count;
end;
$$;

create or replace function public.files_restore_tree(target_item_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  affected_count integer;
begin
  if current_user_id is null then raise exception 'É necessário entrar na sua conta.'; end if;
  if not exists (
    select 1 from public.files_items
    where id = target_item_id and owner_id = current_user_id
      and upload_status = 'ready' and deleted_at is not null
  ) then raise exception 'Item não encontrado na lixeira.'; end if;

  with recursive item_tree as (
    select id from public.files_items
    where id = target_item_id and owner_id = current_user_id and upload_status = 'ready'
    union all
    select child.id from public.files_items child
    join item_tree parent on child.parent_id = parent.id
    where child.owner_id = current_user_id and child.upload_status = 'ready'
  )
  update public.files_items item
  set deleted_at = null
  where item.id in (select id from item_tree) and item.owner_id = current_user_id;

  get diagnostics affected_count = row_count;
  return affected_count;
end;
$$;

create or replace function public.files_delete_tree(target_item_id uuid)
returns table(storage_path text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then raise exception 'É necessário entrar na sua conta.'; end if;
  if not exists (
    select 1 from public.files_items
    where id = target_item_id and owner_id = current_user_id and deleted_at is not null
  ) then raise exception 'O item precisa estar na lixeira antes da exclusão permanente.'; end if;

  return query
  with recursive item_tree as (
    select id from public.files_items where id = target_item_id and owner_id = current_user_id
    union all
    select child.id from public.files_items child
    join item_tree parent on child.parent_id = parent.id
    where child.owner_id = current_user_id
  )
  delete from public.files_items item
  using item_tree tree
  where item.id = tree.id and item.owner_id = current_user_id
  returning item.storage_path;
end;
$$;

create or replace function public.files_empty_trash()
returns table(storage_path text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then raise exception 'É necessário entrar na sua conta.'; end if;
  return query
  delete from public.files_items item
  where item.owner_id = current_user_id and item.deleted_at is not null
  returning item.storage_path;
end;
$$;

create or replace function public.files_get_usage()
returns table(used_bytes bigint, limit_bytes bigint, plan_id text)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select
    coalesce((
      select sum(item.size_bytes)
      from public.files_items item
      where item.owner_id = auth.uid()
        and item.item_type = 'file'
        and (
          item.upload_status = 'ready'
          or (item.upload_status = 'pending' and item.upload_expires_at > now())
        )
    ), 0)::bigint,
    plan.storage_limit_bytes,
    subscription.plan_id
  from public.subscriptions subscription
  join public.plans plan on plan.id = subscription.plan_id
  where subscription.user_id = auth.uid()
  limit 1;
$$;

revoke all on function public.files_create_folder(text, uuid) from public;
revoke all on function public.files_update_item(uuid, text, boolean) from public;
revoke all on function public.files_begin_r2_upload(uuid, uuid, text, text, text, text, text, bigint, timestamptz) from public;
revoke all on function public.files_complete_r2_upload(uuid) from public;
revoke all on function public.files_cancel_r2_upload(uuid) from public;
revoke all on function public.files_move_to_trash(uuid) from public;
revoke all on function public.files_restore_tree(uuid) from public;
revoke all on function public.files_delete_tree(uuid) from public;
revoke all on function public.files_empty_trash() from public;
revoke all on function public.files_get_usage() from public;

grant execute on function public.files_create_folder(text, uuid) to authenticated;
grant execute on function public.files_update_item(uuid, text, boolean) to authenticated;
grant execute on function public.files_begin_r2_upload(uuid, uuid, text, text, text, text, text, bigint, timestamptz) to authenticated;
grant execute on function public.files_complete_r2_upload(uuid) to authenticated;
grant execute on function public.files_cancel_r2_upload(uuid) to authenticated;
grant execute on function public.files_move_to_trash(uuid) to authenticated;
grant execute on function public.files_restore_tree(uuid) to authenticated;
grant execute on function public.files_delete_tree(uuid) to authenticated;
grant execute on function public.files_empty_trash() to authenticated;
grant execute on function public.files_get_usage() to authenticated;

commit;
