-- Questions des invités de la passerelle (accès par collection) : journalisées à part, sans le compte.
ALTER TABLE question_log DROP CONSTRAINT IF EXISTS question_log_origin_check;
ALTER TABLE question_log ADD CONSTRAINT question_log_origin_check CHECK (origin IN ('web', 'cli', 'invite'));
