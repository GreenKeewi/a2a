-- Realtime is a hint. Durable tables and inbox catch-up remain the source of truth.
CREATE SCHEMA IF NOT EXISTS a2a_private;
REVOKE ALL ON SCHEMA a2a_private FROM PUBLIC;
-- Every later migration that adds functions here must revoke its inherited
-- PUBLIC/anon/authenticated EXECUTE grants explicitly before committing.

ALTER TABLE public.message_recipients ADD COLUMN notice_ack_at timestamptz;
CREATE INDEX message_recipients_pending_notice_idx ON public.message_recipients (agent_id, message_id)
WHERE notice_ack_at IS NULL AND read_at IS NULL;

CREATE OR REPLACE FUNCTION a2a_private.a2a_can_receive_realtime(topic text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  claims jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
  organization_text text := claims->>'organization_id';
  principal_text text := claims->>'principal_type';
BEGIN
  IF organization_text IS NULL OR organization_text !~ '^[0-9a-f-]{36}$' THEN RETURN false; END IF;
  IF principal_text = 'agent' THEN
    IF topic <> 'agent:' || coalesce(claims->>'agent_id', '') OR claims->>'sub' <> claims->>'agent_id' THEN RETURN false; END IF;
    RETURN EXISTS (
      SELECT 1 FROM public.agents a JOIN public.agent_tokens t ON t.agent_id = a.id
      WHERE a.id::text = claims->>'agent_id' AND a.organization_id::text = organization_text
        AND t.id::text = claims->>'token_id' AND a.revoked_at IS NULL AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > now())
    );
  ELSIF principal_text = 'user' THEN
    IF topic <> 'workspace:' || organization_text THEN RETURN false; END IF;
    RETURN EXISTS (
      SELECT 1 FROM public.member m
      WHERE m.organization_id::text = organization_text AND m.user_id::text = claims->>'sub'
    );
  END IF;
  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION a2a_private.a2a_can_receive_realtime(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION a2a_private.a2a_emit_realtime(
  topic text, event_name text, organization_id uuid,
  agent_id uuid DEFAULT NULL, message_id uuid DEFAULT NULL, thread_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM realtime.send(
    jsonb_strip_nulls(jsonb_build_object(
      'version', 1, 'event', event_name, 'organizationId', organization_id,
      'agentId', agent_id, 'messageId', message_id, 'threadId', thread_id,
      'occurredAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )), event_name, topic, true
  );
EXCEPTION
  WHEN invalid_schema_name OR undefined_function THEN NULL; -- local PostgreSQL without Supabase
  WHEN OTHERS THEN RAISE WARNING 'a2a realtime broadcast failed for %: %', event_name, SQLSTATE;
END;
$$;
REVOKE ALL ON FUNCTION a2a_private.a2a_emit_realtime(text,text,uuid,uuid,uuid,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION a2a_private.a2a_message_created_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM a2a_private.a2a_emit_realtime('workspace:' || NEW.organization_id, 'message.created', NEW.organization_id, NULL, NEW.id, NEW.thread_id);
  RETURN NEW;
END; $$;
CREATE TRIGGER a2a_message_created AFTER INSERT ON public.messages
FOR EACH ROW EXECUTE FUNCTION a2a_private.a2a_message_created_event();

CREATE OR REPLACE FUNCTION a2a_private.a2a_recipient_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE msg record;
BEGIN
  SELECT organization_id, thread_id, sender_agent_id INTO msg FROM public.messages WHERE id = NEW.message_id;
  IF TG_OP = 'INSERT' THEN
    PERFORM a2a_private.a2a_emit_realtime('agent:' || NEW.agent_id, 'message.created', msg.organization_id, NEW.agent_id, NEW.message_id, msg.thread_id);
  ELSIF NEW.read_at IS NOT NULL AND OLD.read_at IS NULL THEN
    IF msg.sender_agent_id IS NOT NULL THEN
      PERFORM a2a_private.a2a_emit_realtime('agent:' || msg.sender_agent_id, 'message.read', msg.organization_id, NEW.agent_id, NEW.message_id, msg.thread_id);
    END IF;
    PERFORM a2a_private.a2a_emit_realtime('workspace:' || msg.organization_id, 'message.read', msg.organization_id, NEW.agent_id, NEW.message_id, msg.thread_id);
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER a2a_recipient_insert AFTER INSERT ON public.message_recipients
FOR EACH ROW EXECUTE FUNCTION a2a_private.a2a_recipient_event();
CREATE TRIGGER a2a_recipient_read AFTER UPDATE OF read_at ON public.message_recipients
FOR EACH ROW EXECUTE FUNCTION a2a_private.a2a_recipient_event();

CREATE OR REPLACE FUNCTION a2a_private.a2a_brief_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE recipient record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.brief_version IS NOT DISTINCT FROM OLD.brief_version THEN RETURN NEW; END IF;
  PERFORM a2a_private.a2a_emit_realtime('workspace:' || NEW.organization_id, 'brief.updated', NEW.organization_id);
  FOR recipient IN SELECT id FROM public.agents WHERE organization_id = NEW.organization_id AND revoked_at IS NULL LOOP
    PERFORM a2a_private.a2a_emit_realtime('agent:' || recipient.id, 'brief.updated', NEW.organization_id, recipient.id);
  END LOOP;
  RETURN NEW;
END; $$;
CREATE TRIGGER a2a_brief_updated AFTER UPDATE OF brief_version ON public.workspace_settings
FOR EACH ROW EXECUTE FUNCTION a2a_private.a2a_brief_event();

CREATE OR REPLACE FUNCTION a2a_private.a2a_agent_presence_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.last_seen_at IS DISTINCT FROM OLD.last_seen_at THEN
    PERFORM a2a_private.a2a_emit_realtime('workspace:' || NEW.organization_id, 'agent.presence', NEW.organization_id, NEW.id);
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER a2a_agent_presence AFTER UPDATE OF last_seen_at ON public.agents
FOR EACH ROW EXECUTE FUNCTION a2a_private.a2a_agent_presence_event();

CREATE OR REPLACE FUNCTION a2a_private.a2a_coordination_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE recipient record;
BEGIN
  IF NEW.response_state IS DISTINCT FROM OLD.response_state AND NEW.response_state IN ('resolved', 'cancelled') THEN
    PERFORM a2a_private.a2a_emit_realtime('workspace:' || NEW.organization_id, 'coordination.resolved', NEW.organization_id, NULL, NEW.id, NEW.thread_id);
    FOR recipient IN SELECT agent_id FROM public.message_recipients WHERE message_id = NEW.id LOOP
      PERFORM a2a_private.a2a_emit_realtime('agent:' || recipient.agent_id, 'coordination.resolved', NEW.organization_id, recipient.agent_id, NEW.id, NEW.thread_id);
    END LOOP;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER a2a_coordination_resolved AFTER UPDATE OF response_state ON public.messages
FOR EACH ROW EXECUTE FUNCTION a2a_private.a2a_coordination_event();

CREATE OR REPLACE FUNCTION a2a_private.a2a_thread_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE recipient record;
BEGIN
  IF NEW.summary_version IS DISTINCT FROM OLD.summary_version THEN
    PERFORM a2a_private.a2a_emit_realtime('workspace:' || NEW.organization_id, 'thread.updated', NEW.organization_id, NULL, NULL, NEW.id);
    FOR recipient IN SELECT agent_id FROM public.thread_agent_members WHERE thread_id = NEW.id LOOP
      PERFORM a2a_private.a2a_emit_realtime('agent:' || recipient.agent_id, 'thread.updated', NEW.organization_id, recipient.agent_id, NULL, NEW.id);
    END LOOP;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER a2a_thread_updated AFTER UPDATE OF summary_version ON public.threads
FOR EACH ROW EXECUTE FUNCTION a2a_private.a2a_thread_event();

-- Supabase owns realtime.messages and already enables its RLS. Keep all A2A
-- functions outside PostgREST's exposed public schema. Only the receive check
-- is executable by authenticated clients, and only through a private schema.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA a2a_private FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON SCHEMA a2a_private FROM anon;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA a2a_private FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA a2a_private FROM authenticated;
    GRANT USAGE ON SCHEMA a2a_private TO authenticated;
    GRANT EXECUTE ON FUNCTION a2a_private.a2a_can_receive_realtime(text) TO authenticated;
    IF to_regclass('realtime.messages') IS NOT NULL THEN
      EXECUTE 'CREATE POLICY a2a_receive_private_topics ON realtime.messages FOR SELECT TO authenticated USING (a2a_private.a2a_can_receive_realtime((SELECT realtime.topic())))';
    END IF;
  END IF;
END $$;
