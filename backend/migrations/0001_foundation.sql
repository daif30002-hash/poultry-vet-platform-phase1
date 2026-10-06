-- Foundation: version and role checks, extensions and shared helper functions.

DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'PostgreSQL 15 or newer is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vet_app') THEN
    RAISE EXCEPTION 'database role vet_app must exist before migrations run (see docker/postgres/roles.sql)';
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS citext;

-- Time-ordered UUIDs (version 7): 48 bit millisecond timestamp followed by random bits.
CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid
LANGUAGE sql VOLATILE PARALLEL SAFE AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid())
                PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                FROM 1 FOR 6),
        52, 1),
      53, 1),
    'hex')::uuid
$$;

-- Tenant of the current transaction. The application sets it with set_config('app.company_id', ..., true).
-- When it is not set the result is NULL and every row level security policy matches nothing (fail closed).
CREATE OR REPLACE FUNCTION app_company_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.company_id', true), '')::uuid
$$;

-- Optimistic locking helper: every UPDATE bumps row_version and updated_at.
CREATE OR REPLACE FUNCTION touch_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END $$;
