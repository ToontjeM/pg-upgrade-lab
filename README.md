[![Generic badge](https://img.shields.io/badge/Version-1.0-<COLOR>.svg)](https://shields.io/)
[![Maintenance](https://img.shields.io/badge/Maintained%3F-yes-green.svg)](https://GitHub.com/Naereen/StrapDown.js/graphs/commit-activity)
![Maintainer](https://img.shields.io/badge/maintainer-ton.machielsen@enterprisedb.com-blue)
# PostgreSQL Upgrade Lab

## Intro
A GUI-based, Docker Compose demo of why staying on an old PostgreSQL version is a real, ongoing cost -- not just a
missed-features checkbox. Three pillars, each running a genuinely old and a genuinely current PostgreSQL side by
side, same setup on both, nothing mocked: every result comes from a real command against a real running instance.

Open `http://localhost:3000` after provisioning for the graphical, click-through version of every use case below.

## The three pillars

1. **Security -- PostgreSQL 14 vs 18, plus a second scenario on 15.5 vs 15.6.** Before PostgreSQL 15, any role that
   can merely `CONNECT` to a database can also create objects in its `public` schema by default -- nobody grants
   that, it's just on. This tab has a low-privileged role (`app_user`, granted only `CONNECT` -- the shape of a
   leaked application credential) use that default to plant a trojan table+trigger in `public`. When the DBA later
   runs an entirely ordinary, idempotent deploy script (`CREATE TABLE IF NOT EXISTS` + `INSERT`, the kind every team
   runs constantly), it silently reuses the attacker's table and fires their trigger *inside the DBA's own superuser
   session* -- `app_user` ends up `SUPERUSER`. On PG18, step one itself fails with `permission denied for schema
   public`: PostgreSQL 15 revoked `CREATE` on `public` from `PUBLIC` by default, so the attacker never gets a
   foothold.

   A second scenario on this tab, deliberately a **minor**-version pair rather than a major one, makes the same
   point about patch releases: **CVE-2024-0985**. `REFRESH MATERIALIZED VIEW CONCURRENTLY` is meant to run a view's
   SQL as the view's *owner*, so a privileged user can safely refresh a view someone else created; the bug is a
   moment where Postgres briefly drops that protection while building its own internal temp table, which a
   maliciously-crafted materialized view (a deferred constraint trigger plus a `CREATE RULE` trick converting that
   temp table into a view) hijacks to run SQL as whoever issued the refresh instead. Verified by hand against real
   `postgres:15.5` and `postgres:15.6` containers: identical setup escalates role `r0` to superuser on 15.5, and
   15.6 (released the same day as the fix, 2024-02-08) rejects the refresh with a plain `"... is not a table"`
   error -- no escalation. The only known working proof of concept for this technique doesn't work on PG16+ at all
   (patched or not, for unrelated reasons), which is why this scenario is 15.5 vs 15.6 rather than a major-version
   pair like the one above it.
2. **Performance -- PostgreSQL 17 vs 18.** PostgreSQL 18's B-tree indexes can perform a "skip scan": jumping over
   irrelevant values in a composite index's leading column, even when the query has no predicate on that column at
   all. Querying `bench` on its unindexed-alone `serial_no` column (only a composite `(tenant_id, serial_no)` index
   exists, `tenant_id` has just 20 distinct values) makes PG17 read the *entire* index -- confirmed by hand at
   ~112,000 buffer pages and ~150ms -- while PG18's plan reports `Index Searches: 22` and touches ~180 buffer pages
   in well under a millisecond. That gap is measured in buffer pages Postgres itself reports touching, not
   wall-clock, so it shows up the same way regardless of storage speed -- unlike PG18's other headline performance
   feature, asynchronous I/O, which this tab used to also demonstrate but no longer does: its benefit is hiding
   storage *latency*, and on the fast local disk Docker Desktop presents to both containers that latency barely
   exists, so it couldn't reliably show a difference here (see git history for that earlier version, including the
   real cgroup disk-throttling control it needed to make the gap visible at all).
3. **Reliability -- PostgreSQL 16 vs 18.** PostgreSQL 17 added logical replication slots that survive failover
   (`sync_replication_slots`). Each version runs a primary, a streaming standby, and a logical subscriber. Clicking
   "Simulate failover" stops the primary and promotes the standby -- exactly what happens during a real incident. On
   PG18 the slot was already synced to the standby, so the subscription just keeps going. On PG16 the slot never
   existed on the standby: the subscriber's apply worker dies with `replication slot "sub" does not exist` until
   someone manually recreates it and resyncs from scratch.

## Demo prep
### Pre-requisites
- Docker and Docker Compose v2 (`docker compose version` should work)
- Nothing else -- every image used is the plain, official community `postgres` image; no EDB subscription token
  needed.

### Provisioning
Provision using `00-provision.sh`. This builds and starts 12 Postgres containers (2 for the Security tab's major-
version scenario, 2 more for its minor-version CVE scenario, 2 for Performance, 6 for the Reliability pillar's
primary/standby/subscriber topology) plus the web app, then waits for the app to finish bootstrapping -- creating
the logical replication topology and seeding the ~3.75GB benchmark table -- before printing a ready message. First
boot takes a minute or two; subsequent ones are much faster since images are cached and the benchmark data lives in
named volumes.

```bash
./00-provision.sh
```

Published ports:

| Host port | What |
| --- | --- |
| `3000` | The demo app (open this) |
| `5401` / `5402` | Security: PG14 / PG18 |
| `5403` / `5404` | Performance: PG17 / PG18 |
| `5405` / `5406` / `5407` | Reliability old (PG16): primary / standby / subscriber |
| `5408` / `5409` / `5410` | Reliability new (PG18): primary / standby / subscriber |
| `5411` / `5412` | Security, CVE-2024-0985 scenario: PG15.5 / PG15.6 |

All connect as `postgres` / `postgres` (security and performance nodes use password auth; reliability nodes use
trust auth on an isolated Compose network -- fine for this local, single-user demo, never on a shared or
internet-facing host).

## Using the lab
Open `http://localhost:3000`. Four tabs:

- **Overview** -- a one-screen summary of all three pillars and why the pattern repeats across each of them.
- **Security** -- two buttons per version: "Attacker: plant trojan" (as `app_user`), then "DBA: run deploy script"
  (as `postgres`). Watch `app_user`'s superuser flag on the left flip to `YES -- escalated`; watch the right side
  block at step one. "Reset" clears the trojan objects and un-escalates the role so you can run it again. A second
  block below it runs the same three-button pattern for CVE-2024-0985 (`PostgreSQL 15.5` vs `15.6`) -- here the
  *second* step ("Admin: refresh materialized view") is where the old version escalates and the new one blocks it,
  the opposite step from the scenario above it.
- **Performance** -- pick a repetition count and run the skip-scan query against both nodes live. Real per-run
  timings and buffer-page counts (via `EXPLAIN (ANALYZE, BUFFERS)`), not averages pre-baked into the page.
- **Reliability** -- "Write row" inserts through whichever node is currently primary; "Simulate failover" stops
  that primary and promotes the standby, then repoints the subscriber -- watch the subscription worker survive on
  PG18 and die on PG16. "Reset" tears down and rebuilds that version's 3 containers and volumes from scratch via
  `docker compose` (the app has full control of the Docker host for this, same tradeoff as the socket-mounted
  High Availability tab in this project's sibling `pgpooldemo`) -- it takes a little while, mirroring a real resync.
- **SQL Console** (top right) -- run arbitrary SQL against any of the 12 Postgres nodes directly.

## Notes
- `demo-app` has `/var/run/docker.sock` bind-mounted in (to promote/stop containers and read their state) and the
  whole project directory bind-mounted at its own host path (so `docker compose` invoked *inside* the app container
  can recreate sibling containers via the real host daemon -- see `PROJECT_DIR` in `docker-compose.yml`). That's
  full control of the Docker host, not just these containers -- fine for this local, single-user demo, never on a
  shared or internet-facing host.
- The reliability topology's standby containers skip the official image's own `initdb` path entirely and clone the
  primary via `pg_basebackup` on first boot (`reliability/postgres/entrypoint.sh`), same technique as
  `pgpooldemo/postgres/entrypoint.sh`.
- The Performance tab's `bench` table carries a `payload`/`val`/`bench_val_idx` that no current scenario uses --
  they backed an earlier async-I/O comparison that got dropped (see git history) because it needed slow storage to
  show a difference. Left in place rather than migrated out, so already-seeded volumes and a fresh provision stay
  schema-identical.
- The CVE-2024-0985 scenario's exploit (`security/init-cve.sql` + the `CVE_SQL` object in `webapp/server.js`) is
  genuinely intricate -- a deferred constraint trigger plus a `CREATE RULE` trick that converts
  `REFRESH MATERIALIZED VIEW CONCURRENTLY`'s own internal temp table into a view -- adapted from public writeups of
  the CVE, not invented here. Confirmed by hand against real `postgres:15.5`/`postgres:15.6` containers before
  wiring it in, same as everything else in this list.
- Every mechanism in this demo was verified by hand against the actual images before being wired into the app --
  including the exact escalation chain, the exact GUCs and timing needed for logical slot sync, and the honest
  (mixed) performance numbers on this hardware -- rather than assumed from documentation alone.

## Demo cleanup
```bash
./99-deprovision.sh
```
Stops and removes all containers, the network, and every named volume (including the seeded benchmark tables), so
the next `./00-provision.sh` starts from the same known-good state.
