ALTER TABLE predictions ADD COLUMN failure text;
ALTER TABLE predictions ADD COLUMN model_calls jsonb NOT NULL DEFAULT '[]'
  CHECK (jsonb_typeof(model_calls) = 'array');
