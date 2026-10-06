-- M04 Audit Trail: append-only, hash chained per company, partitioned by month.

-- Head of each company chain. Only the SECURITY DEFINER functions below touch it.
CREATE TABLE audit_chain_heads (
  company_id uuid PRIMARY KEY REFERENCES companies (id),
  last_seq bigint NOT NULL DEFAULT 0,
  last_hash text NOT NULL DEFAULT repeat('0', 64),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id uuid NOT NULL DEFAULT uuid_generate_v7(),
  company_id uuid NOT NULL REFERENCES companies (id),
  seq bigint NOT NULL CHECK (seq > 0),
  occurred_at timestamptz NOT NULL,
  client_occurred_at timestamptz,
  branch_id uuid,
  actor_id uuid,
  actor_type text NOT NULL CHECK (actor_type IN ('USER', 'SYSTEM', 'API_CLIENT')),
  session_id uuid,
  ip text,
  device text,
  action text NOT NULL CHECK (action ~ '^[A-Z][A-Z0-9_]{2,79}$'),
  entity_type text NOT NULL CHECK (char_length(btrim(entity_type)) > 0),
  entity_id uuid,
  before_state jsonb,
  after_state jsonb,
  reason text,
  request_id text,
  prev_hash text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  row_hash text NOT NULL CHECK (row_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;

CREATE INDEX audit_logs_company_time_idx ON audit_logs (company_id, occurred_at DESC);
CREATE INDEX audit_logs_company_seq_idx ON audit_logs (company_id, seq);
CREATE INDEX audit_logs_entity_idx ON audit_logs (company_id, entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (company_id, actor_id, occurred_at DESC);

CREATE FUNCTION audit_ensure_month_partition(p_month date) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  start_ts timestamptz := date_trunc('month', p_month::timestamp) AT TIME ZONE 'UTC';
  end_ts timestamptz := (date_trunc('month', p_month::timestamp) + interval '1 month') AT TIME ZONE 'UTC';
  part_name text := format('audit_logs_y%sm%s', to_char(p_month, 'YYYY'), to_char(p_month, 'MM'));
BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_logs FOR VALUES FROM (%L) TO (%L)',
                 part_name, start_ts, end_ts);
  RETURN part_name;
END $$;
REVOKE ALL ON FUNCTION audit_ensure_month_partition(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_ensure_month_partition(date) TO vet_app;

DO $$
DECLARE
  first_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
BEGIN
  FOR i IN -1..24 LOOP
    PERFORM audit_ensure_month_partition((first_month + make_interval(months => i))::date);
  END LOOP;
END $$;

-- Locks the chain head of the current tenant and returns it. The caller must insert its record in the same transaction.
CREATE FUNCTION audit_next_link() RETURNS TABLE (head_seq bigint, head_hash text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  cid uuid := app_company_id();
BEGIN
  IF cid IS NULL THEN
    RAISE EXCEPTION 'tenant context is not set' USING ERRCODE = '42501';
  END IF;
  INSERT INTO audit_chain_heads (company_id) VALUES (cid) ON CONFLICT (company_id) DO NOTHING;
  RETURN QUERY
    SELECT h.last_seq, h.last_hash FROM audit_chain_heads h WHERE h.company_id = cid FOR UPDATE;
END $$;
REVOKE ALL ON FUNCTION audit_next_link() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_next_link() TO vet_app;

-- The database refuses any record that does not extend the chain exactly, whatever the application did.
CREATE FUNCTION audit_logs_enforce_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  head audit_chain_heads%ROWTYPE;
BEGIN
  SELECT * INTO head FROM audit_chain_heads WHERE company_id = NEW.company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit chain head is missing for company %', NEW.company_id USING ERRCODE = 'AC001';
  END IF;
  IF NEW.seq <> head.last_seq + 1 OR NEW.prev_hash <> head.last_hash THEN
    RAISE EXCEPTION 'audit chain continuity violation for company %', NEW.company_id USING ERRCODE = 'AC002';
  END IF;
  UPDATE audit_chain_heads
     SET last_seq = NEW.seq, last_hash = NEW.row_hash, updated_at = now()
   WHERE company_id = NEW.company_id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION audit_logs_enforce_chain() FROM PUBLIC;
CREATE TRIGGER audit_logs_chain BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_logs_enforce_chain();

CREATE FUNCTION audit_logs_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_select ON audit_logs FOR SELECT USING (company_id = app_company_id());
CREATE POLICY audit_logs_insert ON audit_logs FOR INSERT WITH CHECK (company_id = app_company_id());

-- Append and read only: no UPDATE, DELETE or TRUNCATE for the runtime role.
GRANT SELECT, INSERT ON audit_logs TO vet_app;
