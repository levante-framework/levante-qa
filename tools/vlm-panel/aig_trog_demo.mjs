#!/usr/bin/env node
/**
 * Publish the AIG TROG batch as a scratch demo corpus (not the official bank).
 *
 *   node tools/vlm-panel/aig_trog_demo.mjs           # audio + webp + CSV locally
 *   node tools/vlm-panel/aig_trog_demo.mjs --upload  # push scratch files to levante-assets-draft
 *   node tools/vlm-panel/aig_trog_play.mjs           # local TROG-like player
 *
 * Hosted levante-tasks-demo reads -dev only and a cached audio index — do not put
 * research files there. Play locally; files live on -draft.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { GoogleGenAI } from '@google/genai';
import { OUT_DIR, ensureOut } from './aig_trog_lib.mjs';

const BUCKET = 'levante-assets-draft';
const CORPUS_NAME = 'trog-aig-en';
const TTS_MODELS = [
  process.env.GEMINI_TTS_MODEL,
  'gemini-2.5-flash-preview-tts',
  'gemini-2.5-pro-preview-tts',
].filter(Boolean);
const VOICE = process.env.GEMINI_TTS_VOICE || 'Kore';

const TRIAL_TYPE = {
  reversible_passive: 'reversible passive',
  x_but_not_y: 'X but not Y',
};

function parseArgs(argv) {
  return { upload: argv.includes('--upload') };
}

function shortSlug(uid) {
  return String(uid)
    .replace(/^trog_aig_(revpassive_|xnoty_)/, '')
    .replace(/_/g, '-');
}

function imageStem(uid, role) {
  const roleKey = role === 'target' ? 'target' : role.replace('foil_', '');
  return `aig-${shortSlug(uid)}-${roleKey}`;
}

function audioStem(index) {
  return `trog-aig-item-${index}`;
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(path, rows) {
  if (!rows.length) return;
  const header = Object.keys(rows[0]);
  const lines = [header.join(','), ...rows.map((r) => header.map((h) => csvEscape(r[h])).join(','))];
  writeFileSync(path, `${lines.join('\n')}\n`);
}

function pcmToWav(pcm, sampleRate = 24000, channels = 1) {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

async function generateSpeechMp3(sentence, destMp3) {
  if (existsSync(destMp3)) return destMp3;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const client = new GoogleGenAI({ apiKey });
  const prompt = `Speak this grammar-test sentence clearly and slowly. Do not add any other words: ${sentence}`;
  let lastErr;
  for (const model of TTS_MODELS) {
    try {
      const response = await client.models.generateContent({
        model,
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } },
          },
        },
      });
      const part = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      if (!part?.inlineData?.data) throw new Error(`no audio bytes from ${model}`);
      const raw = Buffer.from(part.inlineData.data, 'base64');
      const mime = String(part.inlineData.mimeType || '').toLowerCase();
      const tmpBase = join(tmpdir(), `trog-aig-${Date.now()}`);
      if (mime.includes('mpeg') || mime.includes('mp3')) {
        writeFileSync(destMp3, raw);
      } else if (mime.includes('wav')) {
        writeFileSync(`${tmpBase}.wav`, raw);
        execFileSync('ffmpeg', ['-y', '-i', `${tmpBase}.wav`, '-codec:a', 'libmp3lame', '-qscale:a', '4', destMp3], {
          stdio: 'pipe',
        });
      } else {
        const wav = pcmToWav(raw, 24000, 1);
        writeFileSync(`${tmpBase}.wav`, wav);
        execFileSync('ffmpeg', ['-y', '-i', `${tmpBase}.wav`, '-codec:a', 'libmp3lame', '-qscale:a', '4', destMp3], {
          stdio: 'pipe',
        });
      }
      return destMp3;
    } catch (err) {
      lastErr = err;
      console.warn(`  TTS fail ${model}: ${err.message || err}`);
    }
  }
  throw lastErr || new Error('all TTS models failed');
}

function gsutil(args) {
  execFileSync('gsutil', args, { stdio: 'inherit' });
}

function instructionRow() {
  return {
    source: '',
    block_index: '',
    audio_file: 'trog-instruct1',
    item: '',
    answer: '',
    trial_type: 'instructions',
    response_alternatives: '',
    chance_level: '',
    assessment_stage: 'instructions',
    item_id: 'trog-instruct1',
    d: '',
    prompt: "Now we're going to play a matching game! I'm going to say some words, and you touch the picture that goes with what I say. Ready?",
    orig_item_num: '0',
    task: 'TROG',
    corpus_id: 'TROG-aig-en',
    task_id: 'trog',
    item_uid: '',
    randomize: '',
    time_limit: '',
    difficulty: '',
    trial_num: '',
    required_selections: '',
    image: '',
  };
}

function testRow(item, index) {
  const audio = audioStem(index);
  const target = imageStem(item.item_uid, 'target');
  const foils = item.layout
    .filter((c) => c.role !== 'target')
    .map((c) => imageStem(item.item_uid, c.role));
  return {
    source: '',
    block_index: '',
    audio_file: audio,
    item: item.sentence,
    answer: target,
    trial_type: TRIAL_TYPE[item.construction] || item.construction,
    response_alternatives: foils.join(','),
    chance_level: '0.25',
    assessment_stage: 'test_response',
    item_id: audio,
    d: '',
    prompt: 'Touch the picture that shows...',
    orig_item_num: String(index),
    task: 'TROG',
    corpus_id: 'TROG-aig-en',
    task_id: 'trog',
    item_uid: item.item_uid,
    randomize: '',
    time_limit: '',
    difficulty: '',
    trial_num: String(index),
    required_selections: '',
    image: '',
  };
}

async function main() {
  const { upload } = parseArgs(process.argv);
  ensureOut();
  const manifest = JSON.parse(readFileSync(join(OUT_DIR, 'images_manifest.json'), 'utf-8'));
  const items = manifest.items || [];
  if (!items.length) throw new Error('no illustrated items in images_manifest.json');

  const demoDir = join(OUT_DIR, 'demo');
  const imgDir = join(demoDir, 'images');
  const audioDir = join(demoDir, 'audio');
  mkdirSync(imgDir, { recursive: true });
  mkdirSync(audioDir, { recursive: true });

  const uploads = [];
  const rows = [instructionRow()];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const index = i + 1;
    const itemDir = join(OUT_DIR, 'items', item.item_uid);
    console.log(`[${index}/${items.length}] ${item.sentence}`);

    for (const cell of item.layout) {
      const src = join(itemDir, `${cell.position}.png`);
      if (!existsSync(src)) throw new Error(`missing ${src}`);
      const stem = imageStem(item.item_uid, cell.role);
      const dest = join(imgDir, `${stem}.webp`);
      await sharp(src).resize(512, 512, { fit: 'contain', background: '#ffffff' }).webp({ quality: 86 }).toFile(dest);
      uploads.push({ local: dest, remote: `gs://${BUCKET}/visual/trog/${stem}.webp`, type: 'image/webp' });
    }

    const mp3 = join(audioDir, `${audioStem(index)}.mp3`);
    await generateSpeechMp3(item.sentence, mp3);
    uploads.push({ local: mp3, remote: `gs://${BUCKET}/audio/en-US/${audioStem(index)}.mp3`, type: 'audio/mpeg' });
    rows.push(testRow(item, index));
  }

  const csvPath = join(demoDir, `${CORPUS_NAME}.csv`);
  writeCsv(csvPath, rows);
  uploads.push({
    local: csvPath,
    remote: `gs://${BUCKET}/corpus/${CORPUS_NAME}.csv`,
    type: 'text/csv',
  });

  const playItems = {
    instruction:
      "Now we're going to play a matching game! I'm going to say some words, and you touch the picture that goes with what I say. Ready?",
    items: items.map((item, i) => ({
      item_uid: item.item_uid,
      sentence: item.sentence,
      audio: `audio/${audioStem(i + 1)}.mp3`,
      correct_position: item.correct_position,
      choices: [...item.layout]
        .sort((a, b) => a.position - b.position)
        .map((cell) => ({
          position: cell.position,
          role: cell.role,
          src: `images/${imageStem(item.item_uid, cell.role)}.webp`,
        })),
    })),
  };
  writeFileSync(join(demoDir, 'items.json'), `${JSON.stringify(playItems, null, 2)}\n`);
  const publicUrl =
    'https://storage.googleapis.com/levante-assets-draft/demos/trog-aig/index.html';
  writeFileSync(join(demoDir, 'index.html'), readFileSync(join(demoDir, 'play.html')));
  writeFileSync(
    join(demoDir, 'play_url.txt'),
    `${publicUrl}\nhttp://127.0.0.1:4177/\n`,
  );
  console.log(`wrote ${csvPath}`);

  if (!upload) {
    console.log('local only. Re-run with --upload to publish to levante-assets-draft.');
    return;
  }

  for (const u of uploads) {
    console.log(`upload ${u.remote}`);
    gsutil(['-h', `Content-Type:${u.type}`, '-h', 'Cache-Control:no-store, max-age=0', 'cp', u.local, u.remote]);
  }

  const site = `gs://${BUCKET}/demos/trog-aig`;
  execFileSync(
    'gsutil',
    ['-m', '-h', 'Cache-Control:no-store, max-age=0', 'cp', '-r',
      join(demoDir, 'index.html'),
      join(demoDir, 'play.html'),
      join(demoDir, 'items.json'),
      join(demoDir, 'images'),
      join(demoDir, 'audio'),
      `${site}/`,
    ],
    { stdio: 'inherit' },
  );
  console.log(`public demo: ${publicUrl}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
