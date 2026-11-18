-- The server uses a dedicated database login. Its password is provisioned
-- outside migrations and never stored in Git. Browser API roles keep no table
-- grants; application authorization remains in the Next.js API.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'a2a_app') THEN
    CREATE ROLE a2a_app LOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO a2a_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO a2a_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO a2a_app;

DO $$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT c.relname AS tablename
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity
      AND c.relname = ANY (ARRAY[
        'user', 'session', 'account', 'verification', 'organization', 'member', 'invitation',
        'workspace_settings', 'workspace_brief_versions', 'workspace_invite_codes',
        'agents', 'agent_pairing_codes', 'agent_tokens', 'threads', 'thread_agent_members',
        'messages', 'message_recipients', 'decision_records', 'rate_limit_buckets', 'audit_events',
        'smart_jobs', 'smart_outputs', 'a2a_tasks', 'a2a_task_messages'
      ])
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = item.tablename AND policyname = 'a2a_app_server_only'
    ) THEN
      EXECUTE format('CREATE POLICY a2a_app_server_only ON public.%I FOR ALL TO a2a_app USING (true) WITH CHECK (true)', item.tablename);
    END IF;
  END LOOP;
END $$;
