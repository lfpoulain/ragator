CREATE INDEX entries_search_idx ON entries
  USING paradedb (
    id,
    (search_text::pdb.simple('stemmer=french', 'ascii_folding=true')),
    (norm_text::pdb.simple('stemmer=french', 'ascii_folding=true')),
    (screen_text_norm::pdb.simple('stemmer=french', 'ascii_folding=true')),
    kind,
    video_id,
    start_s,
    speaker
  ) WITH (key_field = 'id');

CREATE INDEX windows_search_idx ON windows
  USING paradedb (id, (text::pdb.simple('stemmer=french', 'ascii_folding=true')))
  WITH (key_field = 'id');

CREATE INDEX videos_search_idx ON videos
  USING paradedb (
    video_id,
    (title::pdb.simple('stemmer=french', 'ascii_folding=true')),
    (description::pdb.simple('stemmer=french', 'ascii_folding=true'))
  ) WITH (key_field = 'video_id');
