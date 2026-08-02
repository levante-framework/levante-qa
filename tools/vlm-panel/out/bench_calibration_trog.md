# Bench vs diag calibrator — trog / en

Generated: 2026-08-01T21:42:22.448Z

## Joins
- Panel screen items with p_vlm: **99** (`/home/david/levante/levante-qa/tools/vlm-panel/out/screen_en.csv`)
- Matched diag `p_human`: **90**
- Matched bench trial pass-rates: **99** (`/home/david/levante/levante-bench/data/responses/v1/trials.csv`; aggregated `correct`, not proportions image1)
- Items in both human sources: **90**
- Age×item rates: **99** items (minN=5) → `/home/david/levante/levante-qa/tools/vlm-panel/calibration/age_item_rates_trog.json`
- Item pass-rates cache: `/home/david/levante/levante-qa/tools/vlm-panel/calibration/item_pass_rates_trog.json`
- Bench-joined items with any p_pred_age coverage: **99/99**

## In-sample fit
- Diag target (n=90): MAE cal **0.093** / raw **0.164**; Spearman cal **0.447** / raw **0.402**
- Bench trials target (n=99): MAE cal **0.066** / raw **0.136**; Spearman cal **0.675** / raw **0.634**

## Held-out CV
- Diag target (5, n=90): MAE cal **0.108** / raw **0.164**; Spearman cal **0.300** / raw **0.402**; bias 0.003
- Bench trials target (5, n=99): MAE cal **0.077** / raw **0.136**; Spearman cal **0.573** / raw **0.634**; bias 0.004

## Cross-check on dual-matched items
- MAE(pred_diag, p_diag): **0.093**
- MAE(pred_bench, p_bench): **0.070**
- MAE(pred_bench, p_diag): **0.105** (bench model vs diag labels)
- MAE(p_bench, p_diag): **0.075** (human sources agree?)

## Saved
- Bench calibrator: `/home/david/levante/levante-qa/tools/vlm-panel/calibration/trog_en_bench.json`
- Age×item rates: `/home/david/levante/levante-qa/tools/vlm-panel/calibration/age_item_rates_trog.json`
- Item pass-rates: `/home/david/levante/levante-qa/tools/vlm-panel/calibration/item_pass_rates_trog.json`

Analyze: `--human-source=bench` uses `item_pass_rates_*.json` + `age_item_rates_*.json`.
