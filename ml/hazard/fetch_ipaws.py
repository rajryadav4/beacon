"""Download real emergency alerts from the OpenFEMA IPAWS archive.

Source: OpenFEMA `IpawsArchivedAlerts` (https://www.fema.gov/api/open/v1/IpawsArchivedAlerts),
about 4.9 million CAP messages since 2012. We take a varied sample, not the whole archive:

- one query plan per EAS/SAME event code in `SAME_CODE_HAZARD` (real hazards only),
  plus a few codes we saw in the archive that the map does not cover (FZW, SPS, ...),
  plus NWS products that carry the generic SAME code `NWS` (air quality, ashfall,
  tsunami advisories, ...), queried by event name;
- a code with at most `--cap` alerts is fetched whole; a bigger one is sampled over
  yearly windows from 2012 to today, at two random offsets per window, so every year
  is in the sample and not only the first days of each window.

Only `status eq 'Actual'` messages. One output row per CAP <info> block (an alert can
have an English and a Spanish block), saved to data/ipaws/alerts.jsonl.gz (git-ignored).
Each plan is also cached in data/ipaws/plans/ so an interrupted run resumes.

Usage, from the repository root:

    SSL_CERT_FILE=$(.venv/bin/python -m certifi) .venv/bin/python ml/hazard/fetch_ipaws.py
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import http.client
import json
import math
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "api"))
from app.hazard_taxonomy import SAME_CODE_HAZARD  # noqa: E402

API = "https://www.fema.gov/api/open/v1/IpawsArchivedAlerts"
USER_AGENT = "beacon-dev/0.1 (+https://github.com/rajryadav4/beacon)"
OUT_DIR = ROOT / "data" / "ipaws"
SELECT = "identifier,sent,sender,status,msgType,info"
FIRST_YEAR = 2012
PAGE = 1000

# SAME codes seen in the archive that SAME_CODE_HAZARD does not map. We fetch a small
# sample of each so the training script can report them; they get no label from the code.
UNMAPPED_CODES = ["FZW", "FZA", "WCA", "HFW", "HFA", "LSW", "MEP", "SAB", "SPS", "MWS", "SVW"]

# NWS products sent with the generic SAME code "NWS". Queried by event name; labelled
# later from the event name (hazard_from_event_name), since the SAME code says nothing.
NWS_EVENTS = [
    "Ashfall Advisory", "Dense Smoke Advisory", "Air Stagnation Advisory",
    "Tsunami Advisory", "Tsunami Watch", "Earthquake Warning",
    "Hazardous Materials Warning", "Radiological Hazard Warning", "Nuclear Power Plant Warning",
    "Shelter In Place Warning", "Evacuation Immediate", "Freeze Warning", "Wind Chill Advisory",
    "Hydrologic Outlook", "Red Flag Warning", "Heat Advisory", "Dust Storm Warning",
]


def get_json(params: dict, retries: int = 8) -> dict:
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                return json.load(resp)
        except (OSError, http.client.HTTPException, json.JSONDecodeError) as exc:  # URLError, timeouts, resets
            if isinstance(exc, urllib.error.HTTPError) and exc.code == 400:
                raise
            wait = min(60, 2 ** attempt)  # OpenFEMA answers 503 under load
            print(f"  retry in {wait}s: {exc}", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"giving up on {url}")


def count(flt: str) -> int:
    body = get_json({"$top": 1, "$select": "identifier", "$filter": flt, "$inlinecount": "allpages"})
    return int(body["metadata"]["count"])


def fetch(flt: str, top: int, skip: int = 0) -> list[dict]:
    rows: list[dict] = []
    while len(rows) < top:
        n = min(PAGE, top - len(rows))
        body = get_json({"$top": n, "$skip": skip + len(rows), "$select": SELECT, "$filter": flt})
        page = body.get("IpawsArchivedAlerts", [])
        rows.extend(page)
        if len(page) < n:
            break
    return rows


def windows(until: dt.date) -> list[tuple[str, str]]:
    out = []
    for year in range(FIRST_YEAR, until.year + 1):
        out.append((f"{year}-01-01", f"{year + 1}-01-01"))
    return out


def run_plan(name: str, base_filter: str, cap: int, rng: random.Random) -> list[dict]:
    flt = f"{base_filter} and status eq 'Actual'"
    total = count(flt)
    if total <= cap:
        return fetch(flt, total)
    wins = windows(dt.date.today())
    per_window = math.ceil(cap / len(wins))
    rows: list[dict] = []
    failed = 0
    for start, end in wins:
        wflt = f"{flt} and sent ge '{start}' and sent lt '{end}'"
        try:
            n = count(wflt)
            if n == 0:
                continue
            if n <= per_window:
                rows.extend(fetch(wflt, n))
                continue
            half = math.ceil(per_window / 2)
            offsets = sorted(rng.sample(range(0, max(1, n - half)), k=min(2, max(1, n - half))))
            for off in offsets:
                rows.extend(fetch(wflt, half, skip=off))
        except RuntimeError as exc:  # heavy windows can keep timing out (503); skip them
            failed += 1
            print(f"  {name}: skipped window {start}: {exc}", file=sys.stderr, flush=True)
    note = f", {failed} windows skipped" if failed else ""
    print(f"  {name}: {total:,} in archive, sampled {len(rows):,}{note}", flush=True)
    return rows


def param(info: dict, name: str) -> str | None:
    # The archive renamed `parameters` to `parameter` for messages sent from 2023 on.
    for p in info.get("parameters") or info.get("parameter") or []:
        if p.get("name") == name:
            return p.get("value")
    return None


def extract(alert: dict) -> list[dict]:
    """One flat row per CAP <info> block."""
    rows = []
    for k, info in enumerate(alert.get("info") or []):
        codes = info.get("eventCode") or []
        same = next((c.get("value") for c in codes if c.get("name") == "SAME"), None)
        nws = next((c.get("value") for c in codes if c.get("name") == "NationalWeatherService"), None)
        rows.append({
            "id": f"{alert.get('identifier')}#{k}",
            "identifier": alert.get("identifier"),
            "sent": alert.get("sent"),
            "sender": alert.get("sender"),
            "senderName": info.get("senderName"),
            "msgType": alert.get("msgType"),
            "language": info.get("language"),
            "eventCode": same,
            "nwsCode": nws,
            "event": info.get("event"),
            "headline": info.get("headline"),
            "description": info.get("description"),
            "instruction": info.get("instruction"),
            "weaText": param(info, "CMAMtext"),
            "weaLongText": param(info, "CMAMlongtext"),
            "severity": info.get("severity"),
            "urgency": info.get("urgency"),
            "certainty": info.get("certainty"),
            "category": info.get("category"),
        })
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cap", type=int, default=2000, help="max alerts per mapped SAME code (default 2000)")
    parser.add_argument("--unmapped-cap", type=int, default=300, help="max alerts per unmapped code")
    parser.add_argument("--event-cap", type=int, default=1500, help="max alerts per NWS event name")
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    plans: list[tuple[str, str, int]] = []
    for code, hazard in SAME_CODE_HAZARD.items():
        if hazard is not None:
            plans.append((f"same-{code}", f"info/eventCode/value eq '{code}'", args.cap))
    for code in UNMAPPED_CODES:
        plans.append((f"same-{code}", f"info/eventCode/value eq '{code}'", args.unmapped_cap))
    for event in NWS_EVENTS:
        slug = event.lower().replace(" ", "-")
        plans.append((f"event-{slug}", f"info/event eq '{event}'", args.event_cap))

    plan_dir = OUT_DIR / "plans"
    plan_dir.mkdir(parents=True, exist_ok=True)

    def work(plan: tuple[str, str, int]) -> None:
        name, flt, cap = plan
        path = plan_dir / f"{name}.jsonl.gz"
        if path.exists():
            return
        rng = random.Random(f"{args.seed}-{name}")
        try:
            alerts = run_plan(name, flt, cap, rng)
        except Exception as exc:  # leave no file, so the next run retries this plan
            print(f"  {name}: FAILED, rerun to retry: {exc}", flush=True)
            return
        tmp = path.with_suffix(".tmp")
        with gzip.open(tmp, "wt", encoding="utf-8") as fh:
            for alert in alerts:
                for row in extract(alert):
                    fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        tmp.rename(path)

    started = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for _ in pool.map(work, plans):
            pass

    seen: set[str] = set()
    n = 0
    out = OUT_DIR / "alerts.jsonl.gz"
    with gzip.open(out, "wt", encoding="utf-8") as fh:
        for path in sorted(plan_dir.glob("*.jsonl.gz")):
            with gzip.open(path, "rt", encoding="utf-8") as src:
                for line in src:
                    row = json.loads(line)
                    if row["id"] in seen:
                        continue
                    seen.add(row["id"])
                    fh.write(line)
                    n += 1
    print(f"wrote {n:,} info blocks to {out.relative_to(ROOT)} in {time.time() - started:.0f}s")


if __name__ == "__main__":
    main()
