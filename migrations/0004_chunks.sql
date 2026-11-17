-- Blocs de ~30 s encodés pour la recherche sémantique : une phrase isolée
-- porte peu de sens, un bloc titré porte le sujet. Dérivés des entrées, jamais des preuves.
CREATE TABLE chunks (
  id         bigserial PRIMARY KEY,
  video_id   text NOT NULL REFERENCES videos(video_id) ON DELETE CASCADE,
  start_s    integer NOT NULL,
  end_s      integer NOT NULL,
  text       text NOT NULL,
  text_hash  text NOT NULL,
  embedding  halfvec(2560),
  UNIQUE (video_id, start_s),
  CHECK (start_s >= 0 AND end_s > start_s)
);
