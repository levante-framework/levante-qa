const AIRTABLE_API = "https://api.airtable.com/v0";

function env(name, optional = false) {
  const v = process.env[name];
  if (!v && !optional) throw new Error(`Missing env ${name}`);
  return v || "";
}

async function createRecords(baseId, tableId, records, token) {
  const out = [];
  for (let i = 0; i < records.length; i += 10) {
    const chunk = records.slice(i, i + 10);
    const res = await fetch(`${AIRTABLE_API}/${baseId}/${tableId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        records: chunk.map((fields) => ({ fields })),
        typecast: true,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body?.error?.message || JSON.stringify(body).slice(0, 300);
      throw new Error(`Airtable ${tableId} ${res.status}: ${msg}`);
    }
    out.push(...(body.records || []));
  }
  return out;
}

/**
 * Store one Airtable row per submission in TranslationTracker → VoiceConfig
 * (PAT has write access there; schema.create is locked on that base).
 *
 * Filter: Service = "prolific-study-a"
 * Notes = full JSON payload { submission, ratings }
 */
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.json({ error: "POST only" });
  }

  try {
    const token = env("AIRTABLE_PAT");
    const baseId = env("AIRTABLE_BASE_ID");
    const inboxTable = env("AIRTABLE_INBOX_TABLE_ID");

    let payload = req.body;
    if (typeof payload === "string") payload = JSON.parse(payload);
    if (!payload?.submission || !Array.isArray(payload?.ratings)) {
      res.statusCode = 400;
      return res.json({ error: "Expected { submission, ratings[] }" });
    }

    const sub = payload.submission;
    const sid = String(sub.submission_id || "");
    const pid = String(sub.prolific_pid || "anonymous");
    const notes = JSON.stringify({
      study: "nl-trog-xlang-pilot",
      submission: sub,
      ratings: payload.ratings,
    });

    // Airtable multiline ~100k char limit; 38 ratings is well under.
    if (notes.length > 90000) {
      res.statusCode = 413;
      return res.json({ error: "Payload too large for inbox field" });
    }

    await createRecords(
      baseId,
      inboxTable,
      [
        {
          Locale: "study-a-nl-trog",
          DisplayName: `StudyA ${pid} ${sid.slice(0, 8)}`,
          Service: "prolific-study-a",
          VoiceName: "inbox",
          VoiceId: sid,
          Notes: notes,
        },
      ],
      token,
    );

    res.statusCode = 200;
    return res.json({ ok: true, n_ratings: payload.ratings.length, store: "voiceconfig-inbox" });
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    return res.json({ error: err.message || String(err) });
  }
};
