# Chat summary — Cross-site permissions & WordPress-style auth rewrite

**Date range:** ~2026-07-17 (permissions probe) through 2026-07-18 (auth rewrite implementation)  
**Workspace context:** `levante-qa`, with work spanning `levante-support`, `levante-api`, `levante-dashboard`, `core-tasks`, `levante-firebase-functions`  
**Author note:** Persistent recap of the Cursor agent conversation for researchers / engineers continuing this work.

---

## 1. Where the conversation started (broader QA context)

Earlier in the same thread (before the security / auth rewrite focus), the team had been working on:

- Stabilizing oracle / VLM runs on `hs-levante-admin-dev`
- VLM panel analysis for TROG, Stories (Theory of Mind), and ROAR **SWR** / **SRE**
- Cross-language difficulty screening (`p_vlm`, ability spread, non-response handling)
- Fixes such as Gemini `gemini-2.5-pro` empty responses (`maxOutputTokens` too low on thinking-mode retry)
- ROAR launch fallbacks when dashboard game links were missing
- Provisioning collision fixes for long panel run IDs

That work produced reports under `tools/vlm-panel/out/` and agents under `cypress/e2e/{swr,sre}/vlm_agent.cy.ts`. Human psychometric joins from Redivis were deferred for ROAR.

The conversation then shifted to a security question about unauthorized site/admin creation.

---

## 2. Security question: what can a new site admin do?

### Questions asked

1. If an unknown party creates a site with admins and users, what damage could they do to the database?
2. Can a new site admin see participant data from other sites?
3. Can they issue Firestore `runQuery` from the dashboard or another way?

### Intended design (from code / docs)

Levante’s RBAC intends **site-scoped** access:

- Roles: `super_admin`, `site_admin`, `admin`, `research_assistant`, `participant`
- Spec / E2E docs: `levante-support/docs/levante-dashboard/README_TESTS_PERMISSIONS.md`
- UI suite: `levante-support/cypress/e2e/researchers/tasks/permissions.cy.ts`

Existing permissions E2E (route/UI gating) **passed** on `hs-levante-admin-dev` (admin / site_admin / research_assistant cases). That suite does **not** prove Firestore data isolation.

### Concrete cross-site probe (definitive finding)

A dedicated Cypress probe was added and run:

- Spec: `levante-support/cypress/e2e/researchers/tasks/cross-site-participant-access.cy.ts`
- Evidence: `levante-support/cypress/tmp/cross-site-participant-access-result.json`
- Setup: Site A (`ai-tests`) site_admin vs Site B (`ai-tests-b`) participant  
  - Participant B uid: `RuQwc7acz6hfSJ67MFcTuEf0SbG2`
  - Re-run used synthetic `ai-site-admin-a@levante.test` to avoid confound from a real multi-site account (`david81@stanford.edu`)

| Probe | Result |
|-------|--------|
| Direct `GET .../documents/users/{siteBUid}` with Site A admin ID token | **403** (blocked) |
| Firestore REST `documents:runQuery` on `users` filtered by Site B `districts.current` | **200**, returned the Site B participant **with full fields** (email, orgs, assignments, etc.) |

**Verdict:** Cross-site participant data **was exposed via `runQuery`**, even though direct document GET was denied. UI permission gating alone does not stop this.

### Can they run `runQuery` from the dashboard?

**Yes — both from a logged-in browser and outside it.**

- From the dashboard session: DevTools / any client code can call Firestore REST with the same auth token the app uses. There does not need to be a “Run Query” button.
- Outside the dashboard: script / Postman / curl with email+password → ID token → same REST calls.
- Conclusion: this is a **backend rules / authorization** gap, not a frontend-only issue.

---

## 3. Decision: WordPress-style auth rewrite

The user asked for a complete rewrite of dashboard / core-tasks / firebase-functions identity so users and admins are **not** tied to Google / Firebase Auth logins, but stored in tables like WordPress.

### Locked choices

| Decision | Choice |
|----------|--------|
| Auth model | **1A** — email/username + hashed password + HTTP-only session cookies |
| Data store | **2D → recommended Postgres SoT** for identity, orgs, assignments, and runs (not “Auth in SQL, profiles in Firestore”) |
| Google login | Out of scope for v1 |
| Cutover | Greenfield API + DB first; migrate later (not big-bang prod day one) |

Plan file (do not treat as editable deliverable in this recap):  
`~/.cursor/plans/wp-style_auth_rewrite_a436a0ca.plan.md`

Rationale against hybrid Firestore profiles: recreates dual-UID (`adminUid` / `roarUid`) complexity and the same class of query ACL bugs.

Existing schema sketch reused / superseded by executable migrations:  
`levante-support/schema_tools/POSTGRES_PROTO_SCHEMA.md` (points at `levante-api` migrations).

---

## 4. What was implemented

### 4.1 New service: `levante-api`

Path: `/home/david/levante/levante-api`

- Express API + PostgreSQL (`docker` / `docker compose`, default `:4080`)
- Migration: `migrations/001_init.sql` — users (`user_login`, `user_email`, `user_pass` argon2), `user_meta`, `user_roles`, `user_org_membership`, `sessions`, organizations, administrations, runs, trials, `run_tokens`
- Scripts: `npm run migrate`, `npm run seed`, `npm test`, `npm run migrate:firestore`
- Auth routes: login / logout / me / reset-password (session cookie `levante_session`)
- Site-scoped users, orgs, administrations; run lifecycle for tasks
- **ACL regression tests** (`tests/auth-acl.test.js`): Site A admin cannot list or GET Site B users (**6/6 passing** when API is up)

