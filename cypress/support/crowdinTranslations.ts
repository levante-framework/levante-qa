type TranslationMap = Record<string, string>;

interface CrowdinApprovedTranslationsPayload {
  language: string;
  source: 'crowdin-approved';
  translationsByTask: Record<string, TranslationMap>;
}

function enabled(): boolean {
  return String(Cypress.env('QA_TRANSLATIONS_SOURCE') ?? '').toLowerCase() === 'crowdin-approved';
}

function qaLanguage(): string {
  return String(Cypress.env('QA_LANGUAGE') ?? '').trim();
}

function projectId(): string | undefined {
  const value = String(Cypress.env('QA_CROWDIN_PROJECT_ID') ?? '').trim();
  return value || undefined;
}

function cachePath(): string | undefined {
  const value = String(Cypress.env('QA_CROWDIN_CACHE_PATH') ?? '').trim();
  return value || undefined;
}

function refresh(): boolean {
  return /^(1|true|yes)$/i.test(String(Cypress.env('QA_CROWDIN_REFRESH') ?? ''));
}

function audioFallbackLanguage(): string | null {
  const value = String(Cypress.env('QA_AUDIO_FALLBACK_LANGUAGE') ?? '').trim();
  return value || null;
}

function taskFromTranslationUrl(url: string): string | null {
  const match = /\/translations\/itembank\/([^/?#]+)\/[^/?#]+\/item-bank-translations\.json/.exec(url);
  return match?.[1] ?? null;
}

function installAudioFallbackIntercept(language: string): void {
  const fallbackLanguage = audioFallbackLanguage();
  if (!fallbackLanguage || fallbackLanguage === language) return;

  cy.intercept('GET', '**/storage/v1/b/*/o?prefix=audio/**', async (req) => {
    const url = new URL(req.url);
    const prefix = url.searchParams.get('prefix') ?? '';
    if (!prefix.startsWith(`audio/${language}/`)) {
      req.continue();
      return;
    }

    url.searchParams.set('prefix', prefix.replace(`audio/${language}/`, `audio/${fallbackLanguage}/`));
    const response = await fetch(url.toString());
    const body = await response.json();
    const rewritten = {
      ...body,
      items: (body.items ?? []).map((item: { name?: string }) => ({
        ...item,
        name: item.name?.replace(`audio/${fallbackLanguage}/`, `audio/${language}/`),
      })),
    };
    req.reply({ statusCode: response.status, body: rewritten });
  });

  cy.intercept('GET', `**/audio/${language}/*.mp3*`, async (req) => {
    const fallbackUrl = req.url.replace(`/audio/${language}/`, `/audio/${fallbackLanguage}/`);
    req.redirect(fallbackUrl, 302);
  });
}

export function installCrowdinApprovedTranslationIntercept(): void {
  if (!enabled()) return;
  const language = qaLanguage();
  expect(language, 'QA_LANGUAGE is required for QA_TRANSLATIONS_SOURCE=crowdin-approved').to.not.equal('');
  installAudioFallbackIntercept(language);

  cy.task<CrowdinApprovedTranslationsPayload>('loadCrowdinApprovedTranslations', {
    language,
    projectId: projectId(),
    cachePath: cachePath(),
    refresh: refresh(),
  }).then((payload) => {
    cy.intercept('GET', '**/translations/itembank/**/item-bank-translations.json', (req) => {
      const task = taskFromTranslationUrl(req.url);
      const translations = task ? payload.translationsByTask[task] : null;
      if (!translations) req.continue();
      else {
        req.continue((res) => {
          if (res.statusCode >= 200 && res.statusCode < 300 && res.body && typeof res.body === 'object') {
            res.body = { ...(res.body as TranslationMap), ...translations };
          } else {
            res.send({ statusCode: 200, body: translations });
          }
        });
      }
    });
  });
}
