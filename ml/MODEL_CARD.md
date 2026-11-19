# CrimeRadar risk model: model card

## Purpose

CrimeRadar shows how much crime to expect in a part of Seattle at a time of day.
The heatmap and the route scores use one number per grid cell and time band.
This model makes that number.

The number is the expected severity-weighted incidents in the next 12 months,
in one grid cell (about 223 m x 225 m), during one 6-hour band.
See `docs/API.md`, section 1.

It is a decision aid. It is not a guarantee of safety or of danger.

## Data

- Source: Seattle Police Department, "SPD Crime Data: 2008-Present" (dataset `tazs-3rd5`).
- Offense dates: 2022-11-19 to 2026-11-17 (4 years). 319,031 rows.
- We remove 2 duplicate rows (same Report Number and Offense ID).
- We remove 33,212 rows that are not crimes ("Not Reportable to NIBRS", "Justifiable Homicide").
- 285,817 offenses remain. 245,920 of them (86%) have a location inside the map grid.
- Time: `Offense Date`, Seattle local time. Band = hour / 6, rounded down.
- 24,641 offenses (8.6%) have a time of exactly 12:00:00 AM. Their time of day is unknown.
  We leave them out of the model (features and targets) and out of every time-of-day count.
  See "Unknown time of day" below.
- The model uses the 224,730 offenses that have a known time and a location in the grid.
- Each offense counts with its group's severity: robbery 4, assault and violence 3,
  burglary 1.5, drugs/weapons/disorder 1.5, theft 1, vehicle crime 1, vandalism 1, other 0.25.

## Target, windows and test design

Four 12-month windows end on the last day of data:

| Window | Dates | Severity-weighted located incidents (known time) |
|---|---|---|
| W1 | 2022-11-19 to 2023-11-17 | 79,148 |
| W2 | 2023-11-18 to 2024-11-17 | 78,518 |
| W3 | 2024-11-18 to 2025-11-17 | 70,954 |
| W4 | 2025-11-18 to 2026-11-17 | 64,550 |

- Train: features from W1 + W2, target W3.
- Test: features from W2 + W3, target W4.
- Shipped model: retrained on both pairs. It predicts the next 12 months from W3 + W4.
- No feature uses the target window. The neighborhood of a cell also comes from the feature windows only.
- Rows: the 4,192 cells with at least one located offense with a known time, times 4 bands.
  That is 16,768 cell-bands per window. These are the cells in `grid.json`.

## Features

23 features per cell-band. All are simple counts or ratios.

