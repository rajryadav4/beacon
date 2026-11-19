"""Train the CrimeRadar risk model.

Target: severity-weighted incidents in the next 12 months per (grid cell, 6-hour
band). This is the risk unit in docs/API.md, section 1.

Offenses with an unknown time of day (Offense Date time exactly 00:00:00) are
left out of all features and targets.

Windows W1..W4 are the four 12-month windows that end on the data's last day.
  Backtest: features from W1+W2 -> target W3 (train)
            features from W2+W3 -> target W4 (test)
  Final:    retrain on both pairs, predict the next 12 months from W3+W4.
No feature uses the target window.

Writes ml/output/cell_risk.csv, ml/output/metrics.json and ml/output/model.joblib.

Usage, from the repository root:

    python ml/train_risk_model.py
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
from pathlib import Path

# joblib counts physical cores with `wmic`, which newer Windows 11 builds no longer have,
# and then prints a long warning. A cap below the logical core count skips that probe.
os.environ.setdefault("LOKY_MAX_CPU_COUNT", str(max(1, (os.cpu_count() or 2) // 2)))

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.inspection import permutation_importance

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))
import crime_data as cd  # noqa: E402

RANDOM_STATE = 42
MODEL_PARAMS = {
    "loss": "poisson",
    "learning_rate": 0.05,
    "max_iter": 300,
    "max_leaf_nodes": 31,
    "min_samples_leaf": 40,
    "l2_regularization": 1.0,
    "early_stopping": False,
    "random_state": RANDOM_STATE,
}
ALGORITHM = "HistGradientBoostingRegressor (Poisson loss)"

FEATURES = (
    ["sev_last", "sev_prev", "sev_mean2"]
    + [f"grp_{g['key']}" for g in cd.GROUPS]
    + ["sm3_mean2", "sm5_mean2", "sm3_last", "cell_total_mean2", "nb_rate"]
    + [f"band_{b['key']}" for b in cd.BANDS]
    + ["lat", "lng", "trend"]
)
FEATURE_HELP = {
    "sev_last": "severity-weighted count in the cell-band, last window",
    "sev_prev": "severity-weighted count in the cell-band, window before",
    "sev_mean2": "mean of the two windows",
    **{f"grp_{g['key']}": f"{g['label']} count in the cell-band, both windows" for g in cd.GROUPS},
    "sm3_mean2": "3x3 block mean (about 670 m square), two-window mean",
    "sm5_mean2": "5x5 block mean (about 1.1 km square), two-window mean",
    "sm3_last": "3x3 block mean, last window",
    "cell_total_mean2": "cell total over all 4 bands, two-window mean",
    "nb_rate": "mean per-cell rate of the cell's neighborhood in the band",
    **{f"band_{b['key']}": f"1 if the band is {b['label']}" for b in cd.BANDS},
    "lat": "cell center latitude",
    "lng": "cell center longitude",
    "trend": "(cell total last window + 1) / (cell total window before + 1)",
}
BASELINES = {
    "lastYear": "last-year counts",
    "meanTwoYears": "mean of the last two years",
}


# ---- Features ------------------------------------------------------------------------
def window_grids(frame: pd.DataFrame, wins) -> tuple[np.ndarray, np.ndarray]:
    """Severity sums (W, 4, R, C) and group counts (W, 8, 4, R, C) per window."""
    parts = [cd.in_window(frame, w) for w in wins]
    sev = np.stack([cd.band_grid(p) for p in parts])
    grp = np.stack([cd.group_band_grid(p) for p in parts])
    return sev, grp


def at_active(grid: np.ndarray, active: np.ndarray) -> np.ndarray:
    """(..., R, C) -> (..., n_active)."""
    return grid.reshape(grid.shape[:-2] + (-1,))[..., active]


def by_cell_band(values: np.ndarray) -> np.ndarray:
    """(4 bands, n) -> (n * 4,), rows ordered by cell, then band."""
    return values.T.reshape(-1)


def make_features(frame, wins, sev, grp, prev: int, last: int, active: np.ndarray) -> pd.DataFrame:
    """Features from windows `prev` and `last` (consecutive) for every active cell-band."""
    n = len(active)
    s_last, s_prev = sev[last], sev[prev]
    mean2 = (s_last + s_prev) / 2.0
    tot_last = at_active(s_last.sum(0), active)
    tot_prev = at_active(s_prev.sum(0), active)
    groups2 = at_active(grp[prev] + grp[last], active)            # (8, 4, n)

    # Neighborhood of each cell, from the two feature windows only (no target leakage).
    feature_rows = frame[(frame["when"] >= wins[prev][0]) & (frame["when"] < wins[last][1])]
    dominant = cd.dominant_neighborhood(feature_rows)
    keys = {key: i for i, key in enumerate(sorted(dominant.unique()))}
    nb = np.array([keys[dominant[f]] if f in dominant.index else -1 for f in active.tolist()])
    has_nb = nb >= 0
    mean2_active = at_active(mean2, active)                        # (4, n)
    nb_rate = np.full((cd.N_BANDS, n), np.nan)
    cells_per_nb = np.bincount(nb[has_nb], minlength=len(keys))
    for band in range(cd.N_BANDS):
        sums = np.bincount(nb[has_nb], weights=mean2_active[band, has_nb], minlength=len(keys))
        nb_rate[band, has_nb] = (sums / np.maximum(cells_per_nb, 1))[nb[has_nb]]

    lat, lng = cd.cell_centers(active)
    columns = {
        "sev_last": by_cell_band(at_active(s_last, active)),
        "sev_prev": by_cell_band(at_active(s_prev, active)),
        "sev_mean2": by_cell_band(mean2_active),
        **{f"grp_{g['key']}": by_cell_band(groups2[g["id"]]) for g in cd.GROUPS},
        "sm3_mean2": by_cell_band(at_active(cd.box_mean(mean2, 3), active)),
        "sm5_mean2": by_cell_band(at_active(cd.box_mean(mean2, 5), active)),
        "sm3_last": by_cell_band(at_active(cd.box_mean(s_last, 3), active)),
        "cell_total_mean2": np.repeat((tot_last + tot_prev) / 2.0, cd.N_BANDS),
        "nb_rate": by_cell_band(nb_rate),
        **{f"band_{b['key']}": np.tile(np.eye(cd.N_BANDS)[b["id"]], n) for b in cd.BANDS},
        "lat": np.repeat(lat, cd.N_BANDS),
        "lng": np.repeat(lng, cd.N_BANDS),
        "trend": np.repeat((tot_last + 1.0) / (tot_prev + 1.0), cd.N_BANDS),
    }
    return pd.DataFrame(columns)[FEATURES]


def target(sev: np.ndarray, window: int, active: np.ndarray) -> np.ndarray:
    return by_cell_band(at_active(sev[window], active))


# ---- Reporting -----------------------------------------------------------------------
def print_table(results: dict[str, dict]) -> None:
    header = f"{'method':<28}{'poissonDev':>11}{'MAE':>8}{'spearman':>10}{'hotspot10':>11}"
    print(header)
    print("-" * len(header))
    for name, m in results.items():
        print(f"{name:<28}{m['poissonDeviance']:>11.4f}{m['mae']:>8.3f}{m['spearman']:>10.4f}"
              f"{m['hotspotCapture10']:>11.4f}")


def headline(m: dict) -> dict:
    return {key: m[key] for key in ("hotspotCapture10", "spearman", "poissonDeviance")}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", type=Path, default=cd.DATA_CSV, help="SPD crime CSV")
    parser.add_argument("--out", type=Path, default=cd.ML_OUTPUT_DIR, help="output folder")
    args = parser.parse_args(argv)
    started = time.time()

    incidents = cd.load_incidents(args.data)
    # Offenses with an unknown time of day (00:00:00) cannot go into a band:
    # they are left out of all features and targets (docs/API.md section 1).
    frame = cd.timed(incidents.frame)
    first_day, last_day = incidents.first_day, incidents.last_day
    wins = cd.windows(last_day)
    labels = [cd.window_label(w, first_day) for w in wins]
    active = cd.active_cells(frame)
    print(f"Data {first_day.date()} to {last_day.date()}: {len(incidents.frame):,} incidents, "
          f"{incidents.unknown_time:,} with unknown time left out, {len(frame):,} used, "
          f"{int(frame['located'].sum()):,} located, {len(active):,} cells with incidents")
    for i, label in enumerate(labels):
        part = cd.in_window(frame, wins[i])
        print(f"  W{i + 1}: {label}  {len(part):,} incidents, "
              f"severity-weighted located {part.loc[part['located'], 'severity'].sum():,.0f}")

    sev, grp = window_grids(frame, wins)
    x_train, y_train = make_features(frame, wins, sev, grp, 0, 1, active), target(sev, 2, active)
    x_test, y_test = make_features(frame, wins, sev, grp, 1, 2, active), target(sev, 3, active)

    t0 = time.time()
    backtest = HistGradientBoostingRegressor(**MODEL_PARAMS).fit(x_train, y_train)
    train_seconds = time.time() - t0
    predictions = {
        "model": backtest.predict(x_test),
        "lastYear": x_test["sev_last"].to_numpy(),
        "meanTwoYears": x_test["sev_mean2"].to_numpy(),
    }
    results = {name: cd.risk_metrics(y_test, p) for name, p in predictions.items()}
    for name, p in predictions.items():
        results[name]["totalPredicted"] = round(float(p.sum()), 1)

    print(f"\nTest: features {labels[1]} + {labels[2]} -> target {labels[3]} "
          f"({len(y_test):,} cell-bands, total {y_test.sum():,.0f})")
    print_table({"model (HGB Poisson)": results["model"],
                 "baseline: last-year counts": results["lastYear"],
                 "baseline: mean of 2 years": results["meanTwoYears"]})

    # Best baseline = lower Poisson deviance. The model ships if it wins on at least
    # 2 of the 3 headline metrics against that baseline.
    best = min(BASELINES, key=lambda k: (results[k]["poissonDeviance"], -results[k]["spearman"]))
    m, b = results["model"], results[best]
    wins_count = (int(m["poissonDeviance"] < b["poissonDeviance"]) + int(m["spearman"] > b["spearman"])
                  + int(m["hotspotCapture10"] > b["hotspotCapture10"]))
    shipped = "model" if wins_count >= 2 else best
    print(f"\nBest baseline: {BASELINES[best]}. Model wins {wins_count}/3 headline metrics. "
          f"Shipped risk: {'model' if shipped == 'model' else BASELINES[shipped]}.")

    importance = permutation_importance(backtest, x_test, y_test, scoring="neg_mean_poisson_deviance",
                                        n_repeats=3, random_state=RANDOM_STATE)
    ranked = sorted(zip(FEATURES, importance.importances_mean), key=lambda t: -t[1])

    # Final: retrain on both pairs, predict the next 12 months from W3 + W4.
    x_next = make_features(frame, wins, sev, grp, 2, 3, active)
    final = HistGradientBoostingRegressor(**MODEL_PARAMS).fit(
        pd.concat([x_train, x_test], ignore_index=True), np.concatenate([y_train, y_test]))
    if shipped == "model":
        expected = final.predict(x_next)
    elif shipped == "lastYear":
        expected = x_next["sev_last"].to_numpy()
    else:
        expected = x_next["sev_mean2"].to_numpy()
    expected = np.round(expected, 2)

    quantiles = cd.risk_quantiles(expected)
    thresholds = cd.risk_levels(quantiles)          # {"elevated": q90, "high": q97}
    elevated, high = thresholds["elevated"], thresholds["high"]
    cell_ids = np.repeat(cd.cell_id_from_flat(active), cd.N_BANDS)
    bands = np.tile(np.arange(cd.N_BANDS), len(active))
    levels = [cd.risk_level(v, elevated, high) for v in expected.tolist()]

    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    pd.DataFrame({"cell_id": cell_ids, "band": bands, "expected_risk": expected, "level": levels}) \
        .to_csv(out / "cell_risk.csv", index=False, float_format="%.2f", lineterminator="\n")

    today = dt.date.today().isoformat()
    trained_on = (f"{first_day.date()} to {(wins[2][1] - pd.Timedelta(days=1)).date()}, "
                  f"tested on {labels[3]}")
    if shipped == "model":
        meta_model = {
            "version": f"risk-{today}",
            "algorithm": ALGORITHM,
            "trainedOn": trained_on + f" (shipped model refit on {first_day.date()} to {last_day.date()})",
            "metrics": headline(results["model"]),
            "baseline": {"name": BASELINES[best], **headline(results[best])},
        }
    else:
        other = next(k for k in BASELINES if k != shipped)
        meta_model = {
            "version": f"risk-{today}",
            "algorithm": f"{BASELINES[shipped]} (baseline; the ML model did not beat it)",
            "trainedOn": f"no training: counts from {labels[2]} and {labels[3]}; tested on {labels[3]}",
            "metrics": headline(results[shipped]),
            "baseline": {"name": BASELINES[other], **headline(results[other])},
        }

    metrics = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "dataRange": {"from": str(first_day.date()), "to": str(last_day.date())},
        "windows": {f"W{i + 1}": label for i, label in enumerate(labels)},
        "train": {"features": f"{labels[0]} + {labels[1]}", "target": labels[2], "rows": len(y_train)},
        "test": {"features": f"{labels[1]} + {labels[2]}", "target": labels[3], "rows": len(y_test),
                 "totalActual": round(float(y_test.sum()), 1)},
        "cells": int(len(active)),
        "unknownTimeLeftOut": incidents.unknown_time,
        "results": {"model": results["model"],
                    **{name: {"name": BASELINES[name], **results[name]} for name in BASELINES}},
        "bestBaseline": best,
        "modelWins": wins_count,
        "shipped": shipped,
        "params": {k: v for k, v in MODEL_PARAMS.items()},
        "trainSeconds": round(train_seconds, 2),
        "featureImportance": [{"feature": f, "devianceIncrease": round(float(v), 4)} for f, v in ranked],
        "quantiles": quantiles,
        "levels": thresholds,
        "levelQuantiles": cd.LEVEL_QUANTILES,
        "levelShares": {lvl: round(levels.count(lvl) / len(levels), 4) for lvl in ("low", "elevated", "high")},
        "nextYearTotal": round(float(expected.sum()), 1),
        "metaModel": meta_model,
    }
    # allow_nan=False: the backend stores this file in a MySQL JSON column, which rejects NaN.
    (out / "metrics.json").write_text(json.dumps(metrics, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    joblib.dump({"model": final, "features": FEATURES, "featureHelp": FEATURE_HELP,
                 "params": MODEL_PARAMS, "windows": labels, "shipped": shipped}, out / "model.joblib")

    print("\nTop features (test deviance increase when shuffled):")
    for feature, value in ranked[:8]:
        print(f"  {feature:<18}{value:>8.4f}  {FEATURE_HELP[feature]}")
    print(f"\nLevels: elevated >= {elevated}, high >= {high} (global "
          f"{cd.LEVEL_QUANTILES['elevated']} / {cd.LEVEL_QUANTILES['high']} of {len(expected):,} cell-bands)")
    print(f"Wrote {out / 'cell_risk.csv'}, {out / 'metrics.json'}, {out / 'model.joblib'}")
    print(f"Train time {train_seconds:.1f}s, total {time.time() - started:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
