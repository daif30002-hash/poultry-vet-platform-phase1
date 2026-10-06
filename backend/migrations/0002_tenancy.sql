-- M01 Multi-Tenancy & Settings: companies, branches, jurisdiction policies, integrations, document sequences.

CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  legal_name text NOT NULL CHECK (char_length(btrim(legal_name)) BETWEEN 2 AND 200),
  public_slug text NOT NULL CHECK (public_slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  country_code char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  base_currency char(3) NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  default_locale text NOT NULL CHECK (default_locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  data_region text NOT NULL CHECK (char_length(btrim(data_region)) BETWEEN 2 AND 64),
  status text NOT NULL DEFAULT 'PENDING_SETUP' CHECK (status IN ('PENDING_SETUP', 'ACTIVE', 'SUSPENDED', 'ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  row_version integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX companies_public_slug_uq ON companies (public_slug);
CREATE TRIGGER companies_touch BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION touch_row();

CREATE TABLE branches (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  company_id uuid NOT NULL REFERENCES companies (id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9_-]{1,32}$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  timezone text NOT NULL,
  address jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(address) = 'object'),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  row_version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  deleted_by uuid,
  CONSTRAINT branches_company_id_uq UNIQUE (company_id, id)
);
CREATE UNIQUE INDEX branches_company_code_uq ON branches (company_id, lower(code)) WHERE deleted_at IS NULL;
CREATE TRIGGER branches_touch BEFORE UPDATE ON branches FOR EACH ROW EXECUTE FUNCTION touch_row();

CREATE FUNCTION validate_branch_timezone() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'unknown IANA time zone: %', NEW.timezone USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER branches_validate_timezone
  BEFORE INSERT OR UPDATE OF timezone ON branches
  FOR EACH ROW EXECUTE FUNCTION validate_branch_timezone();

-- Per company regulatory and business policies (which classes need a prescription, retention periods, ...).
CREATE TABLE jurisdiction_policies (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  company_id uuid NOT NULL REFERENCES companies (id),
  policy_key text NOT NULL CHECK (policy_key ~ '^[a-z][a-z0-9_.]{2,79}$'),
  value jsonb NOT NULL,
  change_reason text NOT NULL CHECK (char_length(btrim(change_reason)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  row_version integer NOT NULL DEFAULT 1,
  CONSTRAINT jurisdiction_policies_key_uq UNIQUE (company_id, policy_key)
);
CREATE TRIGGER jurisdiction_policies_touch BEFORE UPDATE ON jurisdiction_policies FOR EACH ROW EXECUTE FUNCTION touch_row();

-- Provider selection per company. Secrets never live here: secret_ref points into the secrets manager.
CREATE TABLE integration_configs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  company_id uuid NOT NULL REFERENCES companies (id),
  integration_type text NOT NULL CHECK (integration_type IN
    ('OTP_MESSAGING', 'PAYMENT', 'PUSH', 'LLM', 'MAPS', 'OBJECT_STORAGE', 'EMAIL')),
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{1,39}$'),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  secret_ref text,
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  row_version integer NOT NULL DEFAULT 1,
  CONSTRAINT integration_configs_provider_uq UNIQUE (company_id, integration_type, provider)
);
CREATE UNIQUE INDEX integration_configs_one_active_uq ON integration_configs (company_id, integration_type) WHERE is_active;
CREATE TRIGGER integration_configs_touch BEFORE UPDATE ON integration_configs FOR EACH ROW EXECUTE FUNCTION touch_row();

-- Gap free numbering (invoices, orders, ...). Call inside the same transaction that uses the number.
CREATE TABLE document_sequences (
  company_id uuid NOT NULL REFERENCES companies (id),
  series text NOT NULL CHECK (series ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  period text NOT NULL CHECK (period ~ '^[A-Za-z0-9-]{0,16}$'),
  scope_key text NOT NULL CHECK (char_length(scope_key) BETWEEN 1 AND 64),
  next_value bigint NOT NULL DEFAULT 1 CHECK (next_value >= 1),
  PRIMARY KEY (company_id, series, period, scope_key)
);

CREATE FUNCTION next_document_number(p_series text, p_period text, p_scope_key text) RETURNS bigint
LANGUAGE sql VOLATILE AS $$
  INSERT INTO document_sequences (company_id, series, period, scope_key, next_value)
  VALUES (app_company_id(), p_series, p_period, p_scope_key, 2)
  ON CONFLICT (company_id, series, period, scope_key)
  DO UPDATE SET next_value = document_sequences.next_value + 1
  RETURNING next_value - 1
$$;

-- Pre-authentication tenant lookup. The caller has no tenant yet, so this runs with the owner's rights
-- and only ever returns the id of an ACTIVE company.
CREATE FUNCTION resolve_company_by_slug(p_slug text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id FROM companies c WHERE c.public_slug = lower(btrim(p_slug)) AND c.status = 'ACTIVE'
$$;
REVOKE ALL ON FUNCTION resolve_company_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_company_by_slug(text) TO vet_app;

-- Row level security: a row is visible and writable only inside its own tenant.
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY companies_select ON companies FOR SELECT USING (id = app_company_id());
CREATE POLICY companies_update ON companies FOR UPDATE
  USING (id = app_company_id()) WITH CHECK (id = app_company_id());

ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
CREATE POLICY branches_tenant ON branches FOR ALL
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());

ALTER TABLE jurisdiction_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY jurisdiction_policies_tenant ON jurisdiction_policies FOR ALL
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());

ALTER TABLE integration_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY integration_configs_tenant ON integration_configs FOR ALL
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());

ALTER TABLE document_sequences ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_sequences_tenant ON document_sequences FOR ALL
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());

-- Least privilege: companies are created and their currency, region and status are changed by platform tooling
-- (the owner role), not by the runtime role. Nothing is ever hard deleted by the runtime role.
GRANT SELECT ON companies TO vet_app;
GRANT UPDATE (legal_name, default_locale, updated_by) ON companies TO vet_app;
GRANT SELECT, INSERT, UPDATE ON branches, jurisdiction_policies, integration_configs, document_sequences TO vet_app;
