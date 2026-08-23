#!/usr/bin/env node
/**
 * Draft English TROG item specs (passive + X-but-not-Y), then a second-model
 * construction lock (Ma 2025 type-hit filter).
 *
 *   node tools/vlm-panel/aig_trog_specs.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  OUT_DIR,
  askGeminiText,
  bankConstructionStats,
  ensureOut,
  parseJsonArray,
  parseLockVerdict,
  slugWords,
} from './aig_trog_lib.mjs';

const WRITE_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const LOCK_MODEL = process.env.GEMINI_LOCK_MODEL || 'gemini-3.6-flash';
const N_PER = Number(process.env.AIG_TROG_N_PER || 6);

const CONSTRUCTIONS = [
  {
    id: 'reversible_passive',
    trial_type: 'reversible passive',
    uidPrefix: 'trog_aig_revpassive',
    rule:
      'The sentence MUST be a reversible passive: "the X is VERBed by the Y" ' +
      '(chase/push/follow/pull). Y is the actor. The reversed foil swaps X and Y.',
  },
  {
    id: 'x_but_not_y',
    trial_type: 'X but not Y',
    uidPrefix: 'trog_aig_xnoty',
    rule:
      'The sentence MUST use "but not" to exclude one actor or property ' +
      '(e.g. "the horse but not the boy is standing" or "the cat is big but not black"). ' +
      'Both the included and excluded bits must be pictureable.',
  },
];

function fewShotBlock(stats, id) {
  const items = stats[id]?.items ?? [];
  return items
    .map((it) => `- ${it.sentence}`)
    .join('\n');
}

function writePrompt(con, examples, already = []) {
  return [
    'You write NEW items for TROG (Test for Reception of Grammar), a 4-picture',
    'child language test. English only. Child-friendly animals/people/objects.',
    'Do NOT copy the example sentences. Do NOT use relative clauses, despite,',
    'although, however, or car/truck tunnel scenes.',
    '',
    `Construction: ${con.trial_type}`,
    con.rule,
    '',
    'Existing bank examples (do not repeat):',
    examples,
    already.length
      ? `\nAlready drafted this batch (do not repeat):\n${already.map((s) => `- ${s}`).join('\n')}`
      : '',
    '',
    `Write exactly ${N_PER} NEW items as a JSON array. Each object:`,
    '{',
    '  "sentence": "lowercase TROG-style sentence",',
    '  "target": "one-sentence picture brief of the CORRECT scene",',
    '  "foil_reversed": "same objects, swapped agent/patient or swapped inclusion",',
    '  "foil_lexical": "same grammar idea but a different object/action (lexical foil)",',
    '  "foil_extra": "both actors doing the same thing, or both properties true"',
    '}',
    'Picture briefs must be concrete, drawable clipart scenes (no text in the picture).',
    'Reply with JSON only.',
  ].join('\n');
}

function lockPrompt(con, spec) {
  return [
    'You check whether a drafted TROG item actually tests the REQUESTED construction.',
    'This is a type-lock check (Ma et al. 2025): looking grammatical is not enough.',
    '',
    `Requested construction: ${con.trial_type}`,
    con.rule,
    '',
    `Sentence: ${spec.sentence}`,
    `Target picture: ${spec.target}`,
    `Reversed foil: ${spec.foil_reversed}`,
    '',
    'Reply JSON only:',
    '{ "hit": true|false, "reason": "one short sentence" }',
    'hit=true only if the sentence is that construction AND the target uniquely',
    'matches it while the reversed foil does not.',
  ].join('\n');
}

function toUid(prefix, sentence) {
  const slug = slugWords(sentence) || 'item';
  return `${prefix}_${slug}`.slice(0, 80);
}

async function lockSpecs(drafted) {
  const locked = [];
  for (const spec of drafted) {
    const con = CONSTRUCTIONS.find((c) => c.id === spec.construction);
    try {
      let raw = '';
      for (const model of [LOCK_MODEL, WRITE_MODEL]) {
        raw = await askGeminiText({
          model,
          system:
            'You are a strict grammar-item reviewer. Reply with JSON only: {"hit":true,"reason":"..."}.',
          user: lockPrompt(con, spec),
          temperature: 0,
          maxOutputTokens: 400,
        });
        if (String(raw).trim()) {
          spec.lock_model_used = model;
          break;
        }
      }
      const verdict = parseLockVerdict(raw);
      spec.lock = {
        hit: !!verdict.hit,
        reason: String(verdict.reason || '').slice(0, 240),
        model: LOCK_MODEL,
        raw: String(raw).slice(0, 400),
      };
    } catch (err) {
      spec.lock = { hit: false, reason: `lock parse/error: ${err.message}`, model: LOCK_MODEL };
    }
    locked.push(spec);
    console.log(`  ${spec.lock.hit ? 'KEEP' : 'DROP'} ${spec.item_uid}: ${spec.lock.reason}`);
  }
  return locked;
}

function writePayload(locked) {
  const kept = locked.filter((s) => s.lock?.hit);
  const payload = {
    generated: new Date().toISOString(),
    writer_model: WRITE_MODEL,
    lock_model: LOCK_MODEL,
    n_drafted: locked.length,
    n_kept: kept.length,
    items: locked,
  };
  writeFileSync(join(OUT_DIR, 'specs_all.json'), JSON.stringify(payload, null, 2) + '\n');
  writeFileSync(
    join(OUT_DIR, 'specs_kept.json'),
    JSON.stringify({ ...payload, items: kept }, null, 2) + '\n',
  );
  console.log(`Wrote ${locked.length} drafts / ${kept.length} kept → ${OUT_DIR}`);
}

async function main() {
  ensureOut();
  const lockOnly = process.argv.includes('--lock-only');
  if (lockOnly) {
    const prevPath = join(OUT_DIR, 'specs_all.json');
    if (!existsSync(prevPath)) throw new Error(`Missing ${prevPath}`);
    const prev = JSON.parse(readFileSync(prevPath, 'utf-8'));
    console.log(`Re-locking ${prev.items.length} drafts with ${LOCK_MODEL}…`);
    writePayload(await lockSpecs(prev.items));
    return;
  }

  const stats = bankConstructionStats();
  const drafted = [];
  const append = process.argv.includes('--append');
  const prevPath = join(OUT_DIR, 'specs_all.json');
  const prevItems = append && existsSync(prevPath)
    ? JSON.parse(readFileSync(prevPath, 'utf-8')).items || []
    : [];
  const alreadyByCon = {
    reversible_passive: prevItems.filter((s) => s.construction === 'reversible_passive').map((s) => s.sentence),
    x_but_not_y: prevItems.filter((s) => s.construction === 'x_but_not_y').map((s) => s.sentence),
  };
  const seenUid = new Set(prevItems.map((s) => s.item_uid));

  for (const con of CONSTRUCTIONS) {
    const examples = fewShotBlock(stats, con.id);
    console.log(`Drafting ${N_PER} ${con.trial_type} with ${WRITE_MODEL}…`);
    const raw = await askGeminiText({
      model: WRITE_MODEL,
      system: 'You write child grammar-test items. Reply with JSON only.',
      user: writePrompt(con, examples, alreadyByCon[con.id] || []),
      temperature: 0.8,
      maxOutputTokens: 2500,
    });
    let items;
    try {
      items = parseJsonArray(raw);
    } catch (err) {
      console.error(`Parse fail for ${con.id}: ${err.message}\n${raw.slice(0, 400)}`);
      continue;
    }
    for (const it of items) {
      const sentence = String(it.sentence || '').trim();
      if (!sentence) continue;
      const item_uid = toUid(con.uidPrefix, sentence);
      if (seenUid.has(item_uid)) continue;
      seenUid.add(item_uid);
      drafted.push({
        construction: con.id,
        trial_type: con.trial_type,
        item_uid,
        sentence,
        target: String(it.target || '').trim(),
        foil_reversed: String(it.foil_reversed || '').trim(),
        foil_lexical: String(it.foil_lexical || '').trim(),
        foil_extra: String(it.foil_extra || '').trim(),
        writer_model: WRITE_MODEL,
      });
    }
  }

  console.log(`Drafted ${drafted.length}. Construction lock with ${LOCK_MODEL}…`);
  const lockedNew = await lockSpecs(drafted);
  writePayload(append ? [...prevItems, ...lockedNew] : lockedNew);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
