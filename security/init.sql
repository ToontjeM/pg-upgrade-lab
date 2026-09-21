-- The same script runs on both the old and new containers -- the point of
-- this tab is that identical setup behaves differently purely because of
-- each version's *default* privileges, nothing bespoke per version.
--
-- Simulates a leaked application credential: a role that only has CONNECT,
-- nothing else explicitly granted. This is an extremely common real-world
-- shape (an app's own DB user, meant to only touch its own tables through
-- its own migrations).
CREATE ROLE app_user WITH LOGIN PASSWORD 'app_user';
GRANT CONNECT ON DATABASE postgres TO app_user;
