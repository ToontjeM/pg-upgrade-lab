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

1. **Security -- PostgreSQL 14 vs 18.** Before PostgreSQL 15, any role that can merely `CONNECT` to a database can
   also create objects in its `public` schema by default -- nobody grants that, it's just on. This tab has a
   low-privileged role (`app_user`, granted only `CONNECT` -- the shape of a leaked application credential) use that
   default to plant a trojan table+trigger in `public`. When the DBA later runs an entirely ordinary, idempotent
   deploy script (`CREATE TABLE IF NOT EXISTS` + `INSERT`, the kind every team runs constantly), it silently reuses
   the attacker's table and fires their trigger *inside the DBA's own superuser session* -- `app_user` ends up
   `SUPERUSER`. On PG18, step one itself fails with `permission denied for schema public`: PostgreSQL 15 revoked
   `CREATE` on `public` from `PUBLIC` by default, so the attacker never gets a foothold.
2. **Performance -- PostgreSQL 17 vs 18.** PostgreSQL 18 introduced asynchronous I/O (`io_method = worker` or
   `io_uring`): reads no longer have to block one at a time on storage. PG17 has no such setting at all. Both nodes
   share the same `shared_buffers` and a 768MB container memory cap against a ~3.75GB seeded table, so scans are
   genuinely I/O-bound. Click "Run benchmark" and you get real, live numbers -- see the honesty note below.
3. **Reliability -- PostgreSQL 16 vs 18.** PostgreSQL 17 added logical replication slots that survive failover
   (`sync_replication_slots`). Each version runs a primary, a streaming standby, and a logical subscriber. Clicking
   "Simulate failover" stops the primary and promotes the standby -- exactly what happens during a real incident. On
   PG18 the slot was already synced to the standby, so the subscription just keeps going. On PG16 the slot never
   existed on the standby: the subscriber's apply worker dies with `replication slot "sub" does not exist` until
   someone manually recreates it and resyncs from scratch.

### A note on honesty (performance tab)
Asynchronous I/O's benefit is hiding storage *latency*. On the fast local disk Docker Desktop presents to both
containers, that latency barely exists -- so a live run may show a small PG18 win, no difference, or occasionally
PG18 slightly behind. That's a real, honest result, not a broken demo: the gap is real and larger on the
network-attached storage typical of production and cloud databases. This tab always shows the actual numbers from
that run, not a canned "PG18 wins" outcome.

The **Disk throughput** control on that tab makes this real rather than theoretical: it applies genuine cgroup I/O
throttling (the `io` controller's `io.max`, not a simulated delay) to both containers' storage, standing in for that
slower network-attached storage -- the same trick this project's sibling `pgd-cluster` demo uses `tc netem` for on
the network side. Turn it up and the PG18 win reopens.

## Demo prep
### Pre-requisites
- Docker and Docker Compose v2 (`docker compose version` should work)
- Nothing else -- every image used is the plain, official community `postgres` image; no EDB subscription token
  needed.

### Provisioning
Provision using `00-provision.sh`. This builds and starts 10 Postgres containers (2 per pillar, 6 for the
reliability pillar's primary/standby/subscriber topology) plus the web app, then waits for the app to finish
bootstrapping -- creating the logical replication topology and seeding the ~3.75GB benchmark table -- before
printing a ready message. First boot takes a minute or two; subsequent ones are much faster since images are
cached and the benchmark data lives in named volumes.

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

All connect as `postgres` / `postgres` (security and performance nodes use password auth; reliability nodes use
trust auth on an isolated Compose network -- fine for this local, single-user demo, never on a shared or
internet-facing host).

## Using the lab
Open `http://localhost:3000`. Four tabs:

- **Overview** -- a one-screen summary of all three pillars and why the pattern repeats across each of them.
- **Security** -- two buttons per version: "Attacker: plant trojan" (as `app_user`), then "DBA: run deploy script"
  (as `postgres`). Watch `app_user`'s superuser flag on the left flip to `YES -- escalated`; watch the right side
  block at step one. "Reset" clears the trojan objects and un-escalates the role so you can run it again.
- **Performance** -- pick a disk throughput level (see the honesty note above), a scenario (bitmap heap scan or
  sequential scan), a repetition count, and run it against both nodes live. Real per-run timings, not averages
  pre-baked into the page.
- **Reliability** -- "Write row" inserts through whichever node is currently primary; "Simulate failover" stops
  that primary and promotes the standby, then repoints the subscriber -- watch the subscription worker survive on
  PG18 and die on PG16. "Reset" tears down and rebuilds that version's 3 containers and volumes from scratch via
  `docker compose` (the app has full control of the Docker host for this, same tradeoff as the socket-mounted
  High Availability tab in this project's sibling `pgpooldemo`) -- it takes a little while, mirroring a real resync.
- **SQL Console** (top right) -- run arbitrary SQL against any of the 10 Postgres nodes directly.

## Notes
- `demo-app` has `/var/run/docker.sock` bind-mounted in (to promote/stop containers and read their state) and the
  whole project directory bind-mounted at its own host path (so `docker compose` invoked *inside* the app container
  can recreate sibling containers via the real host daemon -- see `PROJECT_DIR` in `docker-compose.yml`). That's
  full control of the Docker host, not just these containers -- fine for this local, single-user demo, never on a
  shared or internet-facing host.
- The reliability topology's standby containers skip the official image's own `initdb` path entirely and clone the
  primary via `pg_basebackup` on first boot (`reliability/postgres/entrypoint.sh`), same technique as
  `pgpooldemo/postgres/entrypoint.sh`.
- The Performance tab's **Disk throughput** control goes one step further than the socket mount: applying cgroup I/O
  throttling to a specific container's `io.max` means reaching into the *host's* cgroupfs, which no container's own
  mount namespace can see. `server.js` shells out to a throwaway `--privileged --pid=host` container that nsenters
  into the real host (the Docker Desktop VM) to read/write it directly -- see the comment above `applyDiskLimit` in
  that file. Like `tc netem` in the sibling `pgd-cluster` demo, the limit lives in the target container's cgroup, not
  its data volume, so restarting/recreating `pg17-performance`/`pg18-performance` resets it to unlimited.
- Every mechanism in this demo was verified by hand against the actual images before being wired into the app --
  including the exact escalation chain, the exact GUCs and timing needed for logical slot sync, and the honest
  (mixed) performance numbers on this hardware -- rather than assumed from documentation alone.

## Demo cleanup
```bash
./99-deprovision.sh
```
Stops and removes all containers, the network, and every named volume (including the seeded benchmark tables), so
the next `./00-provision.sh` starts from the same known-good state.
