"""Download SPD Crime Data (dataset tazs-3rd5) from Seattle Open Data.

The output CSV has the same 20 columns, column order and date format as the
portal's "Export > CSV" file, so sql/crime_radar_all.sql loads it unchanged.

Usage, from the repository root:

    python pipeline/fetch_spd.py                      # last 4 years
    python pipeline/fetch_spd.py --years 2 --out data/two_years.csv

Only the Python standard library is used.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

DATASET = "tazs-3rd5"
API = f"https://data.seattle.gov/resource/{DATASET}"
USER_AGENT = "seattle-open-data-fetch/1.0 (python urllib)"
PAGE_SIZE = 50_000
DEFAULT_OUT = Path("data/SPD_Crime_Data_Last4Yrs_150k.csv")

# API field name -> column header used by the portal export (same order as the
# staging table in sql/crime_radar_all.sql).
COLUMNS = [
    ("report_number", "Report Number"),
    ("report_date_time", "Report DateTime"),
    ("offense_id", "Offense ID"),
    ("offense_date", "Offense Date"),
    ("nibrs_group_a_b", "NIBRS Group AB"),
    ("nibrs_crime_against_category", "NIBRS Crime Against Category"),
    ("offense_sub_category", "Offense Sub Category"),
    ("shooting_type_group", "Shooting Type Group"),
    ("block_address", "Block Address"),
    ("latitude", "Latitude"),
    ("longitude", "Longitude"),
    ("beat", "Beat"),
    ("precinct", "Precinct"),
    ("sector", "Sector"),
    ("neighborhood", "Neighborhood"),
    ("reporting_area", "Reporting Area"),
    ("offense_category", "Offense Category"),
    ("nibrs_offense_code_description", "NIBRS Offense Code Description"),
    ("nibrs_offense_code", "NIBRS_offense_code"),
    ("census_block_2020", "Census Block 2020"),
]
DATE_FIELDS = {"report_date_time", "offense_date"}


def years_ago(today: dt.date, years: int) -> dt.date:
    try:
        return today.replace(year=today.year - years)
    except ValueError:  # 29 February
        return today.replace(year=today.year - years, day=28)


def portal_date(value: str) -> str:
    """'2026-11-17T22:00:00.000' -> '2026 Nov 17 10:00:00 PM' (the export format)."""
    if not value:
        return ""
    stamp = dt.datetime.fromisoformat(value.rstrip("Z"))
    return stamp.strftime("%Y %b %d %I:%M:%S %p")


def get(params: dict[str, str], attempts: int = 4) -> str:
    url = f"{API}.csv?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                return response.read().decode("utf-8")
        except Exception as error:  # network errors and HTTP 5xx: retry with backoff
            if attempt == attempts:
                raise
            wait = 5 * attempt
            print(f"  request failed ({error}); retry in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise AssertionError("unreachable")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--years", type=int, default=4, help="how many years back (default 4)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output CSV path")
    args = parser.parse_args()

    since = years_ago(dt.date.today(), args.years)
    where = f"offense_date >= '{since.isoformat()}T00:00:00'"
    fields = [api for api, _ in COLUMNS]

    total_text = get({"$select": "count(*) AS n", "$where": where})
    total = int(next(csv.DictReader(io.StringIO(total_text)))["n"])
    print(f"SPD offenses since {since}: {total:,}", file=sys.stderr)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    partial = args.out.with_suffix(args.out.suffix + ".part")
    written = 0
    with partial.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow([header for _, header in COLUMNS])
        offset = 0
        while offset < total:
            text = get({
                "$select": ",".join(fields),
                "$where": where,
                "$order": ":id",
                "$limit": str(PAGE_SIZE),
                "$offset": str(offset),
            })
            rows = list(csv.DictReader(io.StringIO(text)))
            if not rows:
                break
            for row in rows:
                writer.writerow([
                    portal_date(row.get(api, "")) if api in DATE_FIELDS else row.get(api, "")
                    for api in fields
                ])
            written += len(rows)
            offset += PAGE_SIZE
            print(f"  {written:,} / {total:,} rows", file=sys.stderr)

    os.replace(partial, args.out)
    size_mb = args.out.stat().st_size / 1_048_576
    print(f"Saved {written:,} rows to {args.out} ({size_mb:.1f} MB)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
