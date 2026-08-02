const ADEQUACY_CAPS = ["Wrong", "Major loss", "Minor loss", "Faithful"];
const APPROPRIATE_CAPS = ["Unusable", "Awkward", "Acceptable", "Natural"];

const params = new URLSearchParams(location.search);
const prolific = {
  pid: params.get("PROLIFIC_PID") || params.get("prolific_pid") || "",
  studyId: params.get("STUDY_ID") || params.get("study_id") || "",
  sessionId: params.get("SESSION_ID") || params.get("session_id") || "",
};

const state = {
  step: "consent", // consent | item | done | error
  idx: 0,
  items: [],
  completionCode: "NLTR0GA1",
  answers: {}, // identifier -> {adequacy, appropriateness, notes}
  startedAt: new Date().toISOString(),
  submissionId: crypto.randomUUID(),
  busy: false,
  error: "",
};

const app = document.getElementById("app");

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function currentItem() {
  return state.items[state.idx];
}

function progressPct() {
  if (!state.items.length) return 0;
  return Math.round((state.idx / state.items.length) * 100);
}

function renderScale(name, value, caps) {
  const buttons = caps
    .map((cap, score) => {
      const checked = Number(value) === score ? "checked" : "";
      return `<label>
        <input type="radio" name="${name}" value="${score}" ${checked} />
        <span class="score">${score}</span>
        <span class="cap">${esc(cap)}</span>
      </label>`;
    })
    .join("");
  return `<div class="choices">${buttons}</div>`;
}

function renderConsent() {
  app.innerHTML = `
    <section class="card">
      <h1>Dutch translations for a children’s language task</h1>
      <p>You will rate about <strong>${state.items.filter((i) => !i.is_attention_check).length}</strong>
        English → Dutch sentence pairs used in educational research with children.</p>
      <ul class="checklist">
        <li>For each pair, score <strong>meaning match</strong> (0–3) and <strong>child-friendly Dutch</strong> (0–3).</li>
        <li>Do <strong>not</strong> use machine translation tools.</li>
        <li>Desktop or laptop recommended. About 15–20 minutes.</li>
      </ul>
      <p class="small muted">By continuing you confirm you are 18+, a native/dominant Dutch speaker,
        and consent to anonymous research use of your ratings (Prolific ID used only for payment).</p>
      ${prolific.pid ? `<p class="small muted">Prolific ID detected: <code>${esc(prolific.pid)}</code></p>` : `<p class="small muted">Tip: open this study from Prolific so your ID is recorded automatically.</p>`}
      <div class="actions">
        <span></span>
        <button class="primary" id="start">Start</button>
      </div>
    </section>`;
  document.getElementById("start").onclick = () => {
    state.step = "item";
    state.idx = 0;
    render();
  };
}

function renderItem() {
  const item = currentItem();
  const ans = state.answers[item.identifier] || { adequacy: null, appropriateness: null, notes: "" };
  const canNext = ans.adequacy !== null && ans.appropriateness !== null;
  app.innerHTML = `
    <section class="card">
      <div class="progress">
        <span>Item ${state.idx + 1} of ${state.items.length}</span>
        <span>${progressPct()}%</span>
      </div>
      <div class="bar"><span style="width:${progressPct()}%"></span></div>
      <h2>Rate this translation</h2>
      <div class="pair">
        <div class="box">
          <div class="label">English (source)</div>
          <div class="text">${esc(item.source_en)}</div>
        </div>
        <div class="box">
          <div class="label">Dutch (translation)</div>
          <div class="text">${esc(item.translation)}</div>
        </div>
      </div>

      <fieldset class="scale">
        <legend>1. Meaning match</legend>
        <p class="hint">Does the Dutch mean the same thing? Ignore style.</p>
        ${renderScale("adequacy", ans.adequacy, ADEQUACY_CAPS)}
      </fieldset>

      <fieldset class="scale">
        <legend>2. Child-friendly Dutch</legend>
        <p class="hint">Would this sound natural to say to a child (~5–10 years)?</p>
        ${renderScale("appropriateness", ans.appropriateness, APPROPRIATE_CAPS)}
      </fieldset>

      <label class="small" for="notes"><strong>Optional note</strong> (if either score &lt; 3)</label>
      <textarea id="notes" placeholder="What felt off?">${esc(ans.notes)}</textarea>

      ${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}

      <div class="actions">
        <button class="ghost" id="back" ${state.idx === 0 ? "disabled" : ""}>Back</button>
        <button class="primary" id="next" ${canNext && !state.busy ? "" : "disabled"}>
          ${state.idx === state.items.length - 1 ? (state.busy ? "Submitting…" : "Submit") : "Next"}
        </button>
      </div>
    </section>`;

  for (const name of ["adequacy", "appropriateness"]) {
    for (const input of app.querySelectorAll(`input[name="${name}"]`)) {
      input.onchange = () => {
        const cur = state.answers[item.identifier] || { adequacy: null, appropriateness: null, notes: "" };
        cur[name] = Number(input.value);
        state.answers[item.identifier] = cur;
        state.error = "";
        render();
      };
    }
  }
  document.getElementById("notes").oninput = (e) => {
    const cur = state.answers[item.identifier] || { adequacy: null, appropriateness: null, notes: "" };
    cur.notes = e.target.value;
    state.answers[item.identifier] = cur;
  };
  document.getElementById("back").onclick = () => {
    if (state.idx > 0) {
      state.idx -= 1;
      state.error = "";
      render();
    }
  };
  document.getElementById("next").onclick = async () => {
    if (!canNext || state.busy) return;
    if (state.idx < state.items.length - 1) {
      state.idx += 1;
      state.error = "";
      render();
      return;
    }
    await submitAll();
  };
}

