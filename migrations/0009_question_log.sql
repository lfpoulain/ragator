-- Journal des questions posées (interface web, ligne de commande ; jamais l'éval) : de quoi repérer
-- les vrais échecs (refus, aucune vidéo citée, erreur, réponse dégradée) et en faire des questions
-- d'éval (`npm run journal -- --echecs`). Remplace `query_log`, prévue mais jamais branchée (0006).
CREATE TABLE question_log (
  id              bigserial PRIMARY KEY,
  asked_at        timestamptz NOT NULL DEFAULT now(),
  origin          text NOT NULL CHECK (origin IN ('web', 'cli')),
  question        text NOT NULL,
  -- Question traitée après résolution d'une relance (« et dans cette vidéo ? »).
  resolved        text,
  collection      text,
  mode            text,
  route           text,
  refused         boolean,
  cited_videos    text[] NOT NULL DEFAULT '{}',
  -- Vidéos transmises au modèle ou au juge.
  considered      integer,
  degraded_reason text,
  error           text,
  total_ms        integer
);
CREATE INDEX ON question_log (asked_at DESC);
