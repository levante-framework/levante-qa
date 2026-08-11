# Bench vs diag calibrator — stories / en

Generated: 2026-08-11T06:10:47.093Z

## Joins
- Panel screen items with p_vlm: **29** (`/home/david/levante/levante-qa/tools/vlm-panel/out/screen_stories_en.csv`)
- Matched diag `p_human`: **26**
- Matched bench trial pass-rates: **26** (`/home/david/levante/levante-bench/data/responses/v2/trials.csv`; aggregated `correct`, not proportions image1)
- Items in both human sources: **26**
- Age×item rates: **44** items (minN=5) → `/home/david/levante/levante-qa/tools/vlm-panel/calibration/age_item_rates_stories.json`
- Item pass-rates cache: `/home/david/levante/levante-qa/tools/vlm-panel/calibration/item_pass_rates_stories.json`
- Bench-joined items with any p_pred_age coverage: **26/26**

## In-sample fit
- Diag target (n=26): MAE cal **0.114** / raw **0.221**; Spearman cal **0.565** / raw **0.556**
- Bench trials target (n=26): MAE cal **0.091** / raw **0.219**; Spearman cal **0.629** / raw **0.623**

## Held-out CV
- Diag target (loo, n=26): MAE cal **0.128** / raw **0.221**; Spearman cal **-0.091** / raw **0.556**; bias 0.033
- Bench trials target (loo, n=26): MAE cal **0.105** / raw **0.219**; Spearman cal **-0.049** / raw **0.623**; bias 0.019

## Cross-check on dual-matched items
- MAE(pred_diag, p_diag): **0.114**
- MAE(pred_bench, p_bench): **0.091**
- MAE(pred_bench, p_diag): **0.114** (bench model vs diag labels)
- MAE(p_bench, p_diag): **0.054** (human sources agree?)

## Saved
- Bench calibrator: `/home/david/levante/levante-qa/tools/vlm-panel/calibration/stories_en_bench.json`
- Age×item rates: `/home/david/levante/levante-qa/tools/vlm-panel/calibration/age_item_rates_stories.json`
- Item pass-rates: `/home/david/levante/levante-qa/tools/vlm-panel/calibration/item_pass_rates_stories.json`

Analyze: `--human-source=bench` uses `item_pass_rates_*.json` + `age_item_rates_*.json`.
