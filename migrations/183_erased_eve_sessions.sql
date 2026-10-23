-- Eve sessions of an erased person or family, still to be deleted physically (18 October 2026).
--
-- /delete_me and /delete_family remove the application rows in one transaction, and with them the
-- conversation_sessions rows that session retention reads to find Eve's own history in the workflow
-- schema. The Eve session ids are written here inside that transaction, before the cascade, and the
-- retention sweep deletes each session from the workflow store and then its row here. Only an opaque
-- id: no family, person or content.
CREATE TABLE erased_eve_sessions (
  eve_session_id text PRIMARY KEY CHECK (char_length(eve_session_id) BETWEEN 1 AND 200),
  erased_at timestamptz NOT NULL DEFAULT now()
);
