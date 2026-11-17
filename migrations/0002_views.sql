CREATE VIEW speech_visual_overlap AS
SELECT s.id AS speech_id, s.video_id,
       s.start_s AS speech_start, s.end_s AS speech_end,
       v.id AS visual_id, v.plan_title,
       v.start_s AS visual_start, v.end_s AS visual_end
FROM entries s
JOIN entries v
  ON v.video_id = s.video_id
 AND v.kind = 'visuel' AND s.kind = 'parole'
 AND v.start_s < GREATEST(COALESCE(s.end_s, s.start_s), s.start_s + 1)
 AND v.end_s   > s.start_s;
