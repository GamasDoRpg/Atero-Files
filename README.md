# Atero Files

Aplicativo de arquivos da plataforma Atero, publicado em `files.atero.space`.

## Recursos atuais

- Conta e autorização pelo Atero Hub e pela Atero API
- Pastas e navegação por breadcrumbs
- Upload direto do navegador para o Cloudflare R2
- Download por URL temporária assinada
- Busca, ordenação, grade e lista
- Favoritos, recentes e lixeira
- Restauração e exclusão permanente
- Indicador de armazenamento por plano
- Interface responsiva e suporte a arrastar e soltar

## Arquitetura de armazenamento

- Supabase Auth: identidade e sessão
- Supabase Postgres: metadados, pastas, permissões, lixeira e limites
- Cloudflare R2: conteúdo binário dos novos arquivos
- Atero API: autoriza uploads, confirma tamanho e gera URLs temporárias

Credenciais permanentes do R2 ficam apenas na Atero API. O navegador recebe uma URL assinada curta para um único objeto.

## SQL do Supabase

Execute, nesta ordem:

1. `supabase/atero-files.sql`
2. `supabase/02-atero-files-restore-policy.sql`
3. `supabase/03-atero-files-r2.sql`

O terceiro script migra o modelo para R2, adiciona estados de upload e troca as escritas diretas na tabela por RPCs controladas.

## Cloudflare R2

Crie um bucket privado chamado `atero-files` e aplique a política de CORS contida em:

- `cloudflare/r2-cors.json`

Crie também uma regra de ciclo de vida para excluir objetos com o prefixo `pending/` depois de 1 dia. Os uploads são enviados primeiro para esse prefixo e promovidos para `users/` somente depois da confirmação de tamanho.

Variáveis necessárias na Atero API:

```text
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=atero-files
R2_PRESIGNED_URL_EXPIRY_SECONDS=600
```

Opcionalmente, `R2_ENDPOINT_URL` pode substituir o endpoint derivado do Account ID.

## Compatibilidade

Registros antigos continuam marcados com `storage_provider = 'supabase'` e permanecem legíveis. Novos uploads usam `storage_provider = 'r2'`.
