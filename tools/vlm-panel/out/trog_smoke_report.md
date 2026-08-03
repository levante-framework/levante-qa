# TROG smoke regression

- Status: **PASS**
- Items: 9 (missing EN: 0)
- Mean |p_pred_child − p_human|: 0.180 (max 0.35)

| item_uid | tags | |cal err| | p_vlm | p_human | p_pred | flag |
|---|---|---:|---:|---:|---:|---|
| trog_xnoty_horse_not_boy_stand | negation | 0.05 | 0.69 | 0.75 | 0.70 | HARD |
| trog_neither_pencil_long_nor_red | negation+adjective | 0.10 | 0.94 | 0.74 | 0.84 | OK |
| trog_inon_fork_on_shoe | spatial | 0.01 | 1.00 | 0.92 | 0.91 | CEILING |
| trog_preploc_plane_gray_above_cloud | spatial+relative_clause | 0.01 | 0.75 | 0.82 | 0.81 | HARD |
| trog_relclause_square_in_star_that_blue | spatial+adjective | 0.19 | 1.00 | 0.72 | 0.91 | CEILING |
| trog_embedding_circle_star_in_red | relative_clause+spatial | 0.26 | 1.00 | 0.65 | 0.91 | CEILING |
| trog_embedding_boy_dog_chase_big | relative_clause+reverse_agent | 0.46 | 0.69 | 0.24 | 0.70 | HARD |
| trog_embedding_cat_cow_chase_black | relative_clause | 0.47 | 0.69 | 0.24 | 0.70 | HARD |
| trog_disjunctive_he_wear_despite_size | disjunctive | 0.09 | 0.75 | 0.72 | 0.81 | HARD |
