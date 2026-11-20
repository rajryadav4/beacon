"""Import the ML risk model output into PostgreSQL.

Reads ml/output/metrics.json and ml/output/cell_risk.csv (written by
ml/train_risk_model.py) and stores them as one model run in model_runs plus one
row per cell and time band in cell_risk_scores, on the class app's grid
(cell_id = row * 100 + col). The new run becomes the active one.

Usage, from the repository root:

    python pipeline/import_risk.py
    python pipeline/import_risk.py --dir ml/output
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pg import ROOT, connect  # noqa: E402

DEFAULT_DIR = ROOT / "ml" / "output"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dir", type=Path, default=DEFAULT_DIR)
    args = parser.parse_args()

    metrics = json.loads((args.dir / "metrics.json").read_text())
    meta = metrics.get("metaModel", {})
    version = meta.get("version") or "risk-" + metrics["generatedAt"][:10]
    algorithm = meta.get("algorithm", "unknown")

    with (args.dir / "cell_risk.csv").open(newline="") as f:
        rows = [(version, int(r["cell_id"]), int(r["band"]), float(r["expected_risk"]), r["level"])
                for r in csv.DictReader(f)]

    with connect() as conn, conn.cursor() as cur:
        cur.execute("UPDATE model_runs SET is_active = false WHERE is_active")
        cur.execute(
            """INSERT INTO model_runs (model_version, trained_at, algorithm, metrics, is_active)
               VALUES (%s, %s, %s, %s, true)
               ON CONFLICT (model_version) DO UPDATE
               SET trained_at = EXCLUDED.trained_at, algorithm = EXCLUDED.algorithm,
                   metrics = EXCLUDED.metrics, is_active = true""",
            (version, metrics["generatedAt"], algorithm, json.dumps(metrics)),
        )
        cur.execute("DELETE FROM cell_risk_scores WHERE model_version = %s", (version,))
        with cur.copy("COPY cell_risk_scores (model_version, cell_id, time_band, expected_risk, level)"
                      " FROM STDIN") as copy:
            for row in rows:
                copy.write_row(row)
        cur.execute("""SELECT count(DISTINCT cell_id), count(*), level, count(*)
                       FROM cell_risk_scores WHERE model_version = %s GROUP BY ROLLUP (level)
                       ORDER BY level NULLS FIRST""", (version,))
        result = cur.fetchall()
    total = result[0]
    print(f"Model {version} ({algorithm}): {total[1]:,} cell-band scores over {total[0]:,} cells")
    for _, _, level, count in result[1:]:
        print(f"  {level:<9} {count:>6,} ({count / total[1]:.1%})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
