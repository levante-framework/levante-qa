# Bench vs diag calibrator — vocab / en

Generated: 2026-08-09T18:36:51.028Z

## Joins
- Panel screen items with p_vlm: **170** (`/home/david/levante/levante-qa/tools/vlm-panel/out/screen_vocab_en.csv`)
- Matched diag `p_human`: **162**
- Matched bench trial pass-rates: **162** (`/home/david/levante/levante-bench/data/responses/v2/trials.csv`; aggregated `correct`, not proportions image1)
- Items in both human sources: **162**
- Age×item rates: **163** items (minN=5) → `/home/david/levante/levante-qa/tools/vlm-panel/calibration/age_item_rates_vocab.json`
- Item pass-rates cache: `/home/david/levante/levante-qa/tools/vlm-panel/calibration/item_pass_rates_vocab.json`
- Bench-joined items with any p_pred_age coverage: **162/162**

## In-sample fit
- Diag target (n=162): MAE cal **0.109** / raw **0.168**; Spearman cal **0.612** / raw **0.602**
- Bench trials target (n=162): MAE cal **0.112** / raw **0.185**; Spearman cal **0.599** / raw **0.597**

## Held-out CV
- Diag target (5, n=162): MAE cal **0.116** / raw **0.168**; Spearman cal **0.471** / raw **0.602**; bias 0.002
- Bench trials target (5, n=162): MAE cal **0.119** / raw **0.185**; Spearman cal **0.456** / raw **0.597**; bias 0.001

## Cross-check on dual-matched items
- MAE(pred_diag, p_diag): **0.109**
- MAE(pred_bench, p_bench): **0.112**
- MAE(pred_bench, p_diag): **0.114** (bench model vs diag labels)
- MAE(p_bench, p_diag): **0.035** (human sources agree?)

## Saved
- Bench calibrator: `/home/david/levante/levante-qa/tools/vlm-panel/calibration/vocab_en_bench.json`
- Age×item rates: `/home/david/levante/levante-qa/tools/vlm-panel/calibration/age_item_rates_vocab.json`
- Item pass-rates: `/home/david/levante/levante-qa/tools/vlm-panel/calibration/item_pass_rates_vocab.json`

Analyze: `--human-source=bench` uses `item_pass_rates_*.json` + `age_item_rates_*.json`.
