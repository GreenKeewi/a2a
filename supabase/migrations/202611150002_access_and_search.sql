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
END $$;
