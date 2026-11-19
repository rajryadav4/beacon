"""Shared code for the CrimeRadar data pipeline and the risk model.

Used by pipeline/build_ui_data.py, pipeline/check_ui_data.py and
ml/train_risk_model.py. Every constant here follows docs/API.md, section 1.
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA_CSV = ROOT / "data" / "SPD_Crime_Data_Last4Yrs_150k.csv"
GROUPS_CSV = ROOT / "pipeline" / "category_groups.csv"
PLACES_CSV = ROOT / "pipeline" / "places.csv"
WEB_DATA_DIR = ROOT / "CrimeRadar" / "src" / "main" / "webapp" / "assets" / "data"
ML_OUTPUT_DIR = ROOT / "ml" / "output"

SOURCE = {
    "name": "SPD Crime Data: 2008-Present",
    "id": "tazs-3rd5",
    "url": "https://data.seattle.gov/d/tazs-3rd5",
}

# ---- Map grid -------------------------------------------------------------
GRID = {"lat0": 47.48, "lng0": -122.46, "dLat": 0.002, "dLng": 0.003, "rows": 135, "cols": 80}
ROWS, COLS = GRID["rows"], GRID["cols"]
N_FLAT = ROWS * COLS          # flat index = row * COLS + col (internal only)
CELL_AREA_KM2 = 0.0501

# ---- Time bands, crime groups, travel modes -------------------------------
BANDS = [
    {"id": 0, "key": "night", "label": "Night", "hours": "12 AM - 6 AM"},
    {"id": 1, "key": "morning", "label": "Morning", "hours": "6 AM - 12 PM"},
    {"id": 2, "key": "afternoon", "label": "Afternoon", "hours": "12 PM - 6 PM"},
    {"id": 3, "key": "evening", "label": "Evening", "hours": "6 PM - 12 AM"},
]
GROUPS = [
    {"id": 0, "key": "violent", "label": "Assault & violence", "severity": 3.0},
    {"id": 1, "key": "robbery", "label": "Robbery", "severity": 4.0},
    {"id": 2, "key": "theft", "label": "Theft", "severity": 1.0},
    {"id": 3, "key": "vehicle", "label": "Vehicle crime", "severity": 1.0},
    {"id": 4, "key": "burglary", "label": "Burglary & trespass", "severity": 1.5},
    {"id": 5, "key": "vandalism", "label": "Vandalism & arson", "severity": 1.0},
    {"id": 6, "key": "drugs", "label": "Drugs, weapons & disorder", "severity": 1.5},
    {"id": 7, "key": "other", "label": "Other offenses", "severity": 0.25},
]
MODES = {
    "walk": {"label": "Walk", "vulnerability": 1.0},
    "bike": {"label": "Bike", "vulnerability": 0.7},
    "car": {"label": "Car", "vulnerability": 0.3},
}
N_BANDS, N_GROUPS = len(BANDS), len(GROUPS)
N_COUNTS = N_BANDS * N_GROUPS  # 32, index = band * 8 + groupId
GROUP_IDS = {g["key"]: g["id"] for g in GROUPS}
SEVERITY = np.array([g["severity"] for g in GROUPS], dtype=float)
EXCLUDE_KEY = "exclude"

RISK_UNIT = "expected severity-weighted incidents per year in the cell during the band"
QUANTILE_KEYS = {"q50": 0.50, "q75": 0.75, "q90": 0.90, "q97": 0.97, "q99": 0.99}
# Level thresholds, docs/API.md section 1: LOW < q90 <= ELEVATED < q97 <= HIGH
# (changed from q75 / q90 on 2026-11-19: the risk is very skewed).
LEVEL_QUANTILES = {"elevated": "q90", "high": "q97"}

# ---- Neighborhoods ---------------------------------------------------------
DROPPED_NEIGHBORHOODS = frozenset({"", "-", "UNKNOWN", "OOJ", "FK ERROR"})
DROPPED_PRECINCTS = frozenset({"", "-", "OOJ", "UNKNOWN"})
NAME_FIXES = {
    "SLU/CASCADE": "South Lake Union / Cascade",
    "LAKECITY": "Lake City",
    "BITTERLAKE": "Bitter Lake",
    "SANDPOINT": "Sand Point",
    "DOWNTOWN COMMERCIAL": "Downtown",
    "CHINATOWN/INTERNATIONAL DISTRICT": "Chinatown-International District",
    "UNIVERSITY": "University District",
    "SODO": "SODO",
    "COMMERCIAL DUWAMISH": "Duwamish (Industrial)",
    "COMMERCIAL HARBOR ISLAND": "Harbor Island",
    "FAUNTLEROY SW": "Fauntleroy",
    "NEW HOLLY": "NewHolly",
    "EASTLAKE - EAST": "Eastlake East",
    "EASTLAKE - WEST": "Eastlake West",
    "MORGAN": "Morgan Junction",
}

DATE_FORMAT = "%Y %b %d %I:%M:%S %p"   # e.g. "2026 Mar 07 12:00:00 AM", Seattle local time


def display_name(key: str) -> str:
    """SPD neighborhood key -> display name ("ROOSEVELT/RAVENNA" -> "Roosevelt / Ravenna")."""
    if key in NAME_FIXES:
        return NAME_FIXES[key]
    return " / ".join(part.strip().title() for part in key.split("/"))


def name_sort_key(name: str) -> str:
    return name.casefold()


def cell_id_from_flat(flat: np.ndarray | int):
    """Internal flat index (row * 80 + col) -> contract cellId (row * 100 + col)."""
    row, col = np.divmod(flat, COLS)
    return row * 100 + col


def flat_from_cell_id(cell_id: np.ndarray | int):
    row, col = np.divmod(cell_id, 100)
    return row * COLS + col


def cell_centers(flat: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    row, col = np.divmod(np.asarray(flat), COLS)
    lat = GRID["lat0"] + (row + 0.5) * GRID["dLat"]
    lng = GRID["lng0"] + (col + 0.5) * GRID["dLng"]
    return lat, lng


# ---- Loading ----------------------------------------------------------------
@dataclass
class Incidents:
    frame: pd.DataFrame   # one row per kept offense (deduplicated, `exclude` removed)
    rows_read: int
    duplicates: int
    excluded: int
    bad_dates: int

    @property
    def first_day(self) -> pd.Timestamp:
        return self.frame["when"].min().normalize()

    @property
    def last_day(self) -> pd.Timestamp:
        return self.frame["when"].max().normalize()

    @property
    def unknown_time(self) -> int:
        return int((~self.frame["known_time"]).sum())


def timed(frame: pd.DataFrame) -> pd.DataFrame:
    """Offenses with a known time of day.

    An Offense Date time of exactly 00:00:00 means the time of day is unknown
    (docs/API.md section 1). Every time-of-day count and the risk model use only
    the other offenses. meta.totals.incidents still counts all of them.
    """
    return frame[frame["known_time"]]


def load_group_map(path: Path = GROUPS_CSV) -> dict[str, str]:
    table = pd.read_csv(path, dtype=str, keep_default_na=False)
    return dict(zip(table["code_description"].str.strip(), table["group_key"].str.strip()))


def load_incidents(path: Path = DATA_CSV) -> Incidents:
    """Read the SPD CSV, deduplicate, drop `exclude` rows and attach band/group/cell."""
    columns = ["Report Number", "Offense ID", "Offense Date", "Latitude", "Longitude",
               "Precinct", "Neighborhood", "NIBRS Offense Code Description"]
    raw = pd.read_csv(path, usecols=columns, dtype=str, keep_default_na=False)
    rows_read = len(raw)
    raw = raw.drop_duplicates(["Report Number", "Offense ID"], keep="first")
    duplicates = rows_read - len(raw)

    group_key = raw["NIBRS Offense Code Description"].str.strip().map(load_group_map())
    group_key = group_key.fillna("other")        # unknown description -> other
    keep = (group_key != EXCLUDE_KEY).to_numpy()
    excluded = int((~keep).sum())
    raw, group_key = raw[keep], group_key[keep]

    when = pd.to_datetime(raw["Offense Date"], format=DATE_FORMAT, errors="coerce")
    good = when.notna().to_numpy()
    bad_dates = int((~good).sum())
    raw, group_key, when = raw[good], group_key[good], when[good]

    lat = pd.to_numeric(raw["Latitude"], errors="coerce").to_numpy()
    lng = pd.to_numeric(raw["Longitude"], errors="coerce").to_numpy()
    with np.errstate(invalid="ignore"):
        row = np.floor((lat - GRID["lat0"]) / GRID["dLat"])
        col = np.floor((lng - GRID["lng0"]) / GRID["dLng"])
        located = (row >= 0) & (row < ROWS) & (col >= 0) & (col < COLS)   # NaN -> False
    flat = np.where(located, np.nan_to_num(row) * COLS + np.nan_to_num(col), -1).astype(np.int32)

    group = group_key.map(GROUP_IDS).to_numpy().astype(np.int8)
    hour = when.dt.hour.to_numpy()
    unknown = (hour == 0) & (when.dt.minute.to_numpy() == 0) & (when.dt.second.to_numpy() == 0)
    frame = pd.DataFrame({
        "when": when.to_numpy(),
        "known_time": ~unknown,
        "band": (hour // 6).astype(np.int8),
        "group": group,
        "severity": SEVERITY[group],
        "located": located,
        "flat": flat,
        "lat": lat,
        "lng": lng,
        "neighborhood": raw["Neighborhood"].str.strip().to_numpy(),
        "precinct": raw["Precinct"].str.strip().to_numpy(),
    })
    return Incidents(frame, rows_read, duplicates, excluded, bad_dates)


# ---- Time windows -------------------------------------------------------------
def windows(last_day: pd.Timestamp, count: int = 4) -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    """12-month windows W1..Wn that end at the data's last day (inclusive).

    Each window is [start, stop) in local time. W_n ends at last_day + 1 day.
    """
    stop = last_day.normalize() + pd.Timedelta(days=1)
    return [(stop - pd.DateOffset(years=k), stop - pd.DateOffset(years=k - 1))
            for k in range(count, 0, -1)]


def window_label(window: tuple[pd.Timestamp, pd.Timestamp], first_day: pd.Timestamp | None = None) -> str:
    start, stop = window
    if first_day is not None and start < first_day:
        start = first_day
    return f"{start.date()} to {(stop - pd.Timedelta(days=1)).date()}"


def in_window(frame: pd.DataFrame, window) -> pd.DataFrame:
    start, stop = window
    return frame[(frame["when"] >= start) & (frame["when"] < stop)]


# ---- Grid arrays ---------------------------------------------------------------
def band_grid(frame: pd.DataFrame, weight: str | None = "severity") -> np.ndarray:
    """Sum of `weight` (or counts) of located incidents -> array (4, ROWS, COLS)."""
    loc = frame[frame["located"]]
    index = loc["band"].to_numpy(np.int64) * N_FLAT + loc["flat"].to_numpy(np.int64)
    weights = None if weight is None else loc[weight].to_numpy(float)
    total = np.bincount(index, weights=weights, minlength=N_BANDS * N_FLAT)
    return total.reshape(N_BANDS, ROWS, COLS)


def group_band_grid(frame: pd.DataFrame) -> np.ndarray:
    """Counts of located incidents -> array (8 groups, 4 bands, ROWS, COLS)."""
    loc = frame[frame["located"]]
    index = ((loc["group"].to_numpy(np.int64) * N_BANDS + loc["band"].to_numpy(np.int64)) * N_FLAT
             + loc["flat"].to_numpy(np.int64))
    total = np.bincount(index, minlength=N_GROUPS * N_BANDS * N_FLAT)
    return total.reshape(N_GROUPS, N_BANDS, ROWS, COLS)


def box_mean(grid: np.ndarray, size: int) -> np.ndarray:
    """Mean over the size x size block around each cell (cells outside the grid count as 0)."""
    from scipy.ndimage import uniform_filter
    shape = (1,) * (grid.ndim - 2) + (size, size)
    return uniform_filter(np.asarray(grid, dtype=float), size=shape, mode="constant", cval=0.0)


def smoothed_counts(grid: np.ndarray) -> np.ndarray:
    """v0 baseline: half the cell's own value plus half the 3x3 block mean (keeps the total)."""
    return 0.5 * grid + 0.5 * box_mean(grid, 3)


