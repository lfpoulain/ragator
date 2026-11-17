-- Collections : une par créateur de contenu, déduite de la chaîne YouTube. Le système d'ingestion amont
-- écrit « Nom, accroche » (« Les Freres Poulain, French DIY and Tech Explorers ») : la collection est le
-- nom avant la virgule, réduit à un identifiant (« les-freres-poulain »). Calculée par la base, pour les
-- vidéos existantes comme pour les nouvelles : une seule règle, aucune configuration.

CREATE FUNCTION ragator_collection_name(channel text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(nullif(btrim(split_part(coalesce(channel, ''), ',', 1)), ''), 'Sans chaîne')
$$;

CREATE FUNCTION ragator_collection(channel text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(
    nullif(btrim(lower(regexp_replace(
      translate(ragator_collection_name(channel),
                'àâäáãåçéèêëíìîïñóòôöõúùûüýÿÀÂÄÁÃÅÇÉÈÊËÍÌÎÏÑÓÒÔÖÕÚÙÛÜÝ',
                'aaaaaaceeeeiiiinooooouuuuyyAAAAAACEEEEIIIINOOOOOUUUUY'),
      '[^A-Za-z0-9]+', '-', 'g')), '-'), ''),
    'sans-chaine')
$$;

ALTER TABLE videos ADD COLUMN collection text GENERATED ALWAYS AS (ragator_collection(channel)) STORED;
CREATE INDEX videos_collection_idx ON videos (collection);
