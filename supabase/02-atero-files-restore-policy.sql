-- =========================================================
-- ATERO FILES — AJUSTE DA POLÍTICA DE RESTAURAÇÃO
-- Execute depois de supabase/atero-files.sql.
-- =========================================================

begin;

-- Ao restaurar uma árvore inteira, o pai ainda pode aparecer como excluído
-- para a política durante a mesma instrução. A política de UPDATE precisa
-- validar propriedade e tipo do pai, sem exigir que ele já esteja restaurado.
drop policy if exists files_items_update_own on public.files_items;

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
    )
  )
);

commit;
