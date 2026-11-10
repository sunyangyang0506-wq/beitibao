CREATE TABLE model_rate_events (
  id uuid PRIMARY KEY,
  model text NOT NULL,
  tokens_reserved integer NOT NULL CHECK (tokens_reserved BETWEEN 1 AND 50000),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX model_rate_events_window ON model_rate_events (model, started_at);
