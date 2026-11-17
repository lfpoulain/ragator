-- Schéma prévu mais jamais branché : journal des questions (dont l'origine
-- n'admettait même pas l'interface web), questions d'éval en base (elles vivent
-- dans eval/*.json) et vue de recouvrement parole / plan. Les résultats d'éval
-- restent dans `eval_runs`.
DROP VIEW IF EXISTS speech_visual_overlap;
DROP TABLE IF EXISTS query_log;
DROP TABLE IF EXISTS eval_questions;
