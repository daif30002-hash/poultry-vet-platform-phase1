-- M02/M03 Identity and access: users, roles, permissions, sessions, OTP, MFA, licenses.

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  company_id uuid NOT NULL REFERENCES companies (id),
  user_type text NOT NULL CHECK (user_type IN ('CUSTOMER', 'STAFF')),
  full_name text NOT NULL CHECK (char_length(btrim(full_name)) BETWEEN 1 AND 200),
  phone_e164 text CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email citext CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  password_hash text,
  status text NOT NULL,
  preferred_locale text CHECK (preferred_locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  perm_version integer NOT NULL DEFAULT 1,
  failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  row_version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  deleted_by uuid,
  CONSTRAINT users_company_id_uq UNIQUE (company_id, id),
  CONSTRAINT users_contact_required CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL),
  CONSTRAINT users_status_by_type CHECK (
    (user_type = 'CUSTOMER' AND status IN ('PENDING_VERIFICATION', 'ACTIVE', 'BLOCKED')) OR
    (user_type = 'STAFF' AND status IN ('INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'))
  ),
  CONSTRAINT users_staff_password CHECK (user_type <> 'STAFF' OR status IN ('INVITED', 'DEACTIVATED') OR password_hash IS NOT NULL)
);
CREATE UNIQUE INDEX users_company_phone_uq ON users (company_id, phone_e164) WHERE phone_e164 IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX users_company_email_uq ON users (company_id, email) WHERE email IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX users_company_status_idx ON users (company_id, user_type, status) WHERE deleted_at IS NULL;
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_row();

CREATE TABLE permissions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z_]+$'),
  module text NOT NULL,
  description text NOT NULL
);

-- System roles have company_id NULL and are shared read-only by all companies. Custom roles belong to one company.
CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  company_id uuid REFERENCES companies (id),
  code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  description text,
  is_system boolean NOT NULL DEFAULT false,
  mfa_required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  row_version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  deleted_by uuid,
  CONSTRAINT roles_scope_ck CHECK ((is_system AND company_id IS NULL) OR (NOT is_system AND company_id IS NOT NULL))
);
CREATE UNIQUE INDEX roles_system_code_uq ON roles (code) WHERE company_id IS NULL;
CREATE UNIQUE INDEX roles_company_code_uq ON roles (company_id, code) WHERE company_id IS NOT NULL AND deleted_at IS NULL;
CREATE TRIGGER roles_touch BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION touch_row();

CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles (id),
  permission_id uuid NOT NULL REFERENCES permissions (id),
  scope text NOT NULL CHECK (scope IN ('OWN', 'BRANCH', 'COMPANY')),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_branches (
  company_id uuid NOT NULL,
  user_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  PRIMARY KEY (user_id, branch_id),
  CONSTRAINT user_branches_user_fk FOREIGN KEY (company_id, user_id) REFERENCES users (company_id, id),
  CONSTRAINT user_branches_branch_fk FOREIGN KEY (company_id, branch_id) REFERENCES branches (company_id, id)
);

CREATE TABLE user_roles (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  company_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role_id uuid NOT NULL REFERENCES roles (id),
  branch_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT user_roles_user_fk FOREIGN KEY (company_id, user_id) REFERENCES users (company_id, id),
  CONSTRAINT user_roles_branch_fk FOREIGN KEY (company_id, branch_id) REFERENCES branches (company_id, id),
  CONSTRAINT user_roles_assignment_uq UNIQUE NULLS NOT DISTINCT (user_id, role_id, branch_id)
);
CREATE INDEX user_roles_role_idx ON user_roles (role_id);

-- A user may only receive system roles or roles of the user's own company.
CREATE FUNCTION user_roles_check_role_company() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  role_company uuid;
BEGIN
  SELECT r.company_id INTO role_company FROM roles r WHERE r.id = NEW.role_id AND r.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'role % is not available', NEW.role_id USING ERRCODE = '23503';
  END IF;
  IF role_company IS NOT NULL AND role_company <> NEW.company_id THEN
    RAISE EXCEPTION 'role % belongs to another company', NEW.role_id USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_roles_role_company_ck BEFORE INSERT OR UPDATE OF role_id, company_id ON user_roles
  FOR EACH ROW EXECUTE FUNCTION user_roles_check_role_company();

