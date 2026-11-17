CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_search;

CREATE TABLE videos (
  video_id             text PRIMARY KEY,
  title                text NOT NULL,
  url                  text NOT NULL,
  channel              text,
  published_at         date,
  duration_s           integer CHECK (duration_s >= 0),
  effective_duration_s integer NOT NULL CHECK (effective_duration_s >= 0),
  views                bigint,
  comments             bigint,
  description          text NOT NULL,
  description_blocks   jsonb NOT NULL,
  provenance           jsonb NOT NULL,
  quality              jsonb NOT NULL,
  content_hash         text NOT NULL,
  document_hash        text NOT NULL,
  content_hash_version text NOT NULL,
  retrieval_hash       text NOT NULL,
  derivation_version   text NOT NULL,
  review_required      boolean NOT NULL,
  generator_model      text NOT NULL,
  prompt_version       text NOT NULL,
  generated_at         timestamptz NOT NULL,
  ingested_at          timestamptz NOT NULL DEFAULT now(),
  indexed_at           timestamptz,
  embedding_model      text,
  embedding_dims       integer
);

CREATE TABLE entries (
  id               bigserial PRIMARY KEY,
  source_id        text NOT NULL,
  video_id         text NOT NULL REFERENCES videos(video_id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('parole','visuel')),
  start_s          integer NOT NULL,
  end_s            integer,
  chunk_index      integer,
  speaker          text,
  speaker_raw      text,
  speaker_id       text,
  speaker_is_named boolean NOT NULL,
  plan_title       text,
  text             text NOT NULL,
  screen_text      text[],
  uncertainties    text[] NOT NULL DEFAULT '{}',
  quality_flags    jsonb NOT NULL DEFAULT '{}',
  screen_text_norm text,
  norm_text        text NOT NULL,
  search_text      text NOT NULL,
  embedding        halfvec(2560),
  text_hash        text NOT NULL,
  UNIQUE (video_id, source_id),
  CHECK (start_s >= 0 AND (end_s IS NULL OR end_s >= start_s)),
  CHECK (kind = 'parole' OR end_s IS NOT NULL),
  CHECK (kind = 'parole' OR (screen_text IS NOT NULL AND screen_text_norm IS NOT NULL AND plan_title IS NOT NULL AND speaker IS NULL AND speaker_raw IS NULL AND speaker_id IS NULL)),
  CHECK (kind = 'visuel' OR (screen_text IS NULL AND screen_text_norm IS NULL AND plan_title IS NULL))
);

CREATE TABLE windows (
  id         bigserial PRIMARY KEY,
  video_id   text NOT NULL REFERENCES videos(video_id) ON DELETE CASCADE,
  start_s    integer NOT NULL,
  end_s      integer NOT NULL,
  text       text NOT NULL,
  text_hash  text NOT NULL,
  n_entries  integer NOT NULL,
  params     jsonb NOT NULL,
  UNIQUE (video_id, start_s)
);

CREATE TABLE corpus_meta (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO corpus_meta (key, value) VALUES
  ('schema_version', '"2.0"'),
  ('index_version', '"v1:lexical"')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE corpus_jobs (
  id          bigserial PRIMARY KEY,
  type        text NOT NULL CHECK (type IN ('ingest','derive','embed')),
  scope       text NOT NULL,
  target_hash text NOT NULL,
  version     text NOT NULL,
  state       text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','done','failed')),
  progress    integer NOT NULL DEFAULT 0,
  attempts    integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  message     text,
  started_at  timestamptz,
  finished_at timestamptz,
  UNIQUE (type, scope, target_hash, version)
);
CREATE INDEX ON corpus_jobs (state);

CREATE TABLE eval_questions (
  id       bigserial PRIMARY KEY,
  family   text NOT NULL CHECK (family IN ('exhaustive','factuelle','visuelle','temporelle','sans_reponse')),
  question text NOT NULL,
  expected jsonb NOT NULL,
  notes    text
);

CREATE TABLE eval_runs (
  id         bigserial PRIMARY KEY,
  label      text NOT NULL,
  config     jsonb NOT NULL,
  metrics    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE query_log (
  id         bigserial PRIMARY KEY,
  asked_at   timestamptz NOT NULL DEFAULT now(),
  origin     text NOT NULL CHECK (origin IN ('cli','mcp','discord')),
  question   text NOT NULL,
  route      text,
  tools      jsonb,
  sources    jsonb,
  latency_ms integer,
  feedback   text CHECK (feedback IN ('up','down') OR feedback IS NULL)
);

CREATE INDEX ON entries (video_id, start_s);
CREATE INDEX ON entries (kind);
CREATE INDEX ON entries (text_hash);
CREATE INDEX ON videos (published_at);
