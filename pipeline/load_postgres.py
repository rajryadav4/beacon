"""Load the SPD crime CSV into PostgreSQL and rebuild the summary tables.

Port of PART 3 of sql/crime_radar_all.sql (load, clean, dedupe) and the
REFRESH part of sql/app_tables.sql (grid neighborhoods, cell and neighborhood
stats, app_meta), with the same rules:

  * offenses with no report number, offense id or valid offense date are dropped
  * duplicates (report number + offense id) keep the newest offense date
  * only the last 4 years are kept
  * latitude outside 47..48 or longitude outside -123..-122 -> no location
  * 'exclude' offenses (pipeline/category_groups.csv) are left out of every summary
  * offenses at exactly 00:00:00 local time have no known time of day and are
    left out of the time-of-day counts

Usage, from the repository root (database from docker-compose.yml):

    python pipeline/load_postgres.py                      # data/SPD_Crime_Data_Last4Yrs_150k.csv
    python pipeline/load_postgres.py --csv other.csv
    python pipeline/load_postgres.py --refresh-only       # rebuild summaries only
"""

from __future__ import annotations

import argparse
import csv
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pg import ROOT, connect  # noqa: E402

DEFAULT_CSV = ROOT / "data" / "SPD_Crime_Data_Last4Yrs_150k.csv"
GROUPS_CSV = ROOT / "pipeline" / "category_groups.csv"
SOURCE = ("SPD Crime Data: 2008-Present", "tazs-3rd5", "https://data.seattle.gov/d/tazs-3rd5")
DROPPED_NEIGHBORHOODS = ("-", "UNKNOWN", "OOJ", "FK ERROR")
DROPPED_PRECINCTS = ("-", "UNKNOWN", "OOJ")

STAGING = """
CREATE TEMPORARY TABLE stg (
    rpt_num text, rdt_txt text, off_id text, off_dt_txt text, grp_ab text,
    against text, subcat text, shoot text, block text, lat_txt text,
    lng_txt text, beat_txt text, precinct_txt text, sector text, nbhd_txt text,
    rep_area text, off_category text, code_desc text, code_txt text, census text
) ON COMMIT DROP
"""

# SPD export date format, e.g. '2026 Mar 07 10:15:00 PM' (Seattle local time).
DATE_RE = r"^\d{4} [A-Za-z]{3} \d{2} \d{2}:\d{2}:\d{2} [AP]M$"
NUM_RE = r"^-?[0-9]+([.][0-9]+)?$"

CLEAN = f"""
CREATE TEMPORARY TABLE sel ON COMMIT DROP AS
SELECT DISTINCT ON (c.rpt, c.oid)
       c.rpt,
       c.rpt || '-' || c.oid AS source_offense,
       c.occ_local AT TIME ZONE 'America/Los_Angeles' AS occ,
       c.rdt_local AT TIME ZONE 'America/Los_Angeles' AS rdt,
       c.occ_local,
       c.cat, c.grp, c.against, c.precinct, c.nbhd, c.block, c.beat,
       CASE WHEN c.lat_raw BETWEEN 47 AND 48 THEN c.lat_raw END     AS lat,
       CASE WHEN c.lng_raw BETWEEN -123 AND -122 THEN c.lng_raw END AS lng
FROM (
    SELECT NULLIF(trim(rpt_num), '') AS rpt,
           NULLIF(trim(off_id), '')  AS oid,
           CASE WHEN trim(off_dt_txt) ~ '{DATE_RE}'
                THEN to_timestamp(trim(off_dt_txt), 'YYYY Mon DD HH12:MI:SS AM')::timestamp END AS occ_local,
           CASE WHEN trim(rdt_txt) ~ '{DATE_RE}'
                THEN to_timestamp(trim(rdt_txt), 'YYYY Mon DD HH12:MI:SS AM')::timestamp END    AS rdt_local,
           left(COALESCE(NULLIF(NULLIF(trim(code_desc), '-'), ''), 'UNKNOWN'), 150)    AS cat,
           left(COALESCE(NULLIF(NULLIF(trim(grp_ab), '-'), ''), 'UNKNOWN'), 50)        AS grp,
           left(COALESCE(NULLIF(NULLIF(trim(against), '-'), ''), 'UNKNOWN'), 100)      AS against,
           left(COALESCE(NULLIF(NULLIF(trim(precinct_txt), '-'), ''), 'UNKNOWN'), 100) AS precinct,
           left(COALESCE(NULLIF(NULLIF(trim(nbhd_txt), '-'), ''), 'UNKNOWN'), 150)     AS nbhd,
           NULLIF(NULLIF(trim(block), '-'), '')                                        AS block,
           left(NULLIF(NULLIF(trim(beat_txt), '-'), ''), 50)                           AS beat,
           CASE WHEN trim(lat_txt) ~ '{NUM_RE}' THEN trim(lat_txt)::double precision END AS lat_raw,
           CASE WHEN trim(lng_txt) ~ '{NUM_RE}' THEN trim(lng_txt)::double precision END AS lng_raw
    FROM stg
) c
WHERE c.rpt IS NOT NULL
  AND c.oid IS NOT NULL
  AND c.occ_local IS NOT NULL
  AND c.occ_local >= (now() AT TIME ZONE 'America/Los_Angeles')::date - interval '4 years'
ORDER BY c.rpt, c.oid, c.occ_local DESC
"""

