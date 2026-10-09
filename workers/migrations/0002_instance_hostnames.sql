CREATE TABLE IF NOT EXISTS instance_hostnames (
  hostname TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL
);
