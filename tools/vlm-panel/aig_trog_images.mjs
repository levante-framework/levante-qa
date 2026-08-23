#!/usr/bin/env node
/**
 * Generate four TROG-like clipart scenes per kept spec and compose a numbered 2×2.
 *
 *   node tools/vlm-panel/aig_trog_images.mjs [--max-per 3]
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  OUT_DIR,
  ensureOut,
  generateGeminiImage,
} from './aig_trog_lib.mjs';

const IMAGE_MODELS = [
  process.env.GEMINI_IMAGE_MODEL,
  'gemini-2.5-flash-image',
  'gemini-2.0-flash-preview-image-generation',
].filter(Boolean);

const SKIP = new Set([
  'trog_aig_xnoty_ball_big_round', // a ball that is not round is not pictureable
  'trog_aig_xnoty_bear_happy_waving', // "happy" is not a clean TROG foil
]);

const STYLE =
  'Children’s assessment clipart, TROG style: simple flat colors, thick outlines, ' +
  'plain white background, no text, no letters, no numbers, no watermark, ' +
  'one clear scene, no photorealism.';

function parseArgs(argv) {
  const out = { maxPer: 3 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--max-per') out.maxPer = Number(argv[++i]);
  }
  return out;
}

function hashUid(uid) {
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = (h * 33 + uid.charCodeAt(i)) >>> 0;
  return h;
}

function shufflePositions(uid) {
  const cells = [
    { role: 'target', key: 'target' },
    { role: 'reversed', key: 'foil_reversed' },
    { role: 'lexical', key: 'foil_lexical' },
    { role: 'extra', key: 'foil_extra' },
  ];
  let h = hashUid(uid);
  for (let i = cells.length - 1; i > 0; i--) {
    h = (h * 1103515245 + 12345) >>> 0;
    const j = h % (i + 1);
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  return cells.map((c, i) => ({ ...c, position: i + 1 }));
}

function alreadyIllustrated(uid) {
  return existsSync(join(OUT_DIR, 'items', uid, 'layout.json'));
}

function pickSpecs(all, maxPer) {
  const by = { reversible_passive: [], x_but_not_y: [] };
  for (const spec of all) {
    if (SKIP.has(spec.item_uid)) continue;
    if (!by[spec.construction]) continue;
    if (alreadyIllustrated(spec.item_uid)) continue;
    if (by[spec.construction].length >= maxPer) continue;
    by[spec.construction].push(spec);
  }
  return [...by.reversible_passive, ...by.x_but_not_y];
}

async function oneImage(brief) {
  const prompt = `${STYLE}\nScene: ${brief}`;
  let lastErr;
  for (const model of IMAGE_MODELS) {
    try {
      const buf = await generateGeminiImage({ model, prompt });
      return { buf, model };
    } catch (err) {
      lastErr = err;
      console.warn(`  image fail ${model}: ${err.message}`);
    }
  }
  throw lastErr || new Error('all image models failed');
}

async function composeQuad(cellBufs) {
  const cell = 512;
  const pad = 16;
  const labelH = 36;
  const W = pad * 3 + cell * 2;
  const H = pad * 3 + (cell + labelH) * 2;
  const tiles = [];
  for (let i = 0; i < 4; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const resized = await sharp(cellBufs[i])
      .resize(cell, cell, { fit: 'contain', background: '#ffffff' })
      .png()
      .toBuffer();
    const labeled = await sharp({
      create: {
        width: cell,
        height: cell + labelH,
        channels: 3,
        background: '#ffffff',
      },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="${cell}" height="${labelH}">` +
              `<rect width="100%" height="100%" fill="white"/>` +
              `<text x="12" y="26" font-size="22" font-family="Arial, sans-serif" fill="#1a365d">${i + 1}</text>` +
              `</svg>`,
          ),
          top: 0,
          left: 0,
        },
        { input: resized, top: labelH, left: 0 },
      ])
      .png()
      .toBuffer();
    tiles.push({
      input: labeled,
      top: pad + row * (cell + labelH + pad),
      left: pad + col * (cell + pad),
    });
  }
  return sharp({
    create: { width: W, height: H, channels: 3, background: '#f7fafc' },
  })
    .composite(tiles)
    .png()
    .toBuffer();
}

async function main() {
  ensureOut();
  const { maxPer } = parseArgs(process.argv);
  const keptPath = join(OUT_DIR, 'specs_kept.json');
  const kept = JSON.parse(readFileSync(keptPath, 'utf-8'));
  const specs = pickSpecs(kept.items, maxPer);
  if (!specs.length) throw new Error('No new specs to illustrate');

  const prevPath = join(OUT_DIR, 'images_manifest.json');
  const prev = existsSync(prevPath) ? JSON.parse(readFileSync(prevPath, 'utf-8')) : { items: [] };
  const seen = new Set((prev.items || []).map((it) => it.item_uid));
  const manifest = {
    generated: new Date().toISOString(),
    n: 0,
    items: [...(prev.items || [])],
  };

  for (const spec of specs) {
    const dir = join(OUT_DIR, 'items', spec.item_uid);
    mkdirSync(dir, { recursive: true });
    const layout = shufflePositions(spec.item_uid);
    const correct = layout.find((c) => c.role === 'target').position;
    console.log(`Images for ${spec.item_uid} (target=${correct})…`);
    const cellBufs = [];
    for (const cell of layout) {
      const pngPath = join(dir, `${cell.position}.png`);
      if (existsSync(pngPath)) {
        cellBufs.push(readFileSync(pngPath));
        continue;
      }
      const brief = spec[cell.key];
      const { buf, model } = await oneImage(brief);
      writeFileSync(pngPath, buf);
      cell.model = model;
      cellBufs.push(buf);
    }
    const quad = await composeQuad(cellBufs);
    writeFileSync(join(dir, 'quad.png'), quad);
    const rec = {
      item_uid: spec.item_uid,
      construction: spec.construction,
      sentence: spec.sentence,
      correct_position: correct,
      layout,
      quad: join('items', spec.item_uid, 'quad.png'),
    };
    writeFileSync(join(dir, 'layout.json'), JSON.stringify(rec, null, 2) + '\n');
    if (!seen.has(rec.item_uid)) manifest.items.push(rec);
  }

  manifest.n = manifest.items.length;
  writeFileSync(join(OUT_DIR, 'images_manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Wrote ${specs.length} new quads (${manifest.n} total) → ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
