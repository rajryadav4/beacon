# Data pipeline

Turns the SPD crime CSV into the CrimeRadar map data and risk model.
Run every step from the repository root. Tested with Python 3.13, pandas 2.2, scikit-learn 1.6, scipy and joblib.

1. **Fetch** the last 4 years of offenses: `python pipeline/fetch_spd.py` -> `data/SPD_Crime_Data_Last4Yrs_150k.csv`.
2. **Train** the risk model: `python ml/train_risk_model.py` -> `ml/output/cell_risk.csv`, `metrics.json`, `model.joblib`.
   It prints test metrics for the model and two baselines (about 30 s). Details: `ml/MODEL_CARD.md`.
3. **Build** the web data: `python pipeline/build_ui_data.py` -> `CrimeRadar/src/main/webapp/assets/data/{meta,grid,neighborhoods,places}.json`.
   Without the step 2 output it uses a baseline risk (smoothed last-year counts). `--risk baseline` forces the baseline.
4. **Check** the files against `docs/API.md`: `python pipeline/check_ui_data.py`. It exits with 1 on any problem.

Files in this folder:

- `crime_data.py`: shared loading, cleaning, grid, time windows and metrics (used by steps 2 and 3).
- `category_groups.csv`: NIBRS offense description -> crime group. `exclude` rows are dropped everywhere.
- `places.csv`: landmarks for `places.json`. Coordinates were checked against OpenStreetMap (Nominatim) in November 2026.

Re-run steps 2 to 4 after every new fetch, so the model and the map use the same data.
