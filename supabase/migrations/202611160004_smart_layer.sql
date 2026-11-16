-- Smart processing is an optional, durable side path. Message writes never wait
-- for a model request, and the queue trigger must not break a core send.
ALTER TABLE public.messages ADD COLUMN priority_explicit boolean NOT NULL DEFAULT false;
ALTER TABLE public.workspace_settings
  ADD COLUMN reminder_after_minutes integer NOT NULL DEFAULT 120 CHECK (reminder_after_minutes BETWEEN 5 AND 10080),
  ADD COLUMN escalate_after_minutes integer NOT NULL DEFAULT 480 CHECK (escalate_after_minutes BETWEEN 10 AND 20160),
  ADD COLUMN smart_enabled_at timestamptz,
  ADD CONSTRAINT reminder_threshold_order CHECK (escalate_after_minutes > reminder_after_minutes);

CREATE TABLE public.smart_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
  message_id uuid NOT NULL UNIQUE REFERENCES public.messages(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'skipped', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX smart_jobs_pending_idx ON public.smart_jobs (available_at, created_at)
  WHERE status IN ('queued', 'processing');

CREATE TABLE public.smart_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES public.threads(id) ON DELETE CASCADE,
  source_message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('summary', 'proposed_decision', 'priority', 'scope_owner', 'secret_warning')),
  value jsonb NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  source_version text NOT NULL,
  confidence numeric(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, kind, source_version)
);
CREATE INDEX smart_outputs_thread_idx ON public.smart_outputs (organization_id, thread_id, generated_at DESC);

ALTER TABLE public.smart_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smart_outputs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.smart_jobs, public.smart_outputs FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.smart_jobs, public.smart_outputs FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.smart_jobs, public.smart_outputs FROM authenticated;
  END IF;
END $$;

CREATE FUNCTION a2a_private.a2a_queue_smart_message() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.workspace_settings s
             WHERE s.organization_id = NEW.organization_id AND s.smart_features_enabled) THEN
    INSERT INTO public.smart_jobs (organization_id, message_id)
    VALUES (NEW.organization_id, NEW.id) ON CONFLICT (message_id) DO NOTHING;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A queue failure cannot roll back a delivered message. The operational
  -- worker can recover missed jobs by scanning messages in enabled workspaces.
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION a2a_private.a2a_queue_smart_message() FROM PUBLIC;
CREATE TRIGGER a2a_queue_smart_message AFTER INSERT ON public.messages
FOR EACH ROW EXECUTE FUNCTION a2a_private.a2a_queue_smart_message();
