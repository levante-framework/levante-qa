# Bench vs diag calibrator — trog / en

Generated: 2026-08-01T16:29:13.042Z

## Joins
- Panel screen items with p_vlm: **99** (`/home/david/levante/levante-qa/tools/vlm-panel/out/screen_en.csv`)
- Matched diag `p_human`: **99**
- Matched bench trial pass-rates: **99** (`/home/david/levante/levante-bench/data/responses/v1/trials.csv`; aggregated `correct`, not proportions image1)
- Items in both human sources: **99**
- Age×item rates: **99** items (minN=5) → `/home/david/levante/levante-qa/tools/vlm-panel/calibration/age_item_rates_trog.json`
- Item pass-rates cache: `/home/david/levante/levante-qa/tools/vlm-panel/calibration/item_pass_rates_trog.json`
- Bench-joined items with any p_pred_age coverage: **99/99**

## In-sample fit
- Diag target (n=99): MAE cal **0.072** / raw **0.157**; Spearman cal **0.583** / raw **0.581**
- Bench trials target (n=99): MAE cal **0.072** / raw **0.157**; Spearman cal **0.583** / raw **0.581**

## Held-out CV
- Diag target (5, n=99): MAE cal **0.080** / raw **0.157**; Spearman cal **0.532** / raw **0.581**; bias 0.001
- Bench trials target (5, n=99): MAE cal **0.080** / raw **0.157**; Spearman cal **0.532** / raw **0.581**; bias 0.001

## Cross-check on dual-matched items
- MAE(pred_diag, p_diag): **0.072**
- MAE(pred_bench, p_bench): **0.072**
- MAE(pred_bench, p_diag): **0.072** (bench model vs diag labels)
- MAE(p_bench, p_diag): **0.000** (human sources agree?)

## Saved
- Bench calibrator: `/home/david/levante/levante-qa/tools/vlm-panel/calibration/trog_en_bench.json`
- Age×item rates: `/home/david/levante/levante-qa/tools/vlm-panel/calibration/age_item_rates_trog.json`
- Item pass-rates: `/home/david/levante/levante-qa/tools/vlm-panel/calibration/item_pass_rates_trog.json`

Analyze: `--human-source=bench` uses `item_pass_rates_*.json` + `age_item_rates_*.json`.
