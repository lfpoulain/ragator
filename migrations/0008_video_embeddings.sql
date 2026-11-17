-- Un vecteur par vidéo, du même encodeur que les entrées et les blocs : son titre, sa description sans
-- le gabarit de la chaîne (liens, rubriques reprises d'une vidéo à l'autre), ses chapitres et les titres
-- de ses plans (`src/core/video-text.ts`). Sert à proposer les vidéos proches d'une vidéo (essayé aussi
-- pour classer les vidéos des questions générales : aucun gain mesuré). Calculé par
-- `npm run embed`, comme les autres vecteurs.
ALTER TABLE videos ADD COLUMN embedding halfvec(2560);
-- Empreinte du texte encodé : un texte qui change (description, plans, gabarit) est réencodé.
ALTER TABLE videos ADD COLUMN embedding_hash text;

-- Quelques centaines de lignes : l'index est bon marché, même construit d'avance.
CREATE INDEX videos_embedding_idx ON videos USING hnsw (embedding halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);
