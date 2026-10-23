-- Row-level security by family on every table that carries family_id (79 on 8 October 2026).
--
-- Isolation held only on queries: a repository that forgot `WHERE family_id` returned another
-- family's rows. A row is now visible when the connection is in system mode or its family equals
-- the one the application set on the connection (agent/lib/database-context.ts). The superuser that
-- runs migrations and tests bypasses policies; the runtime role osinara_app does not.
--
-- FORCE also binds the table owner, should the runtime ever connect as the owner without
-- superuser rights. A table that a later migration adds with family_id must get the same policy:
-- family-row-level-security.integration.test.ts fails otherwise.

CREATE FUNCTION osinara_family_row_visible(row_family uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT current_setting('app.rls_system', true) = 'on'
    OR row_family = nullif(current_setting('app.family_id', true), '')::uuid
$$;

DO $$
DECLARE
  target regclass;
BEGIN
  FOR target IN
    SELECT c.oid::regclass
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND a.attname = 'family_id' AND NOT a.attisdropped
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
    EXECUTE format(
      'CREATE POLICY osinara_family_scope ON %s USING (osinara_family_row_visible(family_id)) WITH CHECK (osinara_family_row_visible(family_id))',
      target);
  END LOOP;
END $$;

-- The family row itself is keyed by id.
ALTER TABLE families ENABLE ROW LEVEL SECURITY;
ALTER TABLE families FORCE ROW LEVEL SECURITY;
CREATE POLICY osinara_family_scope ON families
  USING (osinara_family_row_visible(id)) WITH CHECK (osinara_family_row_visible(id));

-- A view runs with its owner's rights unless told otherwise, and the owner bypasses the policies.
ALTER VIEW memory_items SET (security_invoker = true);
