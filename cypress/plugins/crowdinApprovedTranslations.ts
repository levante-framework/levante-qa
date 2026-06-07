import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import JSZip from 'jszip';

const CROWDIN_API_BASE = 'https://api.crowdin.com/api/v2';
const DEFAULT_PROJECT_ID = '756721';
const DEFAULT_CACHE_PATH = 'cypress/cache/crowdin-approved-translations.zip';

const TASK_ALIASES: Record<string, string> = {
  'egma-math': 'math',
  'matrix-reasoning': 'pattern-matching',
  'mental-rotation': 'shape-rotation',
  'same-different-selection': 'same-and-different',
  trog: 'sentence-understanding',
  'theory-of-mind': 'stories',
};

interface CrowdinBuildResponse {
  data?: {
    id?: number | string;
    status?: string;
  };
}

export interface CrowdinApprovedTranslationsRequest {
  language: string;
  projectId?: string;
  cachePath?: string;
  refresh?: boolean;
}

export interface CrowdinApprovedTranslationsPayload {
  language: string;
  source: 'crowdin-approved';
  translationsByTask: Record<string, Record<string, string>>;
}

function crowdinToken(): string {
  const fromEnv = process.env.CROWDIN_API_TOKEN || process.env.CROWDIN_TOKEN;
  if (fromEnv?.trim()) return fromEnv.trim();
  const tokenPath = `${homedir()}/.crowdin_api_token`;
  if (existsSync(tokenPath)) return readFileSync(tokenPath, 'utf-8').trim();
  throw new Error('Crowdin token not found. Set CROWDIN_API_TOKEN/CROWDIN_TOKEN or create ~/.crowdin_api_token.');
}

async function crowdinJson(path: string, init: RequestInit = {}): Promise<CrowdinBuildResponse> {
  const res = await fetch(`${CROWDIN_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${crowdinToken()}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`Crowdin ${res.status} for ${path}: ${await res.text()}`);
  return (await res.json()) as CrowdinBuildResponse;
}

async function fetchApprovedZip(projectId: string): Promise<Buffer> {
  const build = await crowdinJson(`/projects/${projectId}/translations/builds`, {
    method: 'POST',
    body: JSON.stringify({ exportApprovedOnly: true }),
  });
  const buildId = build.data?.id;
  if (!buildId) throw new Error(`Crowdin build response missing id: ${JSON.stringify(build)}`);

  for (let i = 0; i < 40; i += 1) {
    const status = await crowdinJson(`/projects/${projectId}/translations/builds/${buildId}`);
    const state = status.data?.status;
    if (state === 'finished') {
      const download = await crowdinJson(`/projects/${projectId}/translations/builds/${buildId}/download`);
      const zipUrl = (download.data as { url?: string } | undefined)?.url;
      if (!zipUrl) throw new Error(`Crowdin download response missing url: ${JSON.stringify(download)}`);
      const zipRes = await fetch(zipUrl);
      if (!zipRes.ok) throw new Error(`Crowdin ZIP download failed: ${zipRes.status}`);
      return Buffer.from(await zipRes.arrayBuffer());
    }
    if (state === 'failed' || state === 'cancelled') throw new Error(`Crowdin build ${state}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('Crowdin build did not finish in time.');
}

async function approvedZip(projectId: string, cachePath: string, refresh: boolean): Promise<Buffer> {
  if (!refresh && existsSync(cachePath)) return readFileSync(cachePath);
  const zip = await fetchApprovedZip(projectId);
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, zip);
  return zip;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripTags(value: string): string {
  return decodeXml(value.replace(/<[^>]+>/g, '')).trim();
}

function parseXliffTranslations(xml: string): Record<string, string> {
  const translations: Record<string, string> = {};
  const unitRe = /<(?:[^:\s>]+:)?trans-unit\b([^>]*)>([\s\S]*?)<\/(?:[^:\s>]+:)?trans-unit>|<(?:[^:\s>]+:)?unit\b([^>]*)>([\s\S]*?)<\/(?:[^:\s>]+:)?unit>/g;
  for (const match of xml.matchAll(unitRe)) {
    const attrs = match[1] || match[3] || '';
    const body = match[2] || match[4] || '';
    const id = /(?:\sid|resname)="([^"]+)"/.exec(attrs)?.[1];
    const target = /<(?:[^:\s>]+:)?target\b[^>]*>([\s\S]*?)<\/(?:[^:\s>]+:)?target>/.exec(body)?.[1];
    if (id && target) translations[decodeXml(id)] = stripTags(target);
  }
  return translations;
}

function addAliases(translationsByTask: Record<string, Record<string, string>>): void {
  for (const [runtimeTask, crowdinTask] of Object.entries(TASK_ALIASES)) {
    if (translationsByTask[crowdinTask] && !translationsByTask[runtimeTask]) {
      translationsByTask[runtimeTask] = translationsByTask[crowdinTask];
    }
  }
}

export async function loadCrowdinApprovedTranslations({
  language,
  projectId = process.env.CROWDIN_PROJECT_ID || DEFAULT_PROJECT_ID,
  cachePath = process.env.QA_CROWDIN_CACHE_PATH || DEFAULT_CACHE_PATH,
  refresh = /^(1|true|yes)$/i.test(process.env.QA_CROWDIN_REFRESH || ''),
}: CrowdinApprovedTranslationsRequest): Promise<CrowdinApprovedTranslationsPayload> {
  const zipBytes = await approvedZip(projectId, cachePath, refresh);
  const zip = await JSZip.loadAsync(zipBytes);
  const translationsByTask: Record<string, Record<string, string>> = {};
  const prefix = `${language}/main/itembank_by_task/`;

  await Promise.all(
    Object.values(zip.files)
      .filter((file) => !file.dir && file.name.startsWith(prefix) && file.name.endsWith('.xliff'))
      .map(async (file) => {
        const taskName = file.name.slice(prefix.length).replace(/\.xliff$/, '');
        translationsByTask[taskName] = parseXliffTranslations(await file.async('string'));
      }),
  );
  addAliases(translationsByTask);

  return { language, source: 'crowdin-approved', translationsByTask };
}
