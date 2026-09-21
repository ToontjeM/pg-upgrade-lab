-- Same setup on both the 15.5 and 15.6 container -- the only difference is
-- whether CVE-2024-0985's fix is present in that minor release.
--
-- r0 gets its own database it owns: an entirely ordinary onboarding step
-- for a new application role (or a role a DBA lets self-service create its
-- own logical database), not a special grant. The vulnerability lives
-- inside REFRESH MATERIALIZED VIEW CONCURRENTLY's own internals, not in
-- anything unusual about r0's privileges.
CREATE ROLE r0 WITH LOGIN PASSWORD 'r0';
CREATE DATABASE rdb OWNER r0;
