/* LEVANTE QA dashboard — front-end controller (vanilla JS). */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };

  const state = {
    agent: 'oracle',
    providers: [],
    /** runId -> { meta, pollTimer } tracked for the Launch tab. */
    tracked: new Map(),
  };

  // ── Tabs ────────────────────────────────────────────────────────────────
  document.querySelectorAll('.tab-button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-button').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      $(`#tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'results') loadResults();
    });
  });

  // ── Agent toggle ──────────────────────────────────────────────────────────
  $('#agentToggle').addEventListener('click', (e) => {
    const seg = e.target.closest('.seg');
    if (!seg) return;
    state.agent = seg.dataset.agent;
    document.querySelectorAll('#agentToggle .seg').forEach((s) => s.classList.remove('active'));
    seg.classList.add('active');
    syncVlmAvailability();
  });

  function currentTaskHasVlm() {
    const opt = $('#taskSelect').selectedOptions[0];
    return opt ? opt.dataset.hasVlm === 'true' : false;
  }

  function syncVlmAvailability() {
    const hasVlm = currentTaskHasVlm();
    // Both VLM and Child are model-backed, so both require a VLM spec.
    ['vlm', 'child'].forEach((a) => {
      const seg = document.querySelector(`#agentToggle .seg[data-agent="${a}"]`);
      seg.disabled = !hasVlm;
      seg.style.opacity = hasVlm ? '1' : '0.4';
    });
    if (!hasVlm && (state.agent === 'vlm' || state.agent === 'child')) {
      state.agent = 'oracle';
      document.querySelectorAll('#agentToggle .seg').forEach((s) => s.classList.remove('active'));
      document.querySelector('#agentToggle .seg[data-agent="oracle"]').classList.add('active');
    }
    const modelBacked = (state.agent === 'vlm' || state.agent === 'child') && hasVlm;
    $('#providerField').hidden = !modelBacked;
  }

  $('#taskSelect').addEventListener('change', syncVlmAvailability);

  // ── Bootstrap: load catalog ───────────────────────────────────────────────
  async function init() {
    try {
      const res = await fetch('/api/tasks');
      const data = await res.json();
      const taskSel = $('#taskSelect');
      data.tasks.forEach((t) => {
        const o = el('option');
        o.value = t.id;
        o.textContent = t.label + (t.hasVlm ? '' : ' (oracle only)');
        o.dataset.hasVlm = String(t.hasVlm);
        taskSel.appendChild(o);
      });
      state.providers = data.providers || [];
      const provSel = $('#providerSelect');
      state.providers.forEach((p) => {
        const o = el('option');
        o.value = p;
        o.textContent = p;
        provSel.appendChild(o);
      });
      syncVlmAvailability();
      setHeader('ready', 'ready');
    } catch (err) {
      setHeader('error', 'backend offline');
    }
  }

  function setHeader(kind, text) {
    const color = kind === 'error' ? 'var(--bad)' : kind === 'ready' ? 'var(--ok)' : 'var(--cyan-2)';
    $('#headerMeta').innerHTML = `<span class="status-pill"><i class="fas fa-circle" style="color:${color}"></i> ${text}</span>`;
  }

  // ── Launch ────────────────────────────────────────────────────────────────
  $('#launchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      taskId: $('#taskSelect').value,
      agent: state.agent,
      provider: $('#providerSelect').value,
      ageYears: Number($('#ageYears').value),
      ageMonths: Number($('#ageMonths').value),
    };
    const btn = $('#launchBtn');
    btn.disabled = true;
    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to launch');
      trackRun(data.runId, payload);
    } catch (err) {
      alert(`Launch failed: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  function trackRun(runId, payload) {
    $('#runsEmpty')?.remove();
    const card = el('div', 'run-card is-running');
    card.id = `run-${runId}`;
    $('#runGrid').prepend(card);
    state.tracked.set(runId, { meta: payload });
    renderCard(runId, {
      status: 'provisioning',
      meta: { ...payload, taskLabel: labelFor(payload.taskId) },
      accuracy: null,
      nTrials: 0,
      errors: [],
    });
    pollRun(runId);
  }

  function labelFor(id) {
    const opt = [...$('#taskSelect').options].find((o) => o.value === id);
    return opt ? opt.textContent.replace(' (oracle only)', '') : id;
  }

  const STATUS_LABEL = {
    provisioning: 'Provisioning',
    running: 'Running',
    passed: 'Passed',
    failed: 'Failed',
    error: 'Error',
  };
  const STATUS_ICON = {
    provisioning: '<i class="fas fa-circle-notch spin"></i>',
    running: '<i class="fas fa-circle-notch spin"></i>',
    passed: '<i class="fas fa-circle"></i>',
    failed: '<i class="fas fa-circle"></i>',
    error: '<i class="fas fa-triangle-exclamation"></i>',
  };

  function agentDisplay(agent, provider) {
    if (agent === 'child') return `Child · ${provider || ''}`;
    if (agent === 'vlm') return `VLM · ${provider || ''}`;
    return 'Oracle';
  }

  function renderCard(runId, s) {
    const card = $(`#run-${runId}`);
    if (!card) return;
    card.className = `run-card is-${s.status}`;
    const m = s.meta || {};
    const personaTag = m.persona && m.agent !== 'child' ? '<span class="tag">persona</span>' : '';
    const agentLabel = agentDisplay(m.agent, m.provider);
    const acc = s.accuracy == null ? '—' : `${(s.accuracy * 100).toFixed(1)}%`;
    const errBlock =
      (s.errors && s.errors.length)
        ? `<div class="run-errors"><b><i class="fas fa-flag"></i> ${s.errors.length} issue${s.errors.length > 1 ? 's' : ''}</b><br>${s.errors.map(escapeHtml).join('<br>')}</div>`
        : '';
    card.innerHTML = `
      <div class="run-card-head">
        <div>
          <div class="run-card-title">${escapeHtml(m.taskLabel || m.taskId || '')}${personaTag}</div>
          <div class="run-card-sub">${agentLabel} · age ${m.ageYears ?? '?'}y ${m.ageMonths ?? 0}m${s.email ? ' · ' + escapeHtml(s.email) : ''}</div>
        </div>
        <span class="pill pill-${s.status}">${STATUS_ICON[s.status] || ''} ${STATUS_LABEL[s.status] || s.status}</span>
      </div>
      <div class="run-metrics">
        <span class="metric">Accuracy <b>${acc}</b></span>
        <span class="metric">Trials <b>${s.nTrials || 0}</b></span>
      </div>
      ${errBlock}
      <div class="run-card-actions">
        <button class="link-btn" data-log="${runId}"><i class="fas fa-terminal"></i> View log</button>
      </div>`;
    card.querySelector('[data-log]').addEventListener('click', () => openLog(runId, m.taskLabel));
  }

  async function pollRun(runId) {
    try {
      const res = await fetch(`/api/status?runId=${encodeURIComponent(runId)}`);
      if (!res.ok) return;
      const s = await res.json();
      renderCard(runId, s);
      if (s.status === 'provisioning' || s.status === 'running') {
        setTimeout(() => pollRun(runId), 1500);
      } else {
        // Settled — refresh the results tab data lazily.
        state.tracked.delete(runId);
      }
    } catch {
      setTimeout(() => pollRun(runId), 3000);
    }
  }

  // ── Log modal ──────────────────────────────────────────────────────────────
  async function openLog(runId, title) {
    $('#modalTitle').textContent = `Run log · ${title || runId}`;
    $('#modalLog').textContent = 'Loading…';
    $('#modal').hidden = false;
    try {
      const res = await fetch(`/api/run/${encodeURIComponent(runId)}/log`);
      const data = await res.json();
      $('#modalLog').textContent = data.log || '(no output)';
      $('#modalLog').scrollTop = $('#modalLog').scrollHeight;
    } catch {
      $('#modalLog').textContent = 'Failed to load log.';
    }
  }
  $('#modalClose').addEventListener('click', () => ($('#modal').hidden = true));
  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') $('#modal').hidden = true;
  });

  // ── Results tab ──────────────────────────────────────────────────────────
  async function loadResults() {
    try {
      const res = await fetch('/api/runs');
      const data = await res.json();
      const rows = data.runs || [];
      const body = $('#resultsBody');
      body.innerHTML = '';
      $('#resultsEmpty').style.display = rows.length ? 'none' : 'block';
      rows.forEach((r) => {
        const tr = el('tr');
        const acc = r.accuracy == null ? '—' : `${(r.accuracy * 100).toFixed(1)}%`;
        const agent = agentDisplay(r.agent, r.provider) + (r.persona && r.agent !== 'child' ? ' <span class="tag">persona</span>' : '');
        const dur = r.durationMs != null ? `${Math.round(r.durationMs / 1000)}s` : '—';
        const errs = (r.errors && r.errors.length) ? r.errors.map(escapeHtml).join('<br>') : '—';
        tr.innerHTML = `
          <td>${fmtTime(r.startedAt)}</td>
          <td>${escapeHtml(r.taskLabel || r.task)}</td>
          <td>${agent}</td>
          <td>${r.ageYears ?? '?'}y ${r.ageMonths ?? 0}m</td>
          <td><span class="pill pill-${r.status}">${STATUS_LABEL[r.status] || r.status}</span></td>
          <td>${acc}</td>
          <td>${r.nTrials || 0}</td>
          <td class="err-cell">${errs}</td>
          <td>${dur}</td>`;
        body.appendChild(tr);
      });
    } catch {
      $('#resultsEmpty').textContent = 'Failed to load run history.';
      $('#resultsEmpty').style.display = 'block';
    }
  }
  $('#refreshResults').addEventListener('click', loadResults);

  // ── helpers ────────────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  init();
})();
