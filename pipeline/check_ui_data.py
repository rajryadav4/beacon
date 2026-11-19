"""Check the web app's static map data against the contract in docs/API.md.

Reads CrimeRadar/src/main/webapp/assets/data/{meta,grid,neighborhoods,places}.json.
Prints every problem it finds and exits with code 1 if there is any.

The contract constants are copied here on purpose (not imported from the build
code), so a mistake in the build code cannot hide itself.

Usage, from the repository root:

    python pipeline/check_ui_data.py
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import re
import sys
from pathlib import Path

DEFAULT_DIR = Path(__file__).resolve().parents[1] / "CrimeRadar" / "src" / "main" / "webapp" / "assets" / "data"
GRID_MAX_BYTES = 1_500_000

GRID = {"lat0": 47.48, "lng0": -122.46, "dLat": 0.002, "dLng": 0.003, "rows": 135, "cols": 80}
BANDS = [(0, "night", "Night", "12 AM - 6 AM"), (1, "morning", "Morning", "6 AM - 12 PM"),
         (2, "afternoon", "Afternoon", "12 PM - 6 PM"), (3, "evening", "Evening", "6 PM - 12 AM")]
GROUPS = [(0, "violent", "Assault & violence", 3.0), (1, "robbery", "Robbery", 4.0),
          (2, "theft", "Theft", 1.0), (3, "vehicle", "Vehicle crime", 1.0),
          (4, "burglary", "Burglary & trespass", 1.5), (5, "vandalism", "Vandalism & arson", 1.0),
          (6, "drugs", "Drugs, weapons & disorder", 1.5), (7, "other", "Other offenses", 0.25)]
MODES = {"walk": ("Walk", 1.0), "bike": ("Bike", 0.7), "car": ("Car", 0.3)}
QUANTILES = {"q50": 0.50, "q75": 0.75, "q90": 0.90, "q97": 0.97, "q99": 0.99}
# LOW < q90 <= ELEVATED < q97 <= HIGH (docs/API.md section 1, changed from q75 / q90 on 2026-11-19)
LEVEL_QUANTILES = {"elevated": "q90", "high": "q97"}
DROPPED_NEIGHBORHOODS = {"-", "UNKNOWN", "OOJ", "FK ERROR", ""}
CELL_AREA_KM2 = 0.0501
LAT_MAX = GRID["lat0"] + GRID["rows"] * GRID["dLat"]
LNG_MAX = GRID["lng0"] + GRID["cols"] * GRID["dLng"]


class Checker:
    def __init__(self) -> None:
        self.problems: list[str] = []
        self.checks = 0

    def ok(self, condition: bool, message: str) -> bool:
        self.checks += 1
        if not condition:
            self.problems.append(message)
        return bool(condition)


def is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def is_num(value) -> bool:
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value))


def two_decimals(value: float) -> bool:
    return abs(value * 100 - round(value * 100)) < 1e-6


def quantile(sorted_values: list[float], q: float) -> float:
    """Same as numpy.quantile with linear interpolation."""
    position = (len(sorted_values) - 1) * q
    low = math.floor(position)
    high = min(low + 1, len(sorted_values) - 1)
    return sorted_values[low] + (sorted_values[high] - sorted_values[low]) * (position - low)


def load(path: Path, c: Checker):
    if not c.ok(path.exists(), f"{path.name}: file is missing"):
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        c.ok(False, f"{path.name}: not valid UTF-8 JSON ({error})")
        return None


def check_meta(meta: dict, c: Checker) -> None:
    c.ok(meta.get("version") == 1, "meta: version must be 1")
    c.ok(isinstance(meta.get("generatedAt"), str)
         and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", meta["generatedAt"]) is not None,
         "meta: generatedAt must look like 2026-11-19T09:30:00Z")
    source = meta.get("source", {})
    c.ok(source.get("id") == "tazs-3rd5" and bool(source.get("name")) and bool(source.get("url")),
         "meta: source needs name, id tazs-3rd5 and url")

    data_range = meta.get("dataRange", {})
    try:
        first = dt.date.fromisoformat(data_range["from"])
        last = dt.date.fromisoformat(data_range["to"])
        years = data_range["years"]
        c.ok(first < last, "meta: dataRange.from must be before dataRange.to")
        c.ok(is_num(years) and abs(years - (last - first).days / 365.25) < 0.02,
             "meta: dataRange.years does not match from/to")
    except (KeyError, TypeError, ValueError):
        c.ok(False, "meta: dataRange needs from, to (YYYY-MM-DD) and years")

    totals = meta.get("totals", {})
    if c.ok(all(is_int(totals.get(k)) and totals[k] >= 0
                for k in ("incidents", "located", "excluded", "unknownTime")),
            "meta: totals needs non-negative integers incidents, located, excluded, unknownTime"):
        c.ok(totals["located"] <= totals["incidents"], "meta: totals.located > totals.incidents")
        c.ok(totals["unknownTime"] < totals["incidents"], "meta: totals.unknownTime >= totals.incidents")

    c.ok(meta.get("grid") == GRID, f"meta: grid must be {GRID}")
    bands = [(b.get("id"), b.get("key"), b.get("label"), b.get("hours")) for b in meta.get("bands", [])]
    c.ok(bands == BANDS, "meta: bands must hold the 4 bands of docs/API.md in id order")
    groups = [(g.get("id"), g.get("key"), g.get("label"), g.get("severity")) for g in meta.get("groups", [])]
    c.ok(groups == GROUPS, "meta: groups must hold the 8 groups of docs/API.md in id order")
    modes = {k: (v.get("label"), v.get("vulnerability")) for k, v in meta.get("modes", {}).items()}
    c.ok(modes == MODES, "meta: modes must be walk, bike, car with the contract labels and vulnerability")

    risk = meta.get("risk", {})
    c.ok(isinstance(risk.get("unit"), str) and "per year" in risk.get("unit", ""),
         "meta: risk.unit must describe the per-year unit")
    q = risk.get("quantiles", {})
    if c.ok(set(q) == set(QUANTILES) and all(is_num(v) for v in q.values()),
            "meta: risk.quantiles needs numbers q50, q75, q90, q97, q99"):
        values = [q[k] for k in QUANTILES]
        c.ok(all(a < b for a, b in zip(values, values[1:])),
             f"meta: risk.quantiles must increase strictly, got {values}")
        levels = risk.get("levels", {})
        c.ok(set(levels) == set(LEVEL_QUANTILES), "meta: risk.levels must have exactly elevated and high")
        for level, key in LEVEL_QUANTILES.items():
            c.ok(levels.get(level) == q[key],
                 f"meta: risk.levels.{level} must equal quantiles.{key} ({q[key]}), got {levels.get(level)}")

    model = meta.get("model", {})
    c.ok(all(isinstance(model.get(k), str) and model.get(k) for k in ("version", "algorithm", "trainedOn")),
         "meta: model needs version, algorithm and trainedOn strings")
    for label, block in (("model.metrics", model.get("metrics", {})),
                         ("model.baseline", model.get("baseline", {}))):
        c.ok(is_num(block.get("hotspotCapture10")) and 0 <= block["hotspotCapture10"] <= 1,
             f"meta: {label}.hotspotCapture10 must be in 0..1")
        c.ok(is_num(block.get("spearman")) and -1 <= block["spearman"] <= 1,
             f"meta: {label}.spearman must be in -1..1")
        c.ok(is_num(block.get("poissonDeviance")) and block["poissonDeviance"] >= 0,
             f"meta: {label}.poissonDeviance must be >= 0")
    c.ok(isinstance(model.get("baseline", {}).get("name"), str), "meta: model.baseline.name missing")


def check_grid(grid: dict, n_neighborhoods: int, c: Checker) -> list:
    c.ok(grid.get("version") == 1, "grid: version must be 1")
    cells = grid.get("cells")
    if not c.ok(isinstance(cells, list) and len(cells) > 0, "grid: cells must be a non-empty list"):
        return []
    seen: set[int] = set()
    bad: dict[str, int] = {}

    def fail(reason: str) -> None:
        bad[reason] = bad.get(reason, 0) + 1

    good = []
    for cell in cells:
        if not (isinstance(cell, list) and len(cell) == 4):
            fail("cell is not [cellId, nbIndex, counts, risk]")
            continue
        cell_id, nb_index, counts, risk = cell
        if not (is_int(cell_id) and 0 <= cell_id // 100 < GRID["rows"] and 0 <= cell_id % 100 < GRID["cols"]):
            fail("invalid cellId")
            continue
        if cell_id in seen:
            fail("duplicate cellId")
        seen.add(cell_id)
        if not (is_int(nb_index) and -1 <= nb_index < n_neighborhoods):
            fail("nbIndex out of range")
        if not (isinstance(counts, list) and len(counts) == 32 and all(is_int(v) and v >= 0 for v in counts)):
            fail("counts is not 32 non-negative integers")
            continue
        if not (isinstance(risk, list) and len(risk) == 4 and all(is_num(v) and v >= 0 for v in risk)):
            fail("risk is not 4 non-negative numbers")
            continue
        if not all(two_decimals(v) for v in risk):
            fail("risk has more than 2 decimals")
        if sum(counts) == 0 and max(risk) <= 0:
            fail("cell has no located incident and no risk")
        good.append(cell)
    for reason, count in bad.items():
        c.ok(False, f"grid: {count} cells: {reason}")
    return good


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dir", type=Path, default=DEFAULT_DIR, help="folder with the 4 JSON files")
    args = parser.parse_args(argv)
    c = Checker()

    meta = load(args.dir / "meta.json", c)
    grid = load(args.dir / "grid.json", c)
    hoods_doc = load(args.dir / "neighborhoods.json", c)
    places_doc = load(args.dir / "places.json", c)

    if meta is not None:
        check_meta(meta, c)

    hoods = []
    if hoods_doc is not None:
        c.ok(hoods_doc.get("version") == 1, "neighborhoods: version must be 1")
        hoods = hoods_doc.get("neighborhoods") or []
        c.ok(len(hoods) > 0, "neighborhoods: list is empty")
        names = [h.get("name", "") for h in hoods]
        c.ok(names == sorted(names, key=str.casefold), "neighborhoods: not sorted by name")
        keys = [h.get("key") for h in hoods]
        c.ok(len(set(keys)) == len(keys), "neighborhoods: duplicate keys")
        for h in hoods:
            label = f"neighborhoods[{h.get('key')}]"
            c.ok(isinstance(h.get("key"), str) and h["key"] not in DROPPED_NEIGHBORHOODS,
                 f"{label}: key is missing or an unwanted value")
            c.ok(isinstance(h.get("name"), str) and h["name"].strip() != "", f"{label}: name missing")
            c.ok(isinstance(h.get("precinct"), str), f"{label}: precinct missing")
            c.ok(is_num(h.get("lat")) and GRID["lat0"] <= h["lat"] <= LAT_MAX
                 and is_num(h.get("lng")) and GRID["lng0"] <= h["lng"] <= LNG_MAX,
                 f"{label}: lat/lng missing or outside the grid")
            c.ok(is_int(h.get("cells")) and h["cells"] >= 0, f"{label}: cells must be an integer >= 0")
            c.ok(is_num(h.get("areaKm2")) and is_int(h.get("cells"))
                 and abs(h["areaKm2"] - round(h["cells"] * CELL_AREA_KM2, 2)) < 0.006,
                 f"{label}: areaKm2 must be cells * {CELL_AREA_KM2}")
            counts = h.get("counts")
            c.ok(isinstance(counts, list) and len(counts) == 32 and all(is_int(v) and v >= 0 for v in counts),
                 f"{label}: counts must be 32 non-negative integers")
            c.ok(is_int(h.get("unlocated")) and 0 <= h["unlocated"] <= sum(counts or []),
                 f"{label}: unlocated must be between 0 and the total count")

    cells = check_grid(grid, len(hoods), c) if grid is not None else []
    if grid is not None:
        size = (args.dir / "grid.json").stat().st_size
        c.ok(size < GRID_MAX_BYTES, f"grid: grid.json is {size:,} bytes, limit {GRID_MAX_BYTES:,}")

    # ---- Cross-file consistency ----
    # meta.totals counts every offense. The time-of-day counts (grid and neighborhood
    # `counts`, `unlocated`) leave out the totals.unknownTime offenses (docs/API.md section 1).
    if meta is not None and cells:
        totals = meta.get("totals", {})
        located = sum(sum(cell[2]) for cell in cells)       # located offenses with a known time
        all_located = totals.get("located", 0)
        unknown = totals.get("unknownTime", 0)
        c.ok(all_located - unknown <= located <= all_located,
             f"totals: grid counts sum to {located:,}; with meta.totals.located {all_located:,} and "
             f"unknownTime {unknown:,} it must be between {all_located - unknown:,} and {all_located:,}")
        risks = sorted(v for cell in cells for v in cell[3])
        q = meta.get("risk", {}).get("quantiles", {})
        for key, share in QUANTILES.items():
            if key in q:
                expected = round(quantile(risks, share), 2)
                c.ok(abs(expected - q[key]) <= 0.011,
                     f"risk: meta {key}={q[key]} but grid risks give {expected}")
        if hoods:
            per_hood = [0] * len(hoods)
            for cell in cells:
                if 0 <= cell[1] < len(hoods):
                    per_hood[cell[1]] += 1
            mismatched = [h["key"] for h, n in zip(hoods, per_hood) if h.get("cells") != n]
            c.ok(not mismatched, f"neighborhoods: cells does not match grid nbIndex for {mismatched[:5]}")
            all_counts = sum(sum(h.get("counts") or []) for h in hoods)
            unlocated = sum(h.get("unlocated") or 0 for h in hoods)
            timed = totals.get("incidents", 0) - unknown       # offenses with a known time
            c.ok(all_counts <= timed,
                 f"totals: neighborhood counts {all_counts:,} > incidents with a known time {timed:,}")
            c.ok(all_counts - unlocated <= located,
                 "totals: located offenses in neighborhoods > located offenses in the grid")
            c.ok(unlocated <= timed - located,
                 "totals: unlocated in neighborhoods > known-time offenses not on the map")

    if places_doc is not None:
        places = places_doc.get("places")
        if c.ok(isinstance(places, list) and len(places) > 0, "places: list is empty"):
            for p in places:
                c.ok(isinstance(p.get("name"), str) and p["name"] and isinstance(p.get("category"), str)
                     and is_num(p.get("lat")) and GRID["lat0"] <= p["lat"] <= LAT_MAX
                     and is_num(p.get("lng")) and GRID["lng0"] <= p["lng"] <= LNG_MAX,
                     f"places: bad entry {p}")
            names = [p.get("name") for p in places]
            c.ok(len(set(names)) == len(names), "places: duplicate names")

    if c.problems:
        print(f"FAILED: {len(c.problems)} of {c.checks} checks", file=sys.stderr)
        for problem in c.problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1
    print(f"OK: {c.checks} checks passed ({len(cells):,} cells, {len(hoods)} neighborhoods, "
          f"{len(places_doc.get('places', []))} places, grid.json "
          f"{(args.dir / 'grid.json').stat().st_size / 1024:,.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
