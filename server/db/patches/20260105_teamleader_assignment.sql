DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='team_leader_id') THEN
    ALTER TABLE users ADD COLUMN team_leader_id INT NULL REFERENCES users(id);
    CREATE INDEX IF NOT EXISTS idx_users_team_leader_id ON users(team_leader_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='divisions' AND column_name='default_team_leader_id') THEN
    ALTER TABLE divisions ADD COLUMN default_team_leader_id INT NULL REFERENCES users(id);
    CREATE INDEX IF NOT EXISTS idx_divisions_default_team_leader_id ON divisions(default_team_leader_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='requests' AND column_name='assigned_to_user_id') THEN
    ALTER TABLE requests ADD COLUMN assigned_to_user_id INT NULL REFERENCES users(id);
    ALTER TABLE requests ADD COLUMN assigned_reason TEXT NULL;
    ALTER TABLE requests ADD COLUMN assigned_at TIMESTAMPTZ NULL;
    CREATE INDEX IF NOT EXISTS idx_requests_assigned_to_user_id ON requests(assigned_to_user_id);
    CREATE INDEX IF NOT EXISTS idx_requests_assigned_role_status ON requests(required_role, status, assigned_to_user_id);
  END IF;
END $$;

-- Backfill pending team_lead requests if any
UPDATE requests r
SET assigned_to_user_id = u.team_leader_id,
    assigned_reason = 'backfill.agent.team_leader_id',
    assigned_at = now()
FROM users u
WHERE r.required_role='team_lead'
  AND r.assigned_to_user_id IS NULL
  AND r.agent_id = u.id
  AND u.team_leader_id IS NOT NULL;

UPDATE requests r
SET assigned_to_user_id = d.default_team_leader_id,
    assigned_reason = 'backfill.division.default_team_leader_id',
    assigned_at = now()
FROM divisions d
WHERE r.required_role='team_lead'
  AND r.assigned_to_user_id IS NULL
  AND r.division_id = d.id
  AND d.default_team_leader_id IS NOT NULL;
