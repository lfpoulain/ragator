-- Vitesse de la recherche par mots. Depuis les « segments modifiables » de ParadeDB, les 1 000 dernières
-- lignes écrites dans un index BM25 restent dans un tampon que CHAQUE requête réanalyse en entier. Sur
-- `windows` (fenêtres de ~8 000 caractères), 683 fenêtres en attente coûtaient ~540 ms par lecture de
-- l'index, soit 1,2 s par question (deux lectures) ; pg_search 0.25 ne vide ce tampon que lorsqu'il est
-- plein. Une base restaurée par pg_restore n'en a pas (index construit d'un bloc) : d'où une recherche à
-- 0,7 s en octobre et à 3 s après une ingestion vidéo par vidéo (mesuré le 13 novembre 2026).
-- Ragator écrit peu et lit beaucoup : plus de tampon, chaque écriture donne un segment définitif, que
-- les fusions d'arrière-plan regroupent.
ALTER INDEX windows_search_idx SET (mutable_segment_rows = 0);
ALTER INDEX entries_search_idx SET (mutable_segment_rows = 0);
ALTER INDEX chunks_enrichment_idx SET (mutable_segment_rows = 0);
ALTER INDEX videos_search_idx SET (mutable_segment_rows = 0);

-- Reconstruction : vide les tampons existants et regroupe les segments.
REINDEX INDEX windows_search_idx;
REINDEX INDEX entries_search_idx;
REINDEX INDEX chunks_enrichment_idx;
REINDEX INDEX videos_search_idx;

-- Préchauffage des index vectoriels au démarrage (src/db/vector-index.ts) : juste construits ou après un
-- redémarrage, ils sont lus sur le disque page par page (jusqu'à 550 ms par recherche, contre 15 ms en mémoire).
CREATE EXTENSION IF NOT EXISTS pg_prewarm;
