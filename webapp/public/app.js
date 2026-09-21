'use strict';

// ---- tabs --------------------------------------------------------------------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`view-${btn.dataset.view}`).classList.add('active');
  });
});

// ---- theme (per-viewer convenience only, never load-bearing) -----------------
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('pg-upgrade-theme'); } catch (e) { /* ignore */ }
  if (saved === 'light' || saved === 'dark') applyTheme(saved);

  document.querySelectorAll('#theme-switch button').forEach((btn) => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
  });

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelectorAll('#theme-switch button').forEach((b) => b.classList.toggle('active', b.dataset.theme === theme));
    try { localStorage.setItem('pg-upgrade-theme', theme); } catch (e) { /* ignore */ }
  }
})();

// ---- fetch helper --------------------------------------------------------------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.classList.remove('ok', 'err');
  if (kind) el.classList.add(kind);
}

// Same as setStatus, but prefixes a spinning indicator -- for long-running
// actions (e.g. the Performance tab's benchmark, which can take minutes
// once disk throughput is throttled) where "disabled button" alone is easy
// to miss.
function setBusyStatus(el, text) {
  el.classList.remove('ok', 'err');
  el.innerHTML = '';
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  el.appendChild(spinner);
  el.appendChild(document.createTextNode(text));
}

// Shows the literal query/command text the server just ran, or -- for a
// static, always-known statement -- how a piece of the topology was set up.
// One place for both so every tab's "what just ran" preview looks the same.
function showSql(el, label, text) {
  el.hidden = false;
  el.innerHTML = '';
  const labelSpan = document.createElement('span');
  labelSpan.className = 'sql-label';
  labelSpan.textContent = label;
  el.appendChild(labelSpan);
  el.appendChild(document.createTextNode(text));
}

// ---- Security tab ---------------------------------------------------------------
async function refreshSecurity() {
  const data = await api('GET', '/api/security/status');
  for (const key of ['old', 'new']) {
    const card = document.querySelector(`#security-grid .card[data-target="${key}"]`);
    const s = data[key];
    card.querySelector('.v-can-create').textContent = s.canCreateOnPublic ? 'yes' : 'no';
    card.querySelector('.v-has-log').textContent = s.hasDeployLog ? 'yes' : 'no';
    const rs = card.querySelector('.v-rolsuper');
    rs.textContent = s.rolsuper ? 'YES -- escalated' : 'no';
    rs.style.color = s.rolsuper ? 'var(--color-danger)' : '';
  }
}

document.querySelectorAll('#security-grid [data-action]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const target = btn.dataset.target;
    const statusEl = document.getElementById(`sec-${target}-status`);
    btn.disabled = true;
    try {
      const sqlEl = document.getElementById(`sec-${target}-sql`);
      if (btn.dataset.action === 'attack') {
        const r = await api('POST', '/api/security/attack', { target });
        showSql(sqlEl, `Ran as app_user`, r.sql);
        setStatus(statusEl, r.blocked ? `Blocked: ${r.error}` : 'Trojan planted.', r.blocked ? 'ok' : 'err');
      } else if (btn.dataset.action === 'deploy') {
        const r = await api('POST', '/api/security/deploy', { target });
        showSql(sqlEl, `Ran as postgres (the DBA)`, r.sql);
        if (r.rolsuper) setStatus(statusEl, 'DBA ran the deploy script -- app_user is now SUPERUSER.', 'err');
        else setStatus(statusEl, 'DBA ran the deploy script. No effect.', 'ok');
      } else if (btn.dataset.action === 'reset') {
        const r = await api('POST', '/api/security/reset', { target });
        showSql(sqlEl, `Ran as postgres`, r.sql);
        setStatus(statusEl, 'Reset.', 'ok');
      }
      await refreshSecurity();
    } catch (err) {
      setStatus(statusEl, err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });
});

// ---- Performance tab --------------------------------------------------------------
let perfScenarios = null;
async function loadPerfScenarios() {
  if (perfScenarios) return perfScenarios;
  perfScenarios = await api('GET', '/api/performance/scenarios');
  return perfScenarios;
}
async function updatePerfSqlPreview() {
  const scenarios = await loadPerfScenarios();
  const scenario = scenarios[document.getElementById('perf-scenario').value];
  showSql(document.getElementById('perf-sql'), 'Query run on both nodes', scenario.sql);
}
document.getElementById('perf-scenario').addEventListener('change', () => updatePerfSqlPreview().catch(() => {}));
updatePerfSqlPreview().catch(() => {});

