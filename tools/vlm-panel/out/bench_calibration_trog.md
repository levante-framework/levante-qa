# Bench vs diag calibrator — trog / en

Generated: 2026-08-08T23:01:51.234Z

## Joins
- Panel screen items with p_vlm: **99** (`/home/david/levante/levante-qa/tools/vlm-panel/out/screen_en.csv`)
- Matched diag `p_human`: **99**
- Matched bench trial pass-rates: **99** (`/home/david/levante/levante-bench/data/responses/v2/trials.csv`; aggregated `correct`, not proportions image1)
- Items in both human sources: **99**
- Age×item rates: **99** items (minN=5) → `/home/david/levante/levante-qa/tools/vlm-panel/calibration/age_item_rates_trog.json`
- Item pass-rates cache: `/home/david/levante/levante-qa/tools/vlm-panel/calibration/item_pass_rates_trog.json`
- Bench-joined items with any p_pred_age coverage: **99/99**

## In-sample fit
- Diag target (n=99): MAE cal **0.056** / raw **0.105**; Spearman cal **0.706** / raw **0.650**
- Bench trials target (n=99): MAE cal **0.064** / raw **0.110**; Spearman cal **0.660** / raw **0.622**

## Held-out CV
- Diag target (5, n=99): MAE cal **0.071** / raw **0.105**; Spearman cal **0.605** / raw **0.650**; bias 0.004
- Bench trials target (5, n=99): MAE cal **0.079** / raw **0.110**; Spearman cal **0.544** / raw **0.622**; bias 0.004

## Cross-check on dual-matched items
- MAE(pred_diag, p_diag): **0.056**
- MAE(pred_bench, p_bench): **0.064**
- MAE(pred_bench, p_diag): **0.060** (bench model vs diag labels)
- MAE(p_bench, p_diag): **0.018** (human sources agree?)

## Saved
- Bench calibrator: `/home/david/levante/levante-qa/tools/vlm-panel/calibration/trog_en_bench.json`
- Age×item rates: `/home/david/levante/levante-qa/tools/vlm-panel/calibration/age_item_rates_trog.json`
- Item pass-rates: `/home/david/levante/levante-qa/tools/vlm-panel/calibration/item_pass_rates_trog.json`

Analyze: `--human-source=bench` uses `item_pass_rates_*.json` + `age_item_rates_*.json`.
