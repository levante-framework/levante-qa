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

function taskFromTranslationUrl(url: string): string | null {
  const match = /\/translations\/itembank\/([^/?#]+)\/[^/?#]+\/item-bank-translations\.json/.exec(url);
  return match?.[1] ?? null;
}

export function installCrowdinApprovedTranslationIntercept(): void {
  if (!enabled()) return;
  const language = qaLanguage();
  expect(language, 'QA_LANGUAGE is required for QA_TRANSLATIONS_SOURCE=crowdin-approved').to.not.equal('');

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
      else req.reply({ statusCode: 200, body: translations });
    });
  });
}