UPSERT_SOURCE = """
INSERT INTO data_sources (source_name, dataset_identifier, source_url, last_imported_at)
VALUES (%s, %s, %s, now())
ON CONFLICT (dataset_identifier) DO UPDATE SET last_imported_at = now()
"""

LOAD = """
INSERT INTO police_precincts (precinct_name)
SELECT DISTINCT precinct FROM sel ON CONFLICT DO NOTHING;

INSERT INTO neighborhoods (neighborhood_name, precinct_id)
SELECT x.nbhd, p.precinct_id
FROM (SELECT nbhd, min(precinct) AS prc FROM sel GROUP BY nbhd) x
JOIN police_precincts p ON p.precinct_name = x.prc
ON CONFLICT DO NOTHING;

INSERT INTO crime_categories (category_name, nibrs_group, crime_against_category)
SELECT DISTINCT cat, grp, against FROM sel ON CONFLICT DO NOTHING;

INSERT INTO crime_incidents
    (source_id, source_offense_id, report_number, occurred_at, reported_at,
     category_id, neighborhood_id, precinct_id, block_address, latitude, longitude, beat)
SELECT ds.source_id, s.source_offense, s.rpt, s.occ, s.rdt,
       c.category_id, n.neighborhood_id, p.precinct_id, s.block, s.lat, s.lng, s.beat
FROM sel s
JOIN data_sources ds    ON ds.dataset_identifier = 'tazs-3rd5'
JOIN crime_categories c ON c.category_name = s.cat
                       AND c.nibrs_group = s.grp
                       AND c.crime_against_category = s.against
JOIN neighborhoods n    ON n.neighborhood_name = s.nbhd
JOIN police_precincts p ON p.precinct_name = s.precinct;
"""

