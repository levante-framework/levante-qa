# VLM provider clients

Provider-agnostic clients that take a screenshot + system prompt and return the
**raw** model text. Normalization (into an Action, a digit, a number, …) is the
caller's job, so the same clients serve every VLM-agent task.

| File | Provider | Selected when `provider=` |
|---|---|---|
| `openai.ts` | OpenAI | `openai` (default) |
| `anthropic.ts` | Anthropic | `anthropic` |
| `gemini.ts` | Google Gemini | `gemini` |
| `index.ts` | dispatch + shared helpers (`askVLM`, `buildUserText`, `parseAction`) | — |

## Selecting a provider / model

- Provider: `--env provider=gemini` (Cypress env) takes precedence, else
  `VLM_PROVIDER` (`.env`), else `openai`.
- Gemini model: `GEMINI_MODEL` (e.g. `gemini-2.5-flash-lite`, `gemini-2.5-flash`,
  `gemini-2.5-pro`); default `gemini-2.5-flash`.
- Sampling temperature: `VLM_TEMPERATURE` (default `0` = deterministic for
  oracle/normal runs; the synthetic-respondent panel sets `> 0` for variance).

Adding a provider = one file exporting `(req: VLMRequest) => Promise<string>`
plus one line in the `CLIENTS` table in `index.ts`.

## Gotcha: "thinking" models and `maxOutputTokens` (important)

Reasoning/"thinking" models (e.g. **`gemini-2.5-pro`**) count their internal
thinking tokens against `maxOutputTokens`. The clients cap output at **32 tokens**
to force terse answers — fine for non-thinking models, but for a thinking model
the reasoning consumes the whole budget and the **visible answer is empty**,
which downstream looks like a **non-response on every item**.

`gemini.ts` handles this: it first requests `thinkingConfig.thinkingBudget = 0`;
if the model rejects that (pro variants do), it retries **with thinking enabled
and a larger `maxOutputTokens` (2048)** so the answer survives. If you add another
thinking-capable provider/model, replicate this — do not leave it at the 32-token
cap.

> History: a 32-token cap on the thinking retry path silently made
> `gemini-2.5-pro` 100% non-response in the VLM panels. Symptoms: `chosenIndex`
> null and `modelRaw` empty for that model only. See
> `tools/vlm-panel/README.md` → *Known issues* for the full write-up.

## Non-response semantics

An empty/unparseable model reply yields a `null` choice. Treat that as
**missing**, not wrong, in any analysis — counting it as incorrect biases
difficulty estimates and (since rates differ by language) can fabricate
cross-language effects.