function attentionOk() {
  const details = [];
  let fails = 0;
  for (const item of state.items.filter((i) => i.is_attention_check)) {
    const a = state.answers[item.identifier];
    if (!a) {
      fails += 1;
      details.push(`${item.identifier}: missing`);
      continue;
    }
    let bad = false;
    if (item.expect?.adequacy_max != null && a.adequacy > item.expect.adequacy_max) bad = true;
    if (item.expect?.appropriateness_max != null && a.appropriateness > item.expect.appropriateness_max) bad = true;
    if (bad) {
      fails += 1;
      details.push(`${item.identifier}: adequacy=${a.adequacy} appropriateness=${a.appropriateness}`);
    }
  }
  // Reject only if both attention checks fail
  return { ok: fails < 2, fails, details: details.join("; ") };
}

async function submitAll() {
  state.busy = true;
  state.error = "";
  render();
  const attn = attentionOk();
  const completedAt = new Date().toISOString();
  const ratings = state.items.map((item) => {
    const a = state.answers[item.identifier];
    return {
      rating_id: `${state.submissionId}:${item.identifier}`,
      submission_id: state.submissionId,
      prolific_pid: prolific.pid,
      identifier: item.identifier,
      item_id: item.item_id,
      source_en: item.source_en,
      translation: item.translation,
      adequacy: a.adequacy,
      appropriateness: a.appropriateness,
      notes: a.notes || "",
      is_attention_check: !!item.is_attention_check,
      completed_at: completedAt,
    };
  });
  const payload = {
    submission: {
      submission_id: state.submissionId,
      prolific_pid: prolific.pid,
      study_id: prolific.studyId,
      session_id: prolific.sessionId,
      started_at: state.startedAt,
      completed_at: completedAt,
      n_ratings: ratings.length,
      attention_ok: attn.ok,
      attention_detail: attn.details,
      user_agent: navigator.userAgent.slice(0, 240),
      completion_code: state.completionCode,
    },
    ratings,
  };

  try {
    const res = await fetch("/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Submit failed (${res.status})`);
    state.step = "done";
    state.busy = false;
    render();
    // Prolific completion redirect after a short beat
    const cc = encodeURIComponent(state.completionCode);
    setTimeout(() => {
      location.href = `https://app.prolific.com/submissions/complete?cc=${cc}`;
    }, 2500);
  } catch (err) {
    state.busy = false;
    state.error = err.message || String(err);
    render();
  }
}

function renderDone() {
  app.innerHTML = `
    <section class="card">
      <h1>Thank you</h1>
      <p>Your ratings were saved. Redirecting you back to Prolific…</p>
      <p class="small muted">If you are not redirected, use completion code
        <code>${esc(state.completionCode)}</code> or open
        <a href="https://app.prolific.com/submissions/complete?cc=${esc(state.completionCode)}">this link</a>.</p>
    </section>`;
}

function render() {
  if (state.step === "consent") return renderConsent();
  if (state.step === "done") return renderDone();
  return renderItem();
}

async function boot() {
  try {
    const res = await fetch("/items.json", { cache: "no-store" });
    if (!res.ok) throw new Error("Could not load items.json");
    const data = await res.json();
    state.items = data.items || [];
    state.completionCode = data.completion_code || state.completionCode;
    if (!state.items.length) throw new Error("No items in survey pack");
    render();
  } catch (err) {
    app.innerHTML = `<section class="card"><h1>Survey unavailable</h1><p class="error">${esc(err.message)}</p></section>`;
  }
}

boot();
