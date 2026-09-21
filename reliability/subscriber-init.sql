-- The logical subscriber is a plain, unmodified postgres image (it never
-- clones anything, so it doesn't need this project's custom entrypoint) --
-- it just needs a table matching the publisher's shape before a
-- subscription can be created against it.
CREATE TABLE demo_events (
  id integer PRIMARY KEY,
  note text NOT NULL,
  created_at timestamptz NOT NULL
);
