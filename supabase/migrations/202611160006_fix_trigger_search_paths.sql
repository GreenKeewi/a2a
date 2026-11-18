-- Pin trigger lookups so a caller cannot redirect unqualified table names.
ALTER FUNCTION public.sync_workspace_settings()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.audit_member_change()
  SET search_path = pg_catalog, public;