function diskLimitLabel(mbps) {
  return mbps === 0 ? 'Off (Docker Desktop default, very fast)' : `${mbps} MB/s per node (network-attached storage)`;
}

async function loadDiskLimitState() {
  const { mbps, options } = await api('GET', '/api/performance/disk-limit');
  const select = document.getElementById('perf-disk-limit');
  select.innerHTML = options.map((v) => `<option value="${v}">${diskLimitLabel(v)}</option>`).join('');
  select.value = String(mbps);
}

document.getElementById('perf-disk-limit').addEventListener('change', async () => {
  const select = document.getElementById('perf-disk-limit');
  const statusEl = document.getElementById('perf-status');
  const mbps = Number(select.value);
  select.disabled = true;
  try {
    const result = await api('POST', '/api/performance/disk-limit', { mbps });
    if (result.failed.length) setStatus(statusEl, `Disk throughput applied to most nodes, but failed on: ${result.failed.join('; ')}`, 'err');
  } catch (err) {
    setStatus(statusEl, err.message, 'err');
  } finally {
    select.disabled = false;
  }
});

async function refreshPerformance() {
  const data = await api('GET', '/api/performance/status');
  for (const key of ['old', 'new']) {
    const card = document.querySelector(`#perf-grid .card[data-target="${key}"]`);
    const s = data[key];
    card.querySelector('.v-io-method').textContent = s.ioMethod;
    card.querySelector('.v-shared-buffers').textContent = s.sharedBuffers;
    card.querySelector('.v-seeded').textContent = s.seeded ? 'yes (~3.75GB, 12M rows)' : 'seeding on first boot...';
  }
  document.getElementById('btn-run-perf').disabled = !(data.old.seeded && data.new.seeded);
}

document.getElementById('btn-run-perf').addEventListener('click', async () => {
  const statusEl = document.getElementById('perf-status');
  const btn = document.getElementById('btn-run-perf');
  const scenario = document.getElementById('perf-scenario').value;
  const reps = document.getElementById('perf-reps').value;
  const diskLimitMbps = Number(document.getElementById('perf-disk-limit').value);
  const btnLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Running...';
  setBusyStatus(
    statusEl,
    diskLimitMbps > 0
      ? `Running against both nodes with disk throttled to ${diskLimitMbps} MB/s -- a full scan moves ~3.75GB, so this can take a while (lower the repetitions or pick the bitmap scenario if it's too slow)...`
      : 'Running against both nodes, cold and warm reps mixed -- this can take a few seconds...'
  );
  try {
    const r = await api('POST', '/api/performance/run', { scenario, reps });
    showSql(document.getElementById('perf-sql'), 'Query just run on both nodes', r.sql);
    document.getElementById('perf-results').style.display = '';
    const fill = (id, timings) => {
      const card = document.getElementById(id);
      card.querySelector('.v-runs').textContent = timings.join(', ');
      const avg = Math.round(timings.reduce((a, b) => a + b, 0) / timings.length);
      card.querySelector('.v-avg').textContent = `${avg} ms`;
    };
    fill('perf-old-card', r.old);
    fill('perf-new-card', r.new);
    const avgOld = r.old.reduce((a, b) => a + b, 0) / r.old.length;
    const avgNew = r.new.reduce((a, b) => a + b, 0) / r.new.length;
    const delta = (((avgOld - avgNew) / avgOld) * 100).toFixed(1);
    setStatus(
      statusEl,
      avgNew < avgOld
        ? `PG18 averaged ${delta}% faster on this run (${r.label}).`
        : `PG18 was not faster on this run (${r.label}) -- expected on fast local storage; see the note above.`,
      ''
    );
  } catch (err) {
    setStatus(statusEl, err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = btnLabel;
  }
});

// ---- Reliability tab --------------------------------------------------------------
function renderRows(table, rows) {
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = '';
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="3" style="color:var(--text-dim); font-style:italic;">no rows yet</td></tr>';
    return;
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${row.id}</td><td>${escapeHtml(row.note)}</td><td>${new Date(row.created_at).toLocaleTimeString()}</td>`;
    tbody.appendChild(tr);
  }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refreshReliability() {
  const data = await api('GET', '/api/reliability/status');
  for (const key of ['old', 'new']) {
    const card = document.querySelector(`#rel-grid .card[data-target="${key}"]`);
    const s = data[key];
    card.querySelector('.v-primary-role').textContent = s.primary.reachable ? `${s.primary.role} (${s.primary.container.state})` : 'unreachable';
    card.querySelector('.v-standby-role').textContent = s.standby.reachable ? `${s.standby.role} (${s.standby.container.state})` : 'unreachable';
    card.querySelector('.v-worker').textContent = s.subscriptionWorkerRunning ? 'yes' : 'no -- broken';
    card.querySelector('.v-worker').style.color = s.subscriptionWorkerRunning ? '' : 'var(--color-danger)';
    renderRows(card.querySelector('.v-rows-table'), s.subscriberRows);
    showSql(card.querySelector('.v-setup-sql'), 'How this subscription was set up', s.setupSql);
  }
}

