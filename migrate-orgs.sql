-- Run once, after schema.sql. Additive: existing boards and accounts keep working.
ALTER TABLE boards ADD COLUMN org_id TEXT;
CREATE TABLE IF NOT EXISTS orgs(id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS members(org_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(org_id, user_id));
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);
CREATE TABLE IF NOT EXISTS invites(token TEXT PRIMARY KEY, org_id TEXT NOT NULL, role TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS boards_org ON boards(org_id, updated);