REFRESH = f"""
DELETE FROM cell_stats;
DELETE FROM neighborhood_stats;
UPDATE grid_cells SET neighborhood_id = NULL WHERE neighborhood_id IS NOT NULL;
DELETE FROM app_meta WHERE meta_key IN
    ('incidents', 'located', 'excluded', 'unknownTime', 'dataFrom', 'dataTo', 'builtAt');

CREATE TEMPORARY TABLE tmp_clean ON COMMIT DROP AS
SELECT v.cell_id, v.time_band, v.group_id, v.local_time, v.known_time,
       CASE WHEN upper(n.neighborhood_name) IN {DROPPED_NEIGHBORHOODS!r}
            THEN NULL ELSE v.neighborhood_id END AS nb_id
FROM clean_incidents v
LEFT JOIN neighborhoods n ON n.neighborhood_id = v.neighborhood_id;

-- Dominant valid neighborhood of each cell (most incidents; ties: name A-Z by bytes).
UPDATE grid_cells g SET neighborhood_id = r.nb_id
FROM (
    SELECT DISTINCT ON (t.cell_id) t.cell_id, t.nb_id
    FROM (
        SELECT cell_id, nb_id, count(*) AS cnt
        FROM tmp_clean
        WHERE cell_id IS NOT NULL AND known_time
        GROUP BY cell_id, nb_id
    ) t
    LEFT JOIN neighborhoods n ON n.neighborhood_id = t.nb_id
    ORDER BY t.cell_id, (t.nb_id IS NULL), t.cnt DESC, n.neighborhood_name COLLATE "C"
) r
WHERE g.cell_id = r.cell_id;

INSERT INTO cell_stats (cell_id, time_band, group_id, incident_count)
SELECT cell_id, time_band, group_id, count(*)
FROM tmp_clean
WHERE cell_id IS NOT NULL AND known_time
GROUP BY cell_id, time_band, group_id;

INSERT INTO neighborhood_stats (neighborhood_id, time_band, group_id, incident_count, located_count)
SELECT nb_id, time_band, group_id, count(*), count(cell_id)
FROM tmp_clean
WHERE nb_id IS NOT NULL AND known_time
GROUP BY nb_id, time_band, group_id;

INSERT INTO app_meta (meta_key, meta_value)
SELECT 'incidents', count(*)::text FROM tmp_clean
UNION ALL SELECT 'unknownTime', count(*) FILTER (WHERE NOT known_time)::text FROM tmp_clean
UNION ALL SELECT 'located', count(cell_id)::text FROM tmp_clean
UNION ALL SELECT 'excluded', ((SELECT count(*) FROM crime_incidents) - count(*))::text FROM tmp_clean
UNION ALL SELECT 'dataFrom', to_char(min(local_time), 'YYYY-MM-DD') FROM tmp_clean
UNION ALL SELECT 'dataTo', to_char(max(local_time), 'YYYY-MM-DD') FROM tmp_clean
UNION ALL SELECT 'builtAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
"""


def load_offense_groups(cur) -> int:
    with GROUPS_CSV.open(newline="", encoding="utf-8") as f:
        rows = [(r["code_description"].strip(), r["group_key"].strip()) for r in csv.DictReader(f)]
    cur.execute("DELETE FROM offense_groups")
    cur.executemany("INSERT INTO offense_groups (code_description, group_key) VALUES (%s, %s)"
                    " ON CONFLICT (code_description) DO UPDATE SET group_key = EXCLUDED.group_key", rows)
    return len(rows)


def load_csv(cur, path: Path) -> None:
    cur.execute(STAGING)
    with path.open("rb") as f, cur.copy("COPY stg FROM STDIN WITH (FORMAT csv, HEADER true)") as copy:
        while chunk := f.read(1 << 20):
            copy.write(chunk)
    cur.execute("SELECT count(*) FROM stg")
    print(f"  staged rows:    {cur.fetchone()[0]:>9,}")
    cur.execute(CLEAN)
    cur.execute("SELECT count(*) FROM sel")
    print(f"  selected rows:  {cur.fetchone()[0]:>9,}")
    cur.execute("TRUNCATE crime_incidents RESTART IDENTITY")
    cur.execute(UPSERT_SOURCE, SOURCE)
    cur.execute(LOAD)
    cur.execute("SELECT count(*) FROM crime_incidents")
    print(f"  incidents:      {cur.fetchone()[0]:>9,}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    parser.add_argument("--refresh-only", action="store_true", help="only rebuild the summary tables")
    args = parser.parse_args()

    if not args.refresh_only and not args.csv.exists():
        print(f"Missing {args.csv}. Run: python pipeline/fetch_spd.py", file=sys.stderr)
        return 1

    started = time.time()
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SET TIME ZONE 'UTC'")   # to_timestamp(...)::timestamp then round-trips exactly
        print(f"  offense groups: {load_offense_groups(cur):>9,}")
        if not args.refresh_only:
            load_csv(cur, args.csv)
        cur.execute(REFRESH)
        cur.execute("SELECT meta_key, meta_value FROM app_meta ORDER BY meta_key")
        for key, value in cur.fetchall():
            print(f"  {key + ':':<15} {value:>9}")
        cur.execute("SELECT count(*), sum(incident_count) FROM cell_stats")
        rows, total = cur.fetchone()
        print(f"  cell_stats:     {rows:>9,} rows, {total or 0:,} incidents")
    print(f"Done in {time.time() - started:.1f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
