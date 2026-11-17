-- Schéma prévu mais jamais branché : journal des questions (dont l'origine
-- n'admettait même pas l'interface web), questions de référence en base (elles vivent
-- hors de la base) et vue de recouvrement parole / plan. Les résultats de mesure
-- restent dans `eval_runs`.
DROP VIEW IF EXISTS speech_visual_overlap;
DROP TABLE IF EXISTS query_log;
DROP TABLE IF EXISTS eval_questions;
