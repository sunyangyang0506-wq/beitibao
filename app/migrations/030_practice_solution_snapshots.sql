ALTER TABLE practice_results ADD COLUMN solution_snapshots jsonb
  CHECK (solution_snapshots IS NULL OR jsonb_typeof(solution_snapshots) = 'object');