def active_cells(frame: pd.DataFrame) -> np.ndarray:
    """Flat indices of cells with at least one located incident (sorted)."""
    flat = frame.loc[frame["located"], "flat"].to_numpy()
    return np.unique(flat)


def dominant_neighborhood(frame: pd.DataFrame) -> pd.Series:
    """flat cell index -> neighborhood key with the most located incidents (valid keys only)."""
    loc = frame[frame["located"] & ~frame["neighborhood"].isin(DROPPED_NEIGHBORHOODS)]
    table = loc.groupby(["flat", "neighborhood"]).size().reset_index(name="n")
    table = table.sort_values(["flat", "n", "neighborhood"], ascending=[True, False, True])
    table = table.drop_duplicates("flat")
    return pd.Series(table["neighborhood"].to_numpy(), index=table["flat"].to_numpy())


# ---- Metrics ------------------------------------------------------------------
def hotspot_capture(y_true: np.ndarray, y_pred: np.ndarray, share: float = 0.10) -> float:
    """Share of y_true that falls in the top `share` of items ranked by y_pred.

    Ties at the cut-off get fractional credit, so a prediction with many equal
    values is not helped or hurt by sort order.
    """
    y_true = np.asarray(y_true, float)
    y_pred = np.asarray(y_pred, float)
    k = int(math.ceil(share * len(y_pred)))
    cut = np.sort(y_pred)[::-1][k - 1]
    above = y_pred > cut
    tied = y_pred == cut
    fraction = (k - above.sum()) / tied.sum()
    captured = y_true[above].sum() + fraction * y_true[tied].sum()
    return float(captured / y_true.sum())


