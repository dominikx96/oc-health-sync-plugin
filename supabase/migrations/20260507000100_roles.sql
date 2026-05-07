-- Two non-login roles. Login is granted to per-environment users
-- (via deploy/.env) which inherit from these.

CREATE ROLE health_ingest_role NOLOGIN;
CREATE ROLE health_read_role   NOLOGIN;

-- Ingest role: writes to data tables, can flip cache invalidated flag.
GRANT INSERT, UPDATE ON health_samples TO health_ingest_role;
GRANT INSERT, UPDATE ON device_state   TO health_ingest_role;
GRANT UPDATE          ON summary_cache  TO health_ingest_role;
-- needs SELECT to support ON CONFLICT … DO UPDATE and to find affected cache rows
GRANT SELECT          ON health_samples TO health_ingest_role;
GRANT SELECT          ON device_state   TO health_ingest_role;
GRANT SELECT          ON summary_cache  TO health_ingest_role;
GRANT USAGE, SELECT   ON ALL SEQUENCES IN SCHEMA public TO health_ingest_role;

-- Read role: SELECT on data tables, full DML on summary_cache only.
GRANT SELECT                            ON health_samples TO health_read_role;
GRANT SELECT                            ON device_state   TO health_read_role;
GRANT SELECT, INSERT, UPDATE, DELETE    ON summary_cache  TO health_read_role;
GRANT USAGE, SELECT                     ON ALL SEQUENCES IN SCHEMA public TO health_read_role;

-- Future tables/sequences in public schema inherit these grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO health_read_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO health_ingest_role;
