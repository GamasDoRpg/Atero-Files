# Atero Files

Aplicativo de arquivos da plataforma Atero, publicado em `files.atero.space`.

## Primeira versão

- Conta e autorização pelo Atero Hub e pela Atero API
- Pastas e navegação por breadcrumbs
- Upload e download de arquivos
- Busca, ordenação, grade e lista
- Favoritos, recentes e lixeira
- Restauração e exclusão permanente
- Indicador de armazenamento por plano
- Interface responsiva e suporte a arrastar e soltar

## Configuração do Supabase

Execute os arquivos abaixo, nesta ordem, no SQL Editor do projeto Supabase:

1. `supabase/atero-files.sql`
2. `supabase/02-atero-files-restore-policy.sql`

O primeiro script registra o aplicativo, cria a tabela `files_items`, o bucket privado `atero-files`, limites iniciais de armazenamento, funções e políticas RLS. O segundo ajusta a política usada na restauração recursiva de pastas.

Limites iniciais configurados:

- Grátis: 1 GB
- Pro: 50 GB
- Ultra: 200 GB
- Upload individual: 50 MB

## Backend

As rotas ficam no repositório `GamasDoRpg/atero-api`, sob o prefixo `/files`.

O frontend não recebe chaves administrativas. A sessão é validada pela Atero API, que usa o JWT do usuário para acessar o Supabase sob RLS.
