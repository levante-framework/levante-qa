# Residual audit — vocab / en

Generated: 2026-08-02T22:47:44.900Z
Source: `/home/david/levante/levante-qa/tools/vlm-panel/out/screen_vocab_en.csv`

## Summary
- Matched items: **162**
- Mean |p_vlm − p_human|: **0.168**
- Mean bias (vlm − human): **0.157** (positive = VLM too easy)
- Mean |p_pred_child − p_human|: **0.108**

## By construction tag (mean |raw err|)
| tag | n | mae_raw | bias_raw |
|---|---:|---:|---:|
| rare_vocab | 162 | 0.168 | 0.157 |

## Top 20 raw residuals
| |err| | bias | p_vlm | p_human | item_uid | tags | transcript |
|---:|---:|---:|---:|---|---|---|
| 0.72 | 0.72 | 0.83 | 0.11 | vocab_word_divan | rare_vocab | the divan |
| 0.70 | 0.70 | 0.92 | 0.22 | vocab_word_ecstatic | rare_vocab | ecstatic |
| 0.68 | 0.68 | 0.76 | 0.08 | vocab_word_squash | rare_vocab | the squash |
| 0.58 | 0.58 | 1.00 | 0.42 | vocab_word_kazoo | rare_vocab | the kazoo |
| 0.51 | 0.51 | 0.61 | 0.11 | vocab_word_dredging | rare_vocab | dredging |
| 0.46 | 0.46 | 1.00 | 0.54 | vocab_word_sorbet | rare_vocab | the sorbet |
| 0.45 | 0.45 | 0.76 | 0.31 | vocab_word_degression | rare_vocab | degression |
| 0.42 | 0.42 | 0.75 | 0.33 | vocab_word_precarious | rare_vocab | precarious |
| 0.42 | 0.42 | 1.00 | 0.58 | vocab_word_beret | rare_vocab | the beret |
| 0.39 | 0.39 | 0.95 | 0.56 | vocab_word_gesticulate | rare_vocab | gesticulate |
| 0.39 | 0.39 | 1.00 | 0.61 | vocab_word_swordfish | rare_vocab | the swordfish |
| 0.37 | 0.37 | 0.89 | 0.51 | vocab_word_rosette | rare_vocab | the rosette |
| 0.37 | 0.37 | 0.89 | 0.52 | vocab_word_percussion | rare_vocab | the percussion |
| 0.37 | 0.37 | 0.96 | 0.59 | vocab_word_mischievous | rare_vocab | mischievous |
| 0.37 | 0.37 | 0.88 | 0.51 | vocab_word_triad | rare_vocab | the triad |
| 0.37 | 0.37 | 0.92 | 0.56 | vocab_word_turnstile | rare_vocab | the turnstile |
| 0.37 | 0.37 | 0.88 | 0.51 | vocab_word_habit | rare_vocab | the habit |
| 0.36 | 0.36 | 0.92 | 0.56 | vocab_word_kimono | rare_vocab | the kimono |
| 0.35 | 0.35 | 0.96 | 0.61 | vocab_word_aloe | rare_vocab | the aloe |
| 0.34 | 0.34 | 1.00 | 0.66 | vocab_word_uniform | rare_vocab | the uniform |

## Prompt / input guidance
- Positive bias on rare words (VLM too easy) is adult lexical knowledge — calibration absorbs most; prompts only help for sense-ambiguity.
- If report marks TOOL-failure INCONCLUSIVE, recollect the panel before trusting residual tags.