def risk_metrics(y_true: np.ndarray, y_pred: np.ndarray) -> dict[str, float]:
    from scipy.stats import spearmanr
    from sklearn.metrics import mean_absolute_error, mean_poisson_deviance

    y_true = np.asarray(y_true, float)
    y_pred = np.asarray(y_pred, float)
    return {
        "poissonDeviance": round(float(mean_poisson_deviance(y_true, np.clip(y_pred, 1e-3, None))), 4),
        "mae": round(float(mean_absolute_error(y_true, y_pred)), 4),
        "spearman": round(float(spearmanr(y_true, y_pred).statistic), 4),
        "hotspotCapture10": round(hotspot_capture(y_true, y_pred, 0.10), 4),
    }


# ---- Risk levels ----------------------------------------------------------------
def risk_quantiles(values: np.ndarray) -> dict[str, float]:
    values = np.asarray(values, float)
    return {key: round(float(np.quantile(values, q)), 2) for key, q in QUANTILE_KEYS.items()}


def risk_levels(quantiles: dict[str, float]) -> dict[str, float]:
    """meta.risk.levels from meta.risk.quantiles: {"elevated": q90, "high": q97}."""
    return {level: quantiles[key] for level, key in LEVEL_QUANTILES.items()}


def risk_level(value: float, elevated: float, high: float) -> str:
    """LOW < elevated (q90) <= ELEVATED < high (q97) <= HIGH (docs/API.md section 1)."""
    if value >= high:
        return "high"
    if value >= elevated:
        return "elevated"
    return "low"


# ---- Output -----------------------------------------------------------------------
def write_json(path: Path, payload) -> int:
    """Compact UTF-8 JSON, written atomically. Returns the size in bytes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    data = text.encode("utf-8")
    partial = path.with_name(path.name + ".part")
    partial.write_bytes(data)
    os.replace(partial, path)
    return len(data)
