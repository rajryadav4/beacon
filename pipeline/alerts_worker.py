"""Alerts worker: keeps the alert tables fresh on a schedule.

    .venv/bin/python pipeline/alerts_worker.py              # NWS 2 min, USGS 1 min, Seattle Fire 5 min, IPAWS 60 min
    .venv/bin/python pipeline/alerts_worker.py --area OR --sources nws,usgs

A plain loop, no scheduler dependency: each feed has its own interval, and a
failing feed backs off exponentially (up to 30 min) without holding up the
others. A lost database connection is reopened on the next tick. Stop with Ctrl+C.
"""

from __future__ import annotations

import logging
import signal
import time

from pg import connect

import alerts_sources as src
from ingest_alerts import SOURCES, apply_schema, build_parser, ingest_source, parse_point, record_status

log = logging.getLogger("beacon.alerts.worker")

INTERVALS = {"usgs": 60, "nws": 120, "seattle_fire": 300, "ipaws": 3600}  # seconds
MAX_BACKOFF = 1800
TICK = 5


class Feed:
    def __init__(self, name: str, interval: int):
        self.name, self.interval = name, interval
        self.next_run = 0.0
        self.failures = 0

    def done(self, ok: bool) -> None:
        self.failures = 0 if ok else self.failures + 1
        delay = self.interval if ok else min(MAX_BACKOFF, self.interval * 2 ** self.failures)
        self.next_run = time.monotonic() + delay


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # request URLs can carry a --point
    ap =build_parser(__doc__.splitlines()[0])
    for name, seconds in INTERVALS.items():
        ap.add_argument(f"--every-{name.replace('_', '-')}", type=int, default=seconds, dest=f"every_{name}",
                        help=f"{name} interval in seconds (default {seconds})")
    args = ap.parse_args()
    names = [s.strip() for s in args.sources.split(",") if s.strip() in SOURCES]
    feeds = [Feed(n, getattr(args, f"every_{n}")) for n in names]
    kwargs = dict(area=args.area, point=parse_point(args.point),
                  ipaws_days=args.ipaws_days, fire_hours=args.fire_hours)

    stop = False

    def _stop(*_):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    conn = None
    schema_ready = False
    log.info("alerts worker: %s", ", ".join(f"{f.name} every {f.interval}s" for f in feeds))
    with src.http_client() as client:
        while not stop:
            now = time.monotonic()
            for feed in feeds:
                if stop or feed.next_run > now:
                    continue
                try:
                    if conn is None or conn.closed:
                        conn = connect()
                        schema_ready = False
                    if not schema_ready:
                        apply_schema(conn)
                        schema_ready = True
                    summary = ingest_source(conn, client, feed.name, **kwargs)
                    log.info("%s", summary)
                    feed.done(True)
                except Exception as exc:
                    log.warning("%s failed (%s: %s); retry with backoff", feed.name, type(exc).__name__, exc)
                    feed.done(False)
                    try:
                        conn.rollback()
                        record_status(conn, feed.name, False, error=f"{type(exc).__name__}: {exc}")
                        conn.commit()
                    except Exception:
                        try:
                            conn.close()
                        except Exception:
                            pass
                        conn = None
            time.sleep(TICK)
    if conn is not None:
        conn.close()
    log.info("alerts worker stopped")


if __name__ == "__main__":
    main()
