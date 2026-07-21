-- Ansuz Phase 1: memory backend schema
-- Rolling short-term interaction log + summarized long-term memory with pgvector retrieval.

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- short_term_memory: raw interaction/perception log, rolling 24h window
-- ---------------------------------------------------------------------------
create table if not exists short_term_memory (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  role text not null check (role in ('user', 'assistant', 'system', 'perception')),
  content text not null,
  session_id text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_short_term_memory_created_at on short_term_memory (created_at);
create index if not exists idx_short_term_memory_expires_at on short_term_memory (expires_at);
create index if not exists idx_short_term_memory_session_id on short_term_memory (session_id);

-- ---------------------------------------------------------------------------
-- long_term_memory: consolidated summaries + embeddings for semantic retrieval
-- category is intentionally broader than "interaction" so Phase 5's
-- self-improvement loop can log built artifacts and failed repair attempts
-- into the same memory store without a later migration.
-- ---------------------------------------------------------------------------
create table if not exists long_term_memory (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  category text not null default 'interaction'
    check (category in ('interaction', 'built-artifact', 'self-repair-success', 'self-repair-failure', 'other')),
  summary text not null,
  -- dimension matches common embedding models (e.g. OpenAI text-embedding-3-small).
  -- change to match whatever embedding model you settle on before ingesting data.
  embedding vector(1536),
  importance smallint not null default 3 check (importance between 1 and 5),
  source_ids uuid[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_long_term_memory_category on long_term_memory (category);
create index if not exists idx_long_term_memory_created_at on long_term_memory (created_at);
create index if not exists idx_long_term_memory_embedding_hnsw
  on long_term_memory using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Row Level Security: deny by default. The anon key has no policies here,
-- so it cannot read or write memory directly. All memory access happens
-- server-side (Node backend or Edge Function) using the service_role key,
-- which bypasses RLS.
-- ---------------------------------------------------------------------------
alter table short_term_memory enable row level security;
alter table long_term_memory enable row level security;

-- ---------------------------------------------------------------------------
-- Retrieval: cosine-similarity search over long-term memory.
-- ---------------------------------------------------------------------------
create or replace function match_long_term_memories(
  query_embedding vector(1536),
  match_count int default 5,
  min_importance smallint default 1
) returns table (
  id uuid,
  summary text,
  category text,
  importance smallint,
  created_at timestamptz,
  metadata jsonb,
  similarity float
)
language sql
stable
as $$
  select
    ltm.id,
    ltm.summary,
    ltm.category,
    ltm.importance,
    ltm.created_at,
    ltm.metadata,
    1 - (ltm.embedding <=> query_embedding) as similarity
  from long_term_memory ltm
  where ltm.embedding is not null
    and ltm.importance >= min_importance
  order by ltm.embedding <=> query_embedding
  limit match_count;
$$;

-- ---------------------------------------------------------------------------
-- Pruning: drop short-term entries past their 24h window. Intended to be
-- called by the Phase 1 consolidation job (Edge Function / cron), after it
-- has summarized and promoted whatever's worth keeping.
-- ---------------------------------------------------------------------------
create or replace function prune_short_term_memory() returns void
language sql
as $$
  delete from short_term_memory where expires_at < now();
$$;
