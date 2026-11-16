-- A2A v1.0 task IDs are durable. Each task belongs to one paired client agent,
-- one destination agent, and one existing coordination thread.
CREATE TABLE public.a2a_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
  client_agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  target_agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  context_id text NOT NULL CHECK (char_length(context_id) BETWEEN 1 AND 200),
  thread_id uuid NOT NULL REFERENCES public.threads(id) ON DELETE CASCADE,
  initial_message_id uuid NOT NULL UNIQUE REFERENCES public.messages(id) ON DELETE CASCADE,
  canceled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (client_agent_id <> target_agent_id)
);
CREATE INDEX a2a_tasks_context_idx ON public.a2a_tasks
  (organization_id, client_agent_id, target_agent_id, context_id, created_at DESC);
CREATE INDEX a2a_tasks_thread_idx ON public.a2a_tasks (organization_id, thread_id, created_at DESC);

CREATE TABLE public.a2a_task_messages (
  task_id uuid NOT NULL REFERENCES public.a2a_tasks(id) ON DELETE CASCADE,
  message_id uuid NOT NULL UNIQUE REFERENCES public.messages(id) ON DELETE CASCADE,
  external_message_id text NOT NULL CHECK (char_length(external_message_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, message_id)
);

ALTER TABLE public.a2a_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_task_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.a2a_tasks, public.a2a_task_messages FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.a2a_tasks, public.a2a_task_messages FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.a2a_tasks, public.a2a_task_messages FROM authenticated;
  END IF;
END $$;
