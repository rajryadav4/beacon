"""Build the static map data for the CrimeRadar web app.

Writes CrimeRadar/src/main/webapp/assets/data/{meta,grid,neighborhoods,places}.json
in the shapes defined by docs/API.md, section 2.

Risk per cell and band comes from the ML model output (ml/output/cell_risk.csv
and ml/output/metrics.json, made by ml/train_risk_model.py). When that output is
missing, a simple baseline is used: last-12-months severity-weighted counts,
smoothed with the 3x3 neighbor cells.

Offenses with an Offense Date time of exactly 00:00:00 have an unknown time of
day. They count in meta.totals (incidents, located, unknownTime) but not in any
time-of-day count, cell or neighborhood statistic, or risk.

Usage, from the repository root:

    python pipeline/build_ui_data.py
    python pipeline/build_ui_data.py --risk baseline      # ignore the model output
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import crime_data as cd  # noqa: E402


# ---- Risk sources ----------------------------------------------------------------
def baseline_risk(incidents: cd.Incidents, active: np.ndarray) -> tuple[np.ndarray, dict]:
    """v0 risk: smoothed severity-weighted counts of the last 12 months.

    Returns risk (len(active), 4) and the meta.model block, with backtest metrics
    (the same recipe on the window before, scored on the last 12 months).
    Offenses with an unknown time of day are left out, as in the model.
    """
    frame = cd.timed(incidents.frame)
    w = cd.windows(incidents.last_day)
    last = cd.band_grid(cd.in_window(frame, w[3]))          # W4
    before = cd.band_grid(cd.in_window(frame, w[2]))        # W3

    def at_active(grid: np.ndarray) -> np.ndarray:   # (4, R, C) -> (len(active), 4)
        return grid.reshape(cd.N_BANDS, -1)[:, active].T

    risk = at_active(cd.smoothed_counts(last))
    y_test = at_active(last).ravel()
    smoothed_metrics = cd.risk_metrics(y_test, at_active(cd.smoothed_counts(before)).ravel())
    last_year_metrics = cd.risk_metrics(y_test, at_active(before).ravel())
    model = {
        "version": f"baseline-{dt.date.today().isoformat()}",
        "algorithm": "Smoothed last-year counts (baseline, no ML): 0.5 x cell + 0.5 x 3x3 block mean",
        "trainedOn": (f"no training: counts from {cd.window_label(w[3])}; "
                      f"tested by predicting {cd.window_label(w[3])} from {cd.window_label(w[2])}"),
        "metrics": headline(smoothed_metrics),
        "baseline": {"name": "last-year counts", **headline(last_year_metrics)},
    }
    return risk, model


def headline(metrics: dict) -> dict:
    return {key: metrics[key] for key in ("hotspotCapture10", "spearman", "poissonDeviance")}


def model_risk(active: np.ndarray, risk_csv: Path, metrics_json: Path, last_day: pd.Timestamp):
    """Read the ML output. Returns (risk (len(active), 4), meta.model) or None."""
    if not (risk_csv.exists() and metrics_json.exists()):
        return None
    metrics = json.loads(metrics_json.read_text(encoding="utf-8"))
    table = pd.read_csv(risk_csv)
    expected = ["cell_id", "band", "expected_risk", "level"]
    if list(table.columns) != expected:
        print(f"WARNING: {risk_csv} has columns {list(table.columns)}, expected {expected}; "
              "using the baseline", file=sys.stderr)
        return None
    trained_to = metrics.get("dataRange", {}).get("to")
    if trained_to != str(last_day.date()):
        print(f"WARNING: the model was trained on data up to {trained_to}, but the CSV ends on "
              f"{last_day.date()}. Re-run ml/train_risk_model.py.", file=sys.stderr)

    position = {flat: i for i, flat in enumerate(active.tolist())}
    risk = np.zeros((len(active), cd.N_BANDS))
    seen = np.zeros((len(active), cd.N_BANDS), dtype=bool)
    flats = cd.flat_from_cell_id(table["cell_id"].to_numpy())
    extra = 0
    for flat, band, value in zip(flats.tolist(), table["band"].tolist(), table["expected_risk"].tolist()):
        i = position.get(flat)
        if i is None:
            extra += 1
            continue
        risk[i, band] = value
        seen[i, band] = True
    if extra:
        print(f"WARNING: {extra} model rows are for cells without located incidents; ignored",
              file=sys.stderr)
    missing = int((~seen).sum())
    if missing:
        print(f"WARNING: {missing} cell-bands have no model risk; they get 0", file=sys.stderr)
    return risk, metrics["metaModel"]


# ---- Grid and neighborhoods -------------------------------------------------------
def cell_counts(frame: pd.DataFrame) -> np.ndarray:
    """(N_FLAT, 32) counts of located incidents, index = band * 8 + groupId."""
    loc = frame[frame["located"]]
    slot = loc["band"].to_numpy(np.int64) * cd.N_GROUPS + loc["group"].to_numpy(np.int64)
    index = loc["flat"].to_numpy(np.int64) * cd.N_COUNTS + slot
    return np.bincount(index, minlength=cd.N_FLAT * cd.N_COUNTS).reshape(cd.N_FLAT, cd.N_COUNTS)


def build_neighborhoods(frame: pd.DataFrame, active: np.ndarray):
    """Returns (neighborhood list for the JSON, nbIndex per active cell).

    `frame` holds all offenses. Counts, unlocated, centers and cell dominance use only
    offenses with a known time of day (as sql/app_tables.sql does); the precinct uses all.
    """
    valid_all = frame[~frame["neighborhood"].isin(cd.DROPPED_NEIGHBORHOODS)]
    keys = sorted(valid_all["neighborhood"].unique(), key=lambda k: cd.name_sort_key(cd.display_name(k)))
    index_of = {key: i for i, key in enumerate(keys)}
    valid = cd.timed(valid_all)

    dominant = cd.dominant_neighborhood(cd.timed(frame))
    nb_index = np.array([index_of[dominant[f]] if f in dominant.index else -1 for f in active.tolist()],
                        dtype=int)
    cells_per_nb = np.bincount(nb_index[nb_index >= 0], minlength=len(keys))

    slot = valid["band"].to_numpy(np.int64) * cd.N_GROUPS + valid["group"].to_numpy(np.int64)
    nb_pos = valid["neighborhood"].map(index_of).to_numpy(np.int64)
    counts = np.bincount(nb_pos * cd.N_COUNTS + slot,
                         minlength=len(keys) * cd.N_COUNTS).reshape(len(keys), cd.N_COUNTS)
    unlocated = np.bincount(nb_pos[~valid["located"].to_numpy()], minlength=len(keys))

    located = valid[valid["located"]]
    centers = located.groupby("neighborhood")[["lat", "lng"]].mean()
    precincts = (valid_all[~valid_all["precinct"].isin(cd.DROPPED_PRECINCTS)]
                 .groupby("neighborhood")["precinct"]
                 .agg(lambda s: s.value_counts().index[0] if len(s) else ""))

    rows = []
    for i, key in enumerate(keys):
        has_center = key in centers.index
        rows.append({
            "key": key,
            "name": cd.display_name(key),
            "precinct": str(precincts.get(key, "")),
            "lat": round(float(centers.at[key, "lat"]), 5) if has_center else None,
            "lng": round(float(centers.at[key, "lng"]), 5) if has_center else None,
            "cells": int(cells_per_nb[i]),
            "areaKm2": round(float(cells_per_nb[i]) * cd.CELL_AREA_KM2, 2),
            "counts": counts[i].tolist(),
            "unlocated": int(unlocated[i]),
        })
    return rows, nb_index


# ---- Main ------------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", type=Path, default=cd.DATA_CSV, help="SPD crime CSV")
    parser.add_argument("--out", type=Path, default=cd.WEB_DATA_DIR, help="output folder")
    parser.add_argument("--risk", choices=["auto", "baseline"], default="auto",
                        help="auto = model output when present, else baseline (default)")
    args = parser.parse_args(argv)
    started = time.time()

    incidents = cd.load_incidents(args.data)
    frame = incidents.frame
    first_day, last_day = incidents.first_day, incidents.last_day
    print(f"Read {incidents.rows_read:,} rows: {incidents.duplicates} duplicates, "
          f"{incidents.excluded:,} excluded, {incidents.bad_dates} bad dates, "
          f"{len(frame):,} incidents, {int(frame['located'].sum()):,} located, "
          f"{incidents.unknown_time:,} with unknown time (left out of time-of-day counts)")

    timed = cd.timed(frame)
    counts = cell_counts(timed)
    active = cd.active_cells(timed)
    neighborhoods, nb_index = build_neighborhoods(frame, active)

    source = None if args.risk == "baseline" else model_risk(
        active, cd.ML_OUTPUT_DIR / "cell_risk.csv", cd.ML_OUTPUT_DIR / "metrics.json", last_day)
    if source is None:
        risk, model = baseline_risk(incidents, active)
        print("Risk source: v0 baseline (smoothed last-year counts)")
    else:
        risk, model = source
        print(f"Risk source: {cd.ML_OUTPUT_DIR / 'cell_risk.csv'} ({model['algorithm']})")
    risk = np.round(risk, 2)

    quantiles = cd.risk_quantiles(risk.ravel())
    cell_ids = cd.cell_id_from_flat(active)
    cells = [[int(cell_ids[i]), int(nb_index[i]), counts[flat].tolist(), [float(v) for v in risk[i]]]
             for i, flat in enumerate(active.tolist())]

    years = round((last_day - first_day).days / 365.25, 2)
    meta = {
        "version": 1,
        "generatedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": cd.SOURCE,
        "dataRange": {"from": str(first_day.date()), "to": str(last_day.date()), "years": years},
        "totals": {"incidents": int(len(frame)), "located": int(frame["located"].sum()),
                   "excluded": incidents.excluded, "unknownTime": incidents.unknown_time},
        "grid": cd.GRID,
        "bands": cd.BANDS,
        "groups": cd.GROUPS,
        "modes": cd.MODES,
        "risk": {
            "unit": cd.RISK_UNIT,
            "quantiles": quantiles,
            "levels": cd.risk_levels(quantiles),
        },
        "model": model,
    }

    with cd.PLACES_CSV.open(newline="", encoding="utf-8") as handle:
        places = [{"name": row["name"], "category": row["category"],
                   "lat": round(float(row["lat"]), 5), "lng": round(float(row["lng"]), 5)}
                  for row in csv.DictReader(handle)]

    out = args.out
    sizes = {
        "meta.json": cd.write_json(out / "meta.json", meta),
        "grid.json": cd.write_json(out / "grid.json", {"version": 1, "cells": cells}),
        "neighborhoods.json": cd.write_json(out / "neighborhoods.json",
                                            {"version": 1, "neighborhoods": neighborhoods}),
        "places.json": cd.write_json(out / "places.json", {"places": places}),
    }
    for name, size in sizes.items():
        print(f"  wrote {out / name} ({size / 1024:,.1f} KB)")
    print(f"{len(cells):,} cells, {len(neighborhoods)} neighborhoods, {len(places)} places; "
          f"levels {cd.risk_levels(quantiles)}; {time.time() - started:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
