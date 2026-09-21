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

// ---- Security tab, second scenario (CVE-2024-0985) --------------------------------
async function refreshCve() {
  const data = await api('GET', '/api/cve/status');
  for (const key of ['old', 'new']) {
    const card = document.querySelector(`#cve-grid .card[data-target="${key}"]`);
    const s = data[key];
    card.querySelector('.v-has-mv').textContent = s.hasMv ? 'yes' : 'no';
    const rs = card.querySelector('.v-rolsuper');
    rs.textContent = s.rolsuper ? 'YES -- escalated' : 'no';
    rs.style.color = s.rolsuper ? 'var(--color-danger)' : '';
  }
}

document.querySelectorAll('#cve-grid [data-action]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const target = btn.dataset.target;
    const statusEl = document.getElementById(`cve-${target}-status`);
    btn.disabled = true;
    try {
      const sqlEl = document.getElementById(`cve-${target}-sql`);
      if (btn.dataset.action === 'attack') {
        const r = await api('POST', '/api/cve/attack', { target });
        showSql(sqlEl, 'Ran as r0', r.sql);
        setStatus(statusEl, r.blocked ? `Blocked: ${r.error}` : 'Materialized view planted.', r.blocked ? 'err' : 'ok');
      } else if (btn.dataset.action === 'refresh') {
        const r = await api('POST', '/api/cve/refresh', { target });
        showSql(sqlEl, 'Ran as postgres (the admin)', r.sql);
        if (r.blocked) setStatus(statusEl, `Blocked: ${r.error}`, 'ok');
        else if (r.rolsuper) setStatus(statusEl, 'Refresh ran -- r0 is now SUPERUSER.', 'err');
        else setStatus(statusEl, 'Refresh ran. No effect.', 'ok');
      } else if (btn.dataset.action === 'reset') {
        const r = await api('POST', '/api/cve/reset', { target });
        showSql(sqlEl, 'Ran as postgres', r.sql);
        setStatus(statusEl, 'Reset.', 'ok');
      }
      await refreshCve();
    } catch (err) {
      setStatus(statusEl, err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });
});

// ---- Performance tab --------------------------------------------------------------
async function refreshPerformance() {
  const data = await api('GET', '/api/performance/status');
  for (const key of ['old', 'new']) {
    const card = document.querySelector(`#perf-grid .card[data-target="${key}"]`);
    const s = data[key];
    card.querySelector('.v-seeded').textContent = s.seeded
      ? s.skipScanReady ? 'yes' : 'seeded, backfilling skip-scan columns...'
      : 'seeding on first boot...';
  }
  document.getElementById('btn-run-perf').disabled = !(
    data.old.seeded && data.new.seeded && data.old.skipScanReady && data.new.skipScanReady
  );
}

document.getElementById('btn-run-perf').addEventListener('click', async () => {
  const statusEl = document.getElementById('perf-status');
  const btn = document.getElementById('btn-run-perf');
  const reps = document.getElementById('perf-reps').value;
  const btnLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Running...';
  setBusyStatus(statusEl, 'Running against both nodes...');
  try {
    const r = await api('POST', '/api/performance/run', { reps });
    showSql(document.getElementById('perf-sql'), 'Query just run on both nodes', r.sql);
    document.getElementById('perf-results').style.display = '';
    const fill = (id, timings, buffers) => {
      const card = document.getElementById(id);
      card.querySelector('.v-runs').textContent = timings.join(', ');
      const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
      // Sub-ms averages (PG18's skip scan) round to "0 ms" and look broken
      // -- keep 2 decimals below 1ms, whole ms otherwise.
      card.querySelector('.v-avg').textContent = `${avg < 1 ? avg.toFixed(2) : Math.round(avg)} ms`;
      card.querySelector('.v-buffers').textContent = Math.round(buffers.reduce((a, b) => a + b, 0) / buffers.length).toLocaleString();
    };
    fill('perf-old-card', r.old, r.buffers.old);
    fill('perf-new-card', r.new, r.buffers.new);

    // The headline metric here is buffer pages Postgres reports touching,
    // not wall-clock -- real, but doesn't need slow storage to make the
    // point (see the skip-scan comment in server.js).
    const avgBufOld = r.buffers.old.reduce((a, b) => a + b, 0) / r.buffers.old.length;
    const avgBufNew = r.buffers.new.reduce((a, b) => a + b, 0) / r.buffers.new.length;
    const factor = avgBufNew > 0 ? (avgBufOld / avgBufNew).toFixed(0) : '?';
    setStatus(
      statusEl,
      avgBufNew < avgBufOld
        ? `PG18 touched ~${factor}x fewer buffer pages than PG17 on this run (${Math.round(avgBufOld).toLocaleString()} vs ${Math.round(avgBufNew).toLocaleString()}) -- B-tree skip scan, independent of storage speed.`
        : `PG18 did not touch fewer buffer pages on this run -- unexpected; check the plan in the SQL preview above.`,
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
refreshCve().catch(() => {});
refreshPerformance().catch(() => {});
refreshReliability().catch(() => {});
setInterval(() => {
  refreshPerformance().catch(() => {});
}, 15000);