Seed logins (from seed script; rotate if used beyond local):

| Login | Role | Site |
|-------|------|------|
| `siteadmin-a` | site_admin | ai-tests |
| `admin-a` | admin | ai-tests |
| `participant-a` | participant | ai-tests |
| `siteadmin-b` | site_admin | ai-tests-b |
| `participant-b` | participant | ai-tests-b |

### 4.2 Dashboard (`levante-dashboard`)

- Feature flag: `VITE_AUTH_MODE=session` + `VITE_LEVANTE_API_URL` (see `.env.session.example`)
- Session client: `src/api/sessionClient.ts`
- Auth store branches for session login / logout / me (no Firebase Auth when flagged)
- Sign-in hides Google when in session mode; redirects to `/session-home`
- `SessionHome.vue` — site selector + site-scoped user list via API
- `DashboardLevanteApiKit` + `TaskLevante.vue` session path for run/trial persistence without firekit Auth

### 4.3 Core tasks (`core-tasks`)

- Adapter: `task-launcher/src/adapters/levanteApiKit.ts` (startRun / writeTrial / finishRun → API)
- Smoke: `npm run smoke:levante-api` (login → run → trials → complete)

### 4.4 Firebase functions disposition

- Note: `levante-firebase-functions/SESSION_AUTH_MIGRATION.md`
- Stop adding new Auth / `setUidClaims` product paths; keep read-only Admin SDK for migration until cutover
- Long-term: decommission human login on admin Auth; GCS/assets can remain

### 4.5 Migration path (Phase 5 scaffolding)

- `levante-api/scripts/migrate-firestore.js`
- Maps Firebase users → Postgres; stores `legacy_firebase_uid` in `user_meta`
- Sets `must_reset_password=true` (no Firebase password hashes to import)
- Requires `LEVANTE_ADMIN_FIREBASE_CREDENTIALS` + optional `firebase-admin` for live export; without credentials it writes a stub report under `levante-api/out/`

---

## 5. Architecture (target vs today)

```text
TODAY
  Dashboard → firekit (dual Firebase Auth) → Functions + Firestore rules
  Tasks → firekit startRun / writeTrial → users/{uid}/runs

TARGET
  Dashboard → session cookie → levante-api → Postgres
  Tasks → run token / session → levante-api → runs + trials
```

Server-side membership filters on list/query endpoints are the intended fix for the Firestore `runQuery` hole.

---

## 6. Success criteria status

| Criterion | Status |
|-----------|--------|
| Admin/participant sign-in with username/email + password; no Google Auth (session mode) | Implemented locally |
| No Firebase Auth ID token required for session-mode dashboard / task saves | Implemented for session path |
| Site A admin cannot read Site B participants via list/query **API** | Covered by `levante-api` tests (403) |
| Assignment → task → run → trials on Postgres | Smoke path verified; full UI assignment UX still thin vs legacy dashboard |
| QA Firestore probe adapted to new API | API ACL tests serve as the regression; Cypress probe remains useful against **legacy** Firebase until cutover |

---

## 7. Explicit non-goals (v1) — still deferred

- Google / SSO / magic links
- Perfect 1:1 Firestore field parity
- Rewriting task cognitive content
- Replacing GCS corpora pipelines
- Full Groups / Assignments UI parity on session API (org/assignment endpoints exist; dashboard still mostly firekit for non-flagged mode)

---

## 8. How to pick up this work

```bash
# API
cd /home/david/levante/levante-api
docker compose up -d   # or start existing levante-pg
npm install && npm run migrate && npm run seed
npm start              # :4080
npm test

# Dashboard session mode
# copy levante-dashboard/.env.session.example → .env.local
# VITE_AUTH_MODE=session
# VITE_LEVANTE_API_URL=http://localhost:4080

# Task persistence smoke
cd /home/david/levante/core-tasks/task-launcher
npm run smoke:levante-api
```

**Still open for production cutover**

1. Harden / complete org & assignment dashboard pages on the API  
2. Run live Firestore→Postgres migration with credentials; forced password-reset UX for migrated users  
3. Dual-run on `-dev`, then prod cutover  
4. Until Firebase Auth is gone, treat the `runQuery` hole as a **live risk** on current rules — fix rules or remove client Firestore user queries independently of the rewrite if prod remains on Firebase Auth for a while  

---

## 9. Key file index

| Area | Path |
|------|------|
| API README | `levante-api/README.md` |
| Schema migration | `levante-api/migrations/001_init.sql` |
| ACL tests | `levante-api/tests/auth-acl.test.js` |
| Firestore migrate script | `levante-api/scripts/migrate-firestore.js` |
| Dashboard session client | `levante-dashboard/src/api/sessionClient.ts` |
| Session home | `levante-dashboard/src/pages/SessionHome.vue` |
| Auth store session branch | `levante-dashboard/src/store/auth.ts` |
| Core-tasks adapter | `core-tasks/task-launcher/src/adapters/levanteApiKit.ts` |
| Legacy cross-site Cypress probe | `levante-support/cypress/e2e/researchers/tasks/cross-site-participant-access.cy.ts` |
| Probe evidence JSON | `levante-support/cypress/tmp/cross-site-participant-access-result.json` |
| Permissions E2E docs | `levante-support/docs/levante-dashboard/README_TESTS_PERMISSIONS.md` |
| FF migration note | `levante-firebase-functions/SESSION_AUTH_MIGRATION.md` |

---

*Document created to preserve chat findings and implementation state for follow-on work. Update this file when cutover milestones land.*
