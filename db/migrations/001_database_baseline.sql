-- Migration framework baseline. Domain tables are introduced by later tasks.
-- Keeping this migration intentionally side-effect free still establishes a
-- durable, checksummed version 1 in schema_migrations and PRAGMA user_version.
SELECT 1;
