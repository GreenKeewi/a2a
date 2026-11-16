-- Auth membership must remain unique even under concurrent join attempts.
CREATE UNIQUE INDEX member_user_organization_uq ON member (user_id, organization_id);

-- Better Auth owns organizations. The trigger provisions app settings in the
-- same transaction, including calls through Better Auth's own create endpoint.
CREATE FUNCTION sync_workspace_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO workspace_settings (organization_id, slug, display_name)
  VALUES (NEW.id, NEW.slug, NEW.name)
  ON CONFLICT (organization_id) DO UPDATE
    SET slug = EXCLUDED.slug, display_name = EXCLUDED.display_name, updated_at = now();
  RETURN NEW;
END $$;
CREATE TRIGGER organization_settings_sync
  AFTER INSERT OR UPDATE OF name, slug ON organization
  FOR EACH ROW EXECUTE FUNCTION sync_workspace_settings();

INSERT INTO workspace_settings (organization_id, slug, display_name)
SELECT id, slug, name FROM organization
ON CONFLICT (organization_id) DO NOTHING;

CREATE FUNCTION audit_member_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_events (organization_id, actor_user_id, action, target_id)
    VALUES (NEW.organization_id, NEW.user_id, 'membership.joined', NEW.user_id::text);
    IF NEW.role = 'owner' AND NOT EXISTS (
      SELECT 1 FROM audit_events WHERE organization_id = NEW.organization_id AND action = 'workspace.created'
    ) THEN
      INSERT INTO audit_events (organization_id, actor_user_id, action, target_id)
      VALUES (NEW.organization_id, NEW.user_id, 'workspace.created', NEW.organization_id::text);
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO audit_events (organization_id, action, target_id)
    VALUES (OLD.organization_id, 'membership.removed', OLD.user_id::text);
  ELSIF TG_OP = 'UPDATE' AND NEW.role IS DISTINCT FROM OLD.role THEN
    INSERT INTO audit_events (organization_id, action, target_id, metadata)
    VALUES (NEW.organization_id, 'membership.role_changed', NEW.user_id::text,
            jsonb_build_object('from', OLD.role, 'to', NEW.role));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER member_audit
  AFTER INSERT OR DELETE OR UPDATE OF role ON member
  FOR EACH ROW EXECUTE FUNCTION audit_member_change();

-- Search is ranked only after authorized workspace/thread filtering in the API.
ALTER TABLE messages ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(subject, '') || ' ' || coalesce(body, ''))) STORED;
CREATE INDEX message_search_vector_idx ON messages USING gin (search_vector);

-- Next.js accesses tables through a private PostgreSQL connection. Public API
-- roles have no direct table permissions; Realtime policies arrive in phase 3.
DO $$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename = ANY (ARRAY[
      'user', 'session', 'account', 'verification', 'organization', 'member', 'invitation',
      'workspace_settings', 'workspace_brief_versions', 'workspace_invite_codes',
      'agents', 'agent_pairing_codes', 'agent_tokens', 'threads', 'thread_agent_members',
      'messages', 'message_recipients', 'decision_records', 'rate_limit_buckets', 'audit_events'
    ])
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', item.tablename);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', item.tablename);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', item.tablename);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', item.tablename);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated';
  END IF;
END $$;