document.querySelectorAll('#rel-grid [data-action]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const target = btn.dataset.target;
    const statusEl = document.getElementById(`rel-${target}-status`);
    btn.disabled = true;
    try {
      const actionSqlEl = document.getElementById(`rel-${target}-action-sql`);
      if (btn.dataset.action === 'write') {
        const r = await api('POST', '/api/reliability/write', { version: target });
        showSql(actionSqlEl, `Ran on ${r.wroteTo}`, r.sql);
        setStatus(statusEl, `Wrote row ${r.row.id} to ${r.wroteTo}.`, 'ok');
      } else if (btn.dataset.action === 'failover') {
        setStatus(statusEl, 'Promoting standby and repointing subscriber...', '');
        const r = await api('POST', '/api/reliability/failover', { version: target });
        showSql(actionSqlEl, 'Commands just run', r.commands);
        setStatus(statusEl, r.alterError ? `Subscriber broke: ${r.alterError}` : 'Failover complete, subscription still running.', r.alterError ? 'err' : 'ok');
      } else if (btn.dataset.action === 'reset-rel') {
        setStatus(statusEl, 'Rebuilding containers and volumes, this takes a little while...', '');
        await api('POST', '/api/reliability/reset', { version: target });
        setStatus(statusEl, 'Reset complete.', 'ok');
      }
      await refreshReliability();
    } catch (err) {
      setStatus(statusEl, err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });
});

// ---- SQL console --------------------------------------------------------------
const consoleModal = document.getElementById('console-modal');
document.getElementById('btn-open-console').addEventListener('click', async () => {
  consoleModal.hidden = false;
  const select = document.getElementById('console-node');
  if (!select.options.length) {
    const meta = await api('GET', '/api/meta');
    for (const n of meta.consoleNodes) {
      const opt = document.createElement('option');
      opt.value = n.id;
      opt.textContent = `${n.id} (${n.label})`;
      select.appendChild(opt);
    }
  }
});
document.getElementById('btn-close-console').addEventListener('click', () => (consoleModal.hidden = true));

document.getElementById('btn-run-sql').addEventListener('click', async () => {
  const node = document.getElementById('console-node').value;
  const sql = document.getElementById('console-sql').value;
  const statusEl = document.getElementById('console-status');
  const table = document.getElementById('console-results');
  try {
    const r = await api('POST', '/api/sql/run', { node, sql });
    setStatus(statusEl, `${r.command || 'OK'} -- ${r.rowCount} row(s), ${r.elapsedMs} ms${r.truncated ? ' (truncated to 500)' : ''}`, 'ok');
    table.querySelector('thead').innerHTML = r.columns ? `<tr>${r.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr>` : '';
    table.querySelector('tbody').innerHTML = (r.rows || [])
      .map((row) => `<tr>${row.map((v) => `<td>${v === null ? 'NULL' : escapeHtml(String(v))}</td>`).join('')}</tr>`)
      .join('');
  } catch (err) {
    setStatus(statusEl, err.message, 'err');
  }
});

// ---- boot --------------------------------------------------------------------
refreshSecurity().catch(() => {});
refreshPerformance().catch(() => {});
loadDiskLimitState().catch(() => {});
refreshReliability().catch(() => {});
setInterval(() => {
  refreshPerformance().catch(() => {});
}, 15000);
