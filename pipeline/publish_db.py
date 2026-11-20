"""Copy the data the API serves from the local database to a hosted Postgres.

The target (Neon or Supabase free tier, see docs/DEPLOY.md) gets PostGIS, the
schema in db/schema/*.sql, and only the tables the API reads: lookups, grid,
summary stats, the active risk model, safe places, alerts, and the hazard
outlook tables when they exist. The 300k-row crime_incidents table stays local,
so the remote database stays at a few tens of MB.

Idempotent: every run replaces the copied tables in one transaction (TRUNCATE,
then COPY streamed from the source connection) and prints the row counts.
The connection strings are never printed.

Usage, from the repository root:

    TARGET_DATABASE_URL='postgresql://...' .venv/bin/python pipeline/publish_db.py
    .venv/bin/python pipeline/publish_db.py --target-url "$TARGET_DATABASE_URL" --no-live

The source is DATABASE_URL (or .env, or the docker-compose database).
--no-live leaves alerts, alert_zones and alert_feed_status on the target alone
(they are refreshed there by .github/workflows/refresh-data.yml).
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

import psycopg
from psycopg import errors, sql
from psycopg.conninfo import conninfo_to_dict

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pg import ROOT, database_url  # noqa: E402

SCHEMA_DIR = ROOT / "db" / "schema"

# Parents before children (foreign keys). Lookup rows seeded by the schema are
# replaced too, so the target always matches the source.
STATIC_TABLES = [
    "data_sources", "police_precincts", "neighborhoods",
    "crime_groups", "time_bands", "travel_modes", "app_meta",
    "grid_cells", "cell_stats", "neighborhood_stats",
    "model_runs", "cell_risk_scores",
    "safe_places", "hazard_place_kinds",
    # Hazard outlook (db/schema/005_hazard_outlook.sql), copied when present.
    "hazard_sources", "hazard_zone_kinds", "hazard_zones",
    "cell_terrain", "cell_hazard_exposure", "hazard_outlook",
    "emergency_calls",
]
# emergency_calls is always copied: it references data_sources, which TRUNCATE ... CASCADE empties.
LIVE_TABLES = ["alerts", "alert_zones", "alert_feed_status"]
REQUIRED = {"data_sources", "grid_cells", "cell_stats", "app_meta", "model_runs", "cell_risk_scores"}


def describe(url: str) -> str:
    """Host and database name only: no user, no password."""
    info = conninfo_to_dict(url)
    return f"{info.get('host', 'localhost')}:{info.get('port', '5432')}/{info.get('dbname', '')}"


def same_database(a: str, b: str) -> bool:
    ia, ib = conninfo_to_dict(a), conninfo_to_dict(b)
    key = lambda i: (i.get("host", "localhost").replace("127.0.0.1", "localhost"),  # noqa: E731
                     str(i.get("port", "5432")), i.get("dbname"))
    return key(ia) == key(ib)


def table_exists(conn, table: str) -> bool:
    return conn.execute("SELECT to_regclass(%s) IS NOT NULL", (f"public.{table}",)).fetchone()[0]


def copy_columns(conn, table: str) -> list[str]:
    """Plain columns in table order (generated columns are computed by the target)."""
    return [r[0] for r in conn.execute(
        "SELECT attname FROM pg_attribute WHERE attrelid = %s::regclass AND attnum > 0"
        " AND NOT attisdropped AND attgenerated = '' ORDER BY attnum", (f"public.{table}",))]


def count(conn, table: str) -> int:
    return conn.execute(sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier(table))).fetchone()[0]


def apply_schema(conn) -> None:
    """PostGIS plus db/schema/*.sql in order. Each file runs as one implicit
    transaction; a file whose tables already exist is skipped (001 and 002 are
    not written to run twice, 003 onwards are)."""
    conn.execute("CREATE EXTENSION IF NOT EXISTS postgis")
    for path in sorted(SCHEMA_DIR.glob("*.sql")):
        try:
            conn.execute(path.read_text())
            print(f"  schema {path.name}: applied")
        except (errors.DuplicateTable, errors.DuplicateObject):
            print(f"  schema {path.name}: already there")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--target-url", default=os.environ.get("TARGET_DATABASE_URL"),
                        help="target Postgres URL (default: $TARGET_DATABASE_URL); never printed")
    parser.add_argument("--source-url", default=None, help="source URL (default: DATABASE_URL, .env, local docker)")
    parser.add_argument("--no-live", action="store_true",
                        help="do not touch alerts, alert_zones and alert_feed_status on the target")
    parser.add_argument("--force", action="store_true",
                        help="publish even if the target holds crime_incidents rows (it looks like a full local DB)")
    args = parser.parse_args()

    source_url = args.source_url or database_url()
    if not args.target_url:
        parser.error("set TARGET_DATABASE_URL or pass --target-url")
    if same_database(source_url, args.target_url):
        parser.error("source and target are the same database")

    started = time.monotonic()
    print(f"source {describe(source_url)} -> target {describe(args.target_url)}")
    with psycopg.connect(source_url) as src, psycopg.connect(args.target_url, autocommit=True) as tgt:
        if table_exists(tgt, "crime_incidents") and not args.force and tgt.execute(
                "SELECT EXISTS (SELECT 1 FROM crime_incidents)").fetchone()[0]:
            print("target has crime_incidents rows: it looks like a full development database. "
                  "Use --force to publish into it anyway.", file=sys.stderr)
            return 2

        print("schema")
        apply_schema(tgt)

        # One consistent snapshot of the source.
        src.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        tables = []
        for table in STATIC_TABLES + ([] if args.no_live else LIVE_TABLES):
            if not table_exists(src, table):
                if table in REQUIRED:
                    print(f"source has no {table}: load the data first (docs/DEVELOPMENT.md)", file=sys.stderr)
                    return 1
                continue
            if not table_exists(tgt, table):
                print(f"  skip {table}: not in the target schema (no db/schema file creates it)")
                continue
            tables.append(table)

        print("copy")
        with tgt.transaction():
            tgt.execute(sql.SQL("TRUNCATE {} CASCADE").format(sql.SQL(", ").join(map(sql.Identifier, tables))))
            for table in tables:
                source_cols = set(copy_columns(src, table))
                cols = [c for c in copy_columns(tgt, table) if c in source_cols]
                col_list = sql.SQL(", ").join(map(sql.Identifier, cols))
                t0 = time.monotonic()
                with src.cursor().copy(sql.SQL("COPY (SELECT {} FROM {}) TO STDOUT").format(
                        col_list, sql.Identifier(table))) as out, \
                        tgt.cursor().copy(sql.SQL("COPY {} ({}) FROM STDIN").format(
                            sql.Identifier(table), col_list)) as into:
                    for chunk in out:
                        into.write(chunk)
                # Identity columns: continue after the copied ids (the refresh job inserts new rows).
                for (col,) in tgt.execute(
                        "SELECT attname FROM pg_attribute WHERE attrelid = %s::regclass AND attidentity <> ''",
                        (f"public.{table}",)).fetchall():
                    tgt.execute(sql.SQL(
                        "SELECT setval(pg_get_serial_sequence(%s, %s), coalesce(max({c}), 0) + 1, false) FROM {t}"
                    ).format(c=sql.Identifier(col), t=sql.Identifier(table)), (f"public.{table}", col))
                n_src, n_tgt = count(src, table), count(tgt, table)
                flag = "" if n_src == n_tgt else "  MISMATCH"
                print(f"  {table:<22} {n_tgt:>8,} rows  ({time.monotonic() - t0:.1f}s){flag}")
                if flag:
                    raise SystemExit(f"row count mismatch in {table}: source {n_src}, target {n_tgt}")
        src.rollback()

        for table in tables:
            tgt.execute(sql.SQL("ANALYZE {}").format(sql.Identifier(table)))
        size = tgt.execute("SELECT pg_size_pretty(pg_database_size(current_database()))").fetchone()[0]
    print(f"done in {time.monotonic() - started:.0f}s; target database size {size}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