-- Any change to what a user may do invalidates cached permissions through users.perm_version.
CREATE FUNCTION bump_perm_version_for_user() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE users SET perm_version = perm_version + 1 WHERE id = NEW.user_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE users SET perm_version = perm_version + 1 WHERE id = OLD.user_id;
  ELSE
    UPDATE users SET perm_version = perm_version + 1 WHERE id = OLD.user_id;
    IF NEW.user_id <> OLD.user_id THEN
      UPDATE users SET perm_version = perm_version + 1 WHERE id = NEW.user_id;
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER user_roles_bump_perm AFTER INSERT OR UPDATE OR DELETE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION bump_perm_version_for_user();
CREATE TRIGGER user_branches_bump_perm AFTER INSERT OR UPDATE OR DELETE ON user_branches
  FOR EACH ROW EXECUTE FUNCTION bump_perm_version_for_user();

CREATE FUNCTION bump_perm_version_for_role() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected_role uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN affected_role := OLD.role_id; ELSE affected_role := NEW.role_id; END IF;
  UPDATE users SET perm_version = perm_version + 1
   WHERE id IN (SELECT ur.user_id FROM user_roles ur WHERE ur.role_id = affected_role);
  RETURN NULL;
END $$;
CREATE TRIGGER role_permissions_bump_perm AFTER INSERT OR UPDATE OR DELETE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION bump_perm_version_for_role();

CREATE TABLE professional_licenses (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  company_id uuid NOT NULL,
  user_id uuid NOT NULL,
  license_type text NOT NULL CHECK (license_type ~ '^[A-Z][A-Z_]{1,39}$'),
  license_number text NOT NULL CHECK (char_length(btrim(license_number)) BETWEEN 1 AND 100),
  issuing_authority text NOT NULL CHECK (char_length(btrim(issuing_authority)) BETWEEN 1 AND 200),
  issuing_country char(2) NOT NULL CHECK (issuing_country ~ '^[A-Z]{2}$'),
  expires_on date,
  status text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED', 'VERIFIED', 'REJECTED', 'EXPIRED')),
  verified_by uuid,
  verified_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  row_version integer NOT NULL DEFAULT 1,
  CONSTRAINT professional_licenses_user_fk FOREIGN KEY (company_id, user_id) REFERENCES users (company_id, id),
  CONSTRAINT professional_licenses_verified_ck CHECK (status <> 'VERIFIED' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL)),
  CONSTRAINT professional_licenses_rejected_ck CHECK (status <> 'REJECTED' OR char_length(btrim(coalesce(rejection_reason, ''))) > 0)
);
CREATE UNIQUE INDEX professional_licenses_number_uq
  ON professional_licenses (company_id, issuing_country, issuing_authority, license_number) WHERE status <> 'REJECTED';
CREATE INDEX professional_licenses_user_idx ON professional_licenses (user_id);
CREATE TRIGGER professional_licenses_touch BEFORE UPDATE ON professional_licenses FOR EACH ROW EXECUTE FUNCTION touch_row();

CREATE TABLE staff_invitations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  company_id uuid NOT NULL,
  user_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT staff_invitations_user_fk FOREIGN KEY (company_id, user_id) REFERENCES users (company_id, id)
);
CREATE INDEX staff_invitations_user_idx ON staff_invitations (user_id);

-- One row per refresh token family. Rotation replaces refresh_hash in place and keeps the retired hashes so that
-- replaying an old token is detected as theft.
CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  company_id uuid NOT NULL,
  user_id uuid NOT NULL,
  refresh_hash text NOT NULL,
  previous_refresh_hashes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED', 'COMPROMISED')),
  device_info jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(device_info) = 'object'),
  ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  step_up_until timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  CONSTRAINT auth_sessions_user_fk FOREIGN KEY (company_id, user_id) REFERENCES users (company_id, id),
  CONSTRAINT auth_sessions_refresh_hash_uq UNIQUE (refresh_hash)
);
CREATE INDEX auth_sessions_user_active_idx ON auth_sessions (user_id) WHERE status = 'ACTIVE';
CREATE INDEX auth_sessions_previous_hashes_idx ON auth_sessions USING gin (previous_refresh_hashes);

