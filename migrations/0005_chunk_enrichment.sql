-- Enrichissement des blocs de 30 s : une phrase de contexte et des mots-clés
-- écrits par un LLM (`npm run enrich`). Aide à TROUVER un passage (BM25 et vecteur
-- du bloc), jamais une preuve : les citations restent des entrées.
ALTER TABLE chunks ADD COLUMN enrichment text;
ALTER TABLE chunks ADD COLUMN enrichment_model text;

CREATE INDEX chunks_enrichment_idx ON chunks
  USING paradedb (id, (enrichment::pdb.simple('stemmer=french', 'ascii_folding=true')))
  WITH (key_field = 'id');
