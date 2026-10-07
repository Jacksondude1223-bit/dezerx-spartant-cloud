CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY,
  serviceId TEXT NOT NULL,
  customerId TEXT NOT NULL,
  primaryRegion TEXT NOT NULL,
  status TEXT NOT NULL,
  lifecycleVersion INTEGER NOT NULL,
  updatedAt TEXT
);
CREATE TABLE IF NOT EXISTS domains (
  hostname TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  token TEXT NOT NULL,
  status TEXT NOT NULL,
  cloudflareId TEXT,
  createAttempted INTEGER NOT NULL DEFAULT 0,
  certificateMethod TEXT,
  certificateStatus TEXT,
  cloudflareOwnership TEXT,
  certificateValidation TEXT,
  checkedAt TEXT,
  nextCheckAt INTEGER NOT NULL DEFAULT 0,
  lastError TEXT
);
CREATE INDEX IF NOT EXISTS domains_due ON domains(nextCheckAt);
CREATE INDEX IF NOT EXISTS domains_tenant ON domains(tenantId);
