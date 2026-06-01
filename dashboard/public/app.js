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
    $('#irtField').hidden = state.agent !== 'child' || !hasVlm;
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
      personaAbility:
        state.agent === 'child' && $('#irtToggle').checked ? 'irt' : null,
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
    card.dataset.startedAt = new Date().toISOString();
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
    const irtTag = m.personaAbility === 'irt' ? '<span class="tag">IRT θ</span>' : '';
    const agentLabel = agentDisplay(m.agent, m.provider);
    const acc = s.accuracy == null ? '—' : `${(s.accuracy * 100).toFixed(1)}%`;
    const startedAt = card.dataset.startedAt || s.startedAt;
    const errBlock =
      (s.errors && s.errors.length)
        ? `<div class="run-errors"><b><i class="fas fa-flag"></i> ${s.errors.length} issue${s.errors.length > 1 ? 's' : ''}</b><br>${s.errors.map(escapeHtml).join('<br>')}</div>`
        : '';
    card.innerHTML = `
      <div class="run-card-head">
        <div>
          <div class="run-card-title">${escapeHtml(m.taskLabel || m.taskId || '')}${personaTag}${irtTag}</div>
          <div class="run-card-sub">${agentLabel} · age ${m.ageYears ?? '?'}y ${m.ageMonths ?? 0}m${s.email ? ' · ' + escapeHtml(s.email) : ''}</div>
          <div class="run-card-time"><i class="fas fa-clock"></i> ${fmtTime(startedAt)}</div>
        </div>
        <div class="run-card-head-right">
          <span class="pill pill-${s.status}">${STATUS_ICON[s.status] || ''} ${STATUS_LABEL[s.status] || s.status}</span>
          <button class="card-close" data-remove="${runId}" title="Remove from this list" aria-label="Remove card">&times;</button>
        </div>
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
    card.querySelector('[data-remove]').addEventListener('click', () => removeCard(runId));
  }

  function removeCard(runId) {
    // Kills any in-flight process server-side, stops polling (pollRun bails when
    // the card is gone), and clears the card from the Launch list. Completed
    // runs remain in history (Results tab); cancelled runs are not recorded.
    state.tracked.delete(runId);
    fetch(`/api/run/${encodeURIComponent(runId)}`, { method: 'DELETE' }).catch(() => {});
    $(`#run-${runId}`)?.remove();
    if (!$('#runGrid').children.length) {
      $('#runGrid').appendChild(
        el('p', 'empty-note', 'No runs yet this session. Launch one above.'),
      ).id = 'runsEmpty';
    }
  }

  async function pollRun(runId) {
    // Card was removed by the user — stop polling.
    if (!$(`#run-${runId}`)) return;
    try {
      const res = await fetch(`/api/status?runId=${encodeURIComponent(runId)}`);
      if (!res.ok) return;
      const s = await res.json();
      if (!$(`#run-${runId}`)) return;
      renderCard(runId, s);
      if (s.status === 'provisioning' || s.status === 'running') {
        setTimeout(() => pollRun(runId), 1500);
      } else {
        // Settled — refresh the results tab data lazily.
        state.tracked.delete(runId);
      }
    } catch {
      if ($(`#run-${runId}`)) setTimeout(() => pollRun(runId), 3000);
    }
  }

  // ── Run details modal ─────────────────────────────────────────────────────
  let activeArtifactRunId = null;

  function fmtDuration(ms) {
    if (ms == null) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  function summaryRow(label, value) {
    return `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`;
  }

  function formatJsonlPreview(lines) {
    return lines
      .map((l) => {
        try {
          return JSON.stringify(JSON.parse(l), null, 2);
        } catch {
          return l;
        }
      })
      .join('\n\n---\n\n');
  }

  async function loadArtifactPreview(runId, name, btn) {
    activeArtifactRunId = runId;
    document.querySelectorAll('.artifact-tab').forEach((b) => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    const pre = $('#modalArtifactPreview');
    pre.textContent = 'Loading…';
    try {
      const res = await fetch(
        `/api/run/${encodeURIComponent(runId)}/artifact?name=${encodeURIComponent(name)}&tail=30`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      const header =
        data.truncated
          ? `(last ${data.lines.length} of ${data.totalLines} lines)\n\n`
          : `(${data.lines.length} lines)\n\n`;
      pre.textContent = header + formatJsonlPreview(data.lines);
    } catch (err) {
      pre.textContent = `Could not load ${name}: ${err.message}`;
    }
  }

  async function loadRunLog(runId) {
    const pre = $('#modalLog');
    pre.textContent = 'Loading…';
    try {
      const res = await fetch(`/api/run/${encodeURIComponent(runId)}/log`);
      const data = await res.json();
      if (!res.ok) {
        pre.textContent = data.error || '(no Cypress output saved for this run)';
        return;
      }
      pre.textContent = data.log || '(empty)';
      pre.scrollTop = pre.scrollHeight;
    } catch {
      pre.textContent = 'Failed to load log.';
    }
  }

  async function openRunDetails(runId, titleHint) {
    $('#modal').hidden = false;
    $('#modalTitle').textContent = titleHint ? `Run · ${titleHint}` : 'Run details';
    $('#modalSummary').innerHTML = '';
    $('#modalErrorsSection').hidden = true;
    $('#modalErrors').innerHTML = '';
    $('#modalArtifacts').innerHTML = '';
    $('#modalArtifactPreview').textContent = 'Loading…';
    $('#modalLog').textContent = 'Loading…';
    activeArtifactRunId = runId;

    try {
      const res = await fetch(`/api/run/${encodeURIComponent(runId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load run');
      const r = data.run;
      const acc = r.accuracy == null ? '—' : `${(r.accuracy * 100).toFixed(1)}%`;
      const agent = escapeHtml(agentDisplay(r.agent, r.provider));
      const when = `${fmtTime(r.startedAt)} → ${fmtTime(r.finishedAt)}`;

      $('#modalTitle').textContent = `${r.taskLabel || r.task} · ${agentDisplay(r.agent, r.provider)}`;

      $('#modalSummary').innerHTML = [
        summaryRow('When', escapeHtml(when)),
        summaryRow('Status', `<span class="pill pill-${r.status}">${STATUS_LABEL[r.status] || r.status}</span>`),
        summaryRow('Accuracy', escapeHtml(acc)),
        summaryRow('Trials', escapeHtml(String(r.nTrials || 0))),
        summaryRow('Duration', escapeHtml(fmtDuration(r.durationMs))),
        summaryRow('Age', escapeHtml(`${r.ageYears ?? '?'}y ${r.ageMonths ?? 0}m`)),
        r.personaAbility === 'irt'
          ? summaryRow('Persona', 'Child + IRT θ')
          : r.persona || r.agent === 'child'
            ? summaryRow('Persona', 'Child (accuracy)')
            : '',
        summaryRow('Participant', escapeHtml(r.email || '—')),
        summaryRow('Run ID', `<code>${escapeHtml(r.runId)}</code>`),
        summaryRow('Spec', `<code>${escapeHtml(r.spec || '—')}</code>`),
        summaryRow('Log dir', `<code>${escapeHtml(r.logDir || '—')}</code>`),
        data.gcsUri ? summaryRow('GCS', `<code>${escapeHtml(data.gcsUri)}</code>`) : '',
      ].join('');

      if (r.errors && r.errors.length) {
        $('#modalErrorsSection').hidden = false;
        $('#modalErrors').innerHTML = r.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('');
      }

      const arts = data.artifacts || [];
      const artEl = $('#modalArtifacts');
      if (!arts.length) {
        artEl.innerHTML = '<span class="empty-note">No JSONL artifacts found (local or GCS).</span>';
        $('#modalArtifactPreview').textContent = '—';
      } else {
        artEl.innerHTML = '';
        arts.forEach((name, i) => {
          const btn = el('button', 'artifact-tab' + (i === 0 ? ' active' : ''));
          btn.type = 'button';
          btn.textContent = name;
          btn.addEventListener('click', () => loadArtifactPreview(runId, name, btn));
          artEl.appendChild(btn);
        });
        loadArtifactPreview(runId, arts[0], artEl.querySelector('.artifact-tab'));
      }

      loadRunLog(runId);
    } catch (err) {
      $('#modalTitle').textContent = 'Run details';
      $('#modalSummary').innerHTML = `<dd>${escapeHtml(err.message)}</dd>`;
      $('#modalArtifactPreview').textContent = '—';
      $('#modalLog').textContent = '—';
    }
  }

  function openLog(runId, title) {
    openRunDetails(runId, title);
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
        const agent =
          agentDisplay(r.agent, r.provider) +
          (r.persona && r.agent !== 'child' ? ' <span class="tag">persona</span>' : '') +
          (r.personaAbility === 'irt' ? ' <span class="tag">IRT θ</span>' : '');
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
          <td>${dur}</td>
          <td><button type="button" class="btn-details" data-details="${escapeHtml(r.runId)}">Details</button></td>`;
        tr.querySelector('[data-details]').addEventListener('click', () =>
          openRunDetails(r.runId, r.taskLabel || r.task),
        );
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