CREATE TABLE otp_challenges (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  company_id uuid NOT NULL REFERENCES companies (id),
  user_id uuid,
  purpose text NOT NULL CHECK (purpose IN ('REGISTER', 'LOGIN', 'PASSWORD_RESET', 'STEP_UP')),
  channel text NOT NULL CHECK (channel IN ('SMS', 'EMAIL', 'MESSAGING')),
  destination_hash text NOT NULL,
  code_hash text NOT NULL,
  status text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED', 'VERIFIED', 'EXPIRED', 'LOCKED')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz
);
CREATE INDEX otp_challenges_destination_idx ON otp_challenges (company_id, destination_hash, issued_at DESC);

CREATE TABLE mfa_factors (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  company_id uuid NOT NULL,
  user_id uuid NOT NULL,
  factor_type text NOT NULL DEFAULT 'TOTP' CHECK (factor_type IN ('TOTP')),
  secret_ciphertext text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  CONSTRAINT mfa_factors_user_fk FOREIGN KEY (company_id, user_id) REFERENCES users (company_id, id)
);
CREATE UNIQUE INDEX mfa_factors_one_active_uq ON mfa_factors (user_id) WHERE status = 'ACTIVE';

CREATE TABLE mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  company_id uuid NOT NULL,
  user_id uuid NOT NULL,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mfa_recovery_codes_user_fk FOREIGN KEY (company_id, user_id) REFERENCES users (company_id, id)
);
CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id) WHERE used_at IS NULL;

CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  company_id uuid NOT NULL,
  user_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT password_reset_tokens_user_fk FOREIGN KEY (company_id, user_id) REFERENCES users (company_id, id)
);

-- Row level security.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_tenant ON users FOR ALL
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY roles_select ON roles FOR SELECT USING (company_id IS NULL OR company_id = app_company_id());
CREATE POLICY roles_insert ON roles FOR INSERT WITH CHECK (company_id = app_company_id() AND NOT is_system);
CREATE POLICY roles_update ON roles FOR UPDATE
  USING (company_id = app_company_id() AND NOT is_system)
  WITH CHECK (company_id = app_company_id() AND NOT is_system);

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY role_permissions_select ON role_permissions FOR SELECT USING (
  EXISTS (SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id AND (r.company_id IS NULL OR r.company_id = app_company_id()))
);
CREATE POLICY role_permissions_insert ON role_permissions FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id AND r.company_id = app_company_id() AND NOT r.is_system)
);
CREATE POLICY role_permissions_update ON role_permissions FOR UPDATE
  USING (EXISTS (SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id AND r.company_id = app_company_id() AND NOT r.is_system))
  WITH CHECK (EXISTS (SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id AND r.company_id = app_company_id() AND NOT r.is_system));
CREATE POLICY role_permissions_delete ON role_permissions FOR DELETE USING (
  EXISTS (SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id AND r.company_id = app_company_id() AND NOT r.is_system)
);

ALTER TABLE user_branches ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_branches_tenant ON user_branches FOR ALL
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_roles_tenant ON user_roles FOR ALL
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
ALTER TABLE professional_licenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY professional_licenses_tenant ON professional_licenses FOR ALL
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
ALTER TABLE staff_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_invitations_tenant ON staff_invitations FOR ALL
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_sessions_tenant ON auth_sessions FOR ALL
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
ALTER TABLE otp_challenges ENABLE ROW LEVEL SECURITY;
CREATE POLICY otp_challenges_tenant ON otp_challenges FOR ALL
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
ALTER TABLE mfa_factors ENABLE ROW LEVEL SECURITY;
CREATE POLICY mfa_factors_tenant ON mfa_factors FOR ALL
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY mfa_recovery_codes_tenant ON mfa_recovery_codes FOR ALL
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY password_reset_tokens_tenant ON password_reset_tokens FOR ALL
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());

-- Runtime privileges. Nothing here is hard deleted by the runtime role except assignments that are configuration.
GRANT SELECT ON permissions TO vet_app;
GRANT SELECT, INSERT, UPDATE ON users, roles, professional_licenses, staff_invitations, auth_sessions,
  otp_challenges, mfa_factors, mfa_recovery_codes, password_reset_tokens TO vet_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON role_permissions, user_roles, user_branches TO vet_app;
