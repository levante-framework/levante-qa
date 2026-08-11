# Bench vs diag calibrator — matrix / en

Generated: 2026-08-11T02:52:50.412Z

## Joins
- Panel screen items with p_vlm: **80** (`/home/david/levante/levante-qa/tools/vlm-panel/out/screen_matrix_en.csv`)
- Matched diag `p_human`: **0**
- Matched bench trial pass-rates: **78** (`/home/david/levante/levante-bench/data/responses/v2/trials.csv`; aggregated `correct`, not proportions image1)
- Items in both human sources: **0**
- Age×item rates: **144** items (minN=5) → `/home/david/levante/levante-qa/tools/vlm-panel/calibration/age_item_rates_matrix.json`
- Item pass-rates cache: `/home/david/levante/levante-qa/tools/vlm-panel/calibration/item_pass_rates_matrix.json`
- Bench-joined items with any p_pred_age coverage: **76/78**

## In-sample fit
- Diag target: too few pairs (n=0)
- Bench trials target (n=78): MAE cal **0.097** / raw **0.223**; Spearman cal **0.258** / raw **0.261**

## Held-out CV
- Diag target: too few for CV
- Bench trials target (5, n=78): MAE cal **0.103** / raw **0.223**; Spearman cal **0.155** / raw **0.261**; bias 0.002

## Cross-check on dual-matched items
- MAE(pred_diag, p_diag): **—**
- MAE(pred_bench, p_bench): **—**
- MAE(pred_bench, p_diag): **—** (bench model vs diag labels)
- MAE(p_bench, p_diag): **—** (human sources agree?)

## Saved
- Bench calibrator: `/home/david/levante/levante-qa/tools/vlm-panel/calibration/matrix_en_bench.json`
- Age×item rates: `/home/david/levante/levante-qa/tools/vlm-panel/calibration/age_item_rates_matrix.json`
- Item pass-rates: `/home/david/levante/levante-qa/tools/vlm-panel/calibration/item_pass_rates_matrix.json`

Analyze: `--human-source=bench` uses `item_pass_rates_*.json` + `age_item_rates_*.json`.
