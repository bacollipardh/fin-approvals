CREATE TYPE user_role AS ENUM ('agent','team_lead','division_manager','sales_director','admin');

CREATE TABLE divisions(
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE users(
  id SERIAL PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name  TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role user_role NOT NULL,
  division_id INT REFERENCES divisions(id),
  pda_number TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE buyers(
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE buyer_sites(
  id SERIAL PRIMARY KEY,
  buyer_id INT REFERENCES buyers(id) ON DELETE CASCADE,
  site_code TEXT NOT NULL,
  site_name TEXT NOT NULL
);

CREATE TABLE articles(
  id SERIAL PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  sell_price NUMERIC(12,2) NOT NULL
);

CREATE TYPE req_status AS ENUM ('pending','approved','rejected');

CREATE TABLE requests(
  id SERIAL PRIMARY KEY,
  agent_id INT REFERENCES users(id),
  division_id INT REFERENCES divisions(id),
  buyer_id INT REFERENCES buyers(id),
  site_id INT REFERENCES buyer_sites(id),
  article_id INT REFERENCES articles(id),
  quantity INT DEFAULT 1,
  amount NUMERIC(12,2) NOT NULL,
  invoice_ref TEXT,
  reason TEXT,
  status req_status DEFAULT 'pending',
  required_role user_role NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE approvals(
  id SERIAL PRIMARY KEY,
  request_id INT REFERENCES requests(id) ON DELETE CASCADE,
  approver_id INT REFERENCES users(id),
  approver_role user_role NOT NULL,
  action req_status NOT NULL,
  comment TEXT,
  acted_at TIMESTAMPTZ DEFAULT now()
);


-- TeamLeader assignment fields (added 2026-01-05)
ALTER TABLE users ADD COLUMN IF NOT EXISTS team_leader_id INT NULL REFERENCES users(id);
ALTER TABLE divisions ADD COLUMN IF NOT EXISTS default_team_leader_id INT NULL REFERENCES users(id);
ALTER TABLE requests ADD COLUMN IF NOT EXISTS assigned_to_user_id INT NULL REFERENCES users(id);
ALTER TABLE requests ADD COLUMN IF NOT EXISTS assigned_reason TEXT NULL;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ NULL;