| Feature | Meaning |
|---|---|
| `sev_last`, `sev_prev` | Severity-weighted count in the cell-band, last window and the window before |
| `sev_mean2` | Mean of those two windows |
| `grp_violent` ... `grp_other` | Count of each of the 8 crime groups in the cell-band, both windows |
| `sm3_mean2`, `sm5_mean2` | Mean over the 3x3 (about 670 m) and 5x5 (about 1.1 km) block of cells |
| `sm3_last` | 3x3 block mean, last window only |
| `cell_total_mean2` | The cell's total over all 4 bands (two-window mean) |
| `nb_rate` | Mean per-cell rate of the cell's neighborhood in this band |
| `band_night` ... `band_evening` | Band one-hot (1 for the row's band) |
| `lat`, `lng` | Cell center |
| `trend` | (cell total last window + 1) / (cell total window before + 1) |

## Model

- `HistGradientBoostingRegressor` (scikit-learn 1.6.1) with Poisson loss.
- 300 trees, learning rate 0.05, up to 31 leaves, at least 40 rows per leaf, L2 = 1.0, `random_state` 42.
- We fixed these settings before the test. We did not tune them on the test window.
- Training takes about 2 seconds. The whole script takes about 30 seconds.

## Results on the test window (W4)

16,768 cell-bands. Actual total: 64,550 severity-weighted incidents.

| Method | Poisson deviance (lower is better) | MAE | Spearman | hotspotCapture10 | Predicted total |
|---|---|---|---|---|---|
| **Model (shipped)** | **2.190** | **2.04** | **0.698** | **0.634** | 66,957 |
| Baseline: mean of the last two years | 3.610 | 2.33 | 0.643 | 0.630 | 74,736 |
| Baseline: last-year counts | 5.814 | 2.38 | 0.597 | 0.618 | 70,954 |
| First map version (v0): smoothed last-year counts | 2.938 | 2.39 | 0.636 | 0.618 | 69,738 |

How to read the table:

- Poisson deviance: how well the predicted counts fit. Predictions are clipped to at least 0.001.
  The baselines predict 0 for cells with no recent crime. They get a large penalty when crime then happens there.
- MAE: mean absolute error, in severity-weighted incidents per cell-band per year.
- Spearman: rank correlation between predicted and actual values. 1 means a perfect order.
- hotspotCapture10: share of the test year's severity-weighted incidents that fall in the 10% of
  cell-bands that the method ranks highest. Ties at the cut get partial credit.

Verdict:

- We set the rule before the run: ship the model only if it beats the best baseline
  on at least 2 of 3 headline metrics (deviance, Spearman, hotspotCapture10).
- The best baseline is the mean of the last two years.
- The model beats it on all four metrics. So the shipped risk is the model.
- The gain is large for deviance (39% lower) and for rank order (+0.055 Spearman).
- The gain for hotspot capture is small (+0.005). Past counts alone already find the top hotspots.
- The model also predicts the total better. Crime fell from year to year, and the model learned that.

## What the model relies on

Permutation importance: how much the test deviance grows when we shuffle one feature.

1. `cell_total_mean2` (+6.12): how busy the cell is over the whole day.
2. `sev_mean2` (+2.15): the cell-band's own two-year mean.
3. `sm3_mean2`, `lat`, `trend`, `sm3_last` (+0.04 to +0.06 each).

All other features add very little.
So the model mostly smooths past counts in a smart way.
It borrows strength from the cell's other bands and from nearby cells.

## How levels are set

- One global set of thresholds for all 4 bands (see `docs/API.md`): `LOW < q90 <= ELEVATED < q97 <= HIGH`.
- Low: risk below q90 = 7.16. Elevated: from 7.16. High: from q97 = 23.76.
- q90 and q97 are quantiles of all 16,768 cell-band risks in `grid.json` (rounded to 2 decimals).
- The thresholds were q75 and q90 until 2026-11-19. The risk is very skewed.
  With q90 as "high", almost all of downtown was high, so routes there could not be told apart.
- Result: low 90%, elevated 7%, high 3% of cell-bands.
- Share of cell-bands that are elevated or high: Night 9%, Morning 8%, Afternoon 11%, Evening 13%.
- `ml/output/cell_risk.csv` uses the same thresholds in its `level` column.

## Unknown time of day

- 24,641 offenses (8.6%) have an Offense Date time of exactly 12:00:00 AM.
  For most of them the real time is unknown. 12:00 AM is a placeholder.
- They would all fall in the Night band. With them, Night held 25.5% of offenses.
  Without them, Night holds 18.4% of the offenses with a known time.
- On the map, the mean Night risk per cell fell from 3.91 to 2.87 (27% lower).
  The other three bands barely changed.
- The rule (`docs/API.md` section 1): they are left out of every time-of-day count
  (`grid.json` and `neighborhoods.json` `counts`, `unlocated`) and out of the model.
- They still count in `meta.totals.incidents` and `meta.totals.located`.
  `meta.totals.unknownTime` gives their number.
- Groups hit most (offenses left out, and the share of that group):
  vehicle crime 7,572 (10.0%), other offenses 5,403 (15.4%), burglary 3,210 (8.3%),
  assault and violence 3,064 (6.8%), theft 2,807 (6.0%), vandalism 2,113 (7.8%),
  drugs/weapons/disorder 287 (2.7%), robbery 185 (3.0%).
- Effect: the risk counts only offenses with a known time. Severity-weighted, it is about 7% lower
  than with all reported offenses. For vehicle crime and other offenses, it is 10 to 15% lower.

## Limits

- **Redacted locations.** 14% of offenses have no usable location. They are not on the map.
  Violence is hit most: only 57% of violent offenses have a location.
  Rape (about 2%) and intimidation (26%) are almost all hidden.
  So the map shows too little violence, most of all sexual violence.
  Property crime is 84% to 99% located.
- **Reporting lag.** Offenses reach the open data about 5 to 6 days after the report.
  Also, 14% of offenses are reported more than 7 days after they happen, and 4% more than 30 days after.
  The newest months look low. September and October 2026 are 14% and 17% below the same months of 2025.
  1 to 17 November 2026 is about 36% below. January to August 2026 are within 6% of 2025.
  So W4 is probably about 4 to 5% too low. Levels use quantiles, so they barely change.
  The absolute numbers are a little too low.
- **Unknown times.** 8.6% of offenses are left out of the risk (see above).
  So the risk is a little low, most of all for vehicle crime and other offenses.
- **No foot-traffic normalization.** The risk counts incidents, not incidents per person.
  Busy places (downtown, shopping centers, transit hubs) look risky partly because many people are there.
  The risk for one visitor can be lower than the color suggests.
- **Reported crime only.** Some crime is never reported. Reporting rates differ between places and groups.
  Police activity also changes what is recorded, for example drug offenses.
- **Stigma.** A red area can push people away from a neighborhood, its residents and its businesses.
  Show the levels as trip-planning information, not as a label on a place or its people.
  Do not use this model for policing, insurance, housing, lending or hiring decisions.
- **Small numbers.** Most cells have only a few incidents a year.
  One or two events can move a quiet cell to another level.
- **Past only.** The model sees the last 2 years. It cannot see new events, construction or policy changes.
- **Cells with no located offense with a known time in 4 years** are not in `grid.json`.
  The app treats them as risk 0.
- W1 starts on 2022-11-19, one day short of 12 months.

This model is a decision aid. It is not a guarantee.

## Files

- `ml/train_risk_model.py`: trains, tests and writes the outputs below.
- `ml/output/cell_risk.csv`: `cell_id,band,expected_risk,level` (16,768 rows).
- `ml/output/metrics.json`: all metrics, feature importance, levels, and the `meta.model` block for `meta.json`.
- `ml/output/model.joblib`: the retrained model (git-ignored).

Rebuild: `python ml/train_risk_model.py`, then `python pipeline/build_ui_data.py`.
