"""Official alert and 911 feeds: fetch and parse (no database here).

Each parser turns one feed payload into plain dicts whose keys match the
`alerts` table (db/schema/004_alerts.sql) or `emergency_calls`, with geometry
as a GeoJSON dict. pipeline/ingest_alerts.py writes them to Postgres.

Feeds:
  nws    api.weather.gov/alerts/active (CAP as GeoJSON), default area WA
  usgs   earthquake.usgs.gov summary feed, M2.5+ in the past day, worldwide
  ipaws  OpenFEMA IpawsArchivedAlerts (CAP from IPAWS-OPEN, archived with a delay)
  seattle_fire  data.seattle.gov kzjm-xkqj, Seattle Fire real-time 911 dispatches
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.alerts_rules import (  # noqa: E402
    QUAKE_IMMEDIATE_HOURS,
    hide_call,
    quake_expires_hours,
    quake_radius_km,
    quake_severity,
    resolve_hazard,
)

# Requests carry a project User-Agent only (NWS requires one); never a personal name or email.
USER_AGENT = "beacon-dev/0.1 (+https://github.com/rajryadav4/beacon)"

NWS_ALERTS_URL = "https://api.weather.gov/alerts/active"
USGS_FEED_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson"
IPAWS_URL = "https://www.fema.gov/api/open/v1/IpawsArchivedAlerts"
SEATTLE_FIRE_URL = "https://data.seattle.gov/resource/kzjm-xkqj.json"
SEATTLE_FIRE_DATASET = "kzjm-xkqj"

# Washington State, generous box (west, south, east, north) for the IPAWS geo filter.
WA_BBOX = (-124.9, 45.5, -116.9, 49.1)
SEATTLE_TZ = ZoneInfo("America/Los_Angeles")

# NWS products that are not hazards (tests, keep-alives, admin).
NWS_SKIP_CODES = {"TST", "KEPA", "ADR", "DMO", "RMT", "RWT", "NPT", "NMN"}
SKIP_STATUSES = {"Test", "Draft"}
# NWS-originated IPAWS messages duplicate the NWS feed.
NWS_SENDERS = {"w-nws.webmaster@noaa.gov"}


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _clean(text: str | None) -> str | None:
    if text is None:
        return None
    text = text.strip()
    return text or None


def _text_for_model(*parts: str | None) -> str:
    return "\n".join(p for p in parts if p)


def http_client():
    import httpx

    return httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=60, follow_redirects=True)


# ---- NWS -------------------------------------------------------

def nws_feed_key(area: str | None = None, point: tuple[float, float] | None = None) -> str:
    if point:
        return f"point={point[0]:.4f},{point[1]:.4f}"
    return f"area={(area or 'WA').upper()}"


def fetch_nws(client, area: str | None = "WA", point: tuple[float, float] | None = None) -> dict:
    params = {"point": f"{point[0]:.4f},{point[1]:.4f}"} if point else {"area": (area or "WA").upper()}
    r = client.get(NWS_ALERTS_URL, params=params, headers={"Accept": "application/geo+json"})
    r.raise_for_status()
    return r.json()


def parse_nws(collection: dict, feed: str, classifier=...) -> list[dict]:
    """NWS active alerts (GeoJSON FeatureCollection of CAP alerts) -> alert rows."""
    rows = []
    for feature in collection.get("features") or []:
        p = feature.get("properties") or {}
        if p.get("status") in SKIP_STATUSES:
            continue
        codes = p.get("eventCode") or {}
        same = [c for c in codes.get("SAME", []) if c and c.upper() != "NWS"]
        nws = codes.get("NationalWeatherService", [])
        if {c.upper() for c in same + nws} & NWS_SKIP_CODES:
            continue
        event = p.get("event")
        if event and "test" in event.lower().split():
            continue
        headline = _clean(p.get("headline")) or _clean((p.get("parameters") or {}).get("NWSheadline", [None])[0])
        description = _clean(p.get("description"))
        kwargs = {} if classifier is ... else {"classifier": classifier}
        hazard, classified_by, confidence = resolve_hazard(
            same + nws, event, _text_for_model(event, headline, description), **kwargs)
        geometry = feature.get("geometry")
        rows.append({
            "source": "nws",
            "source_id": p.get("id") or feature.get("id"),
            "feed": feed,
            "event": event,
            "event_code": (same or nws or [None])[0],
            "hazard": hazard,
            "classified_by": classified_by,
            "confidence": confidence,
            "severity": p.get("severity"),
            "urgency": p.get("urgency"),
            "certainty": p.get("certainty"),
            "status": p.get("status"),
            "msg_type": p.get("messageType"),
            "headline": headline,
            "description": description,
            "instruction": _clean(p.get("instruction")),
            "area_desc": p.get("areaDesc"),
            "sender": p.get("senderName") or p.get("sender"),
            "sent": parse_time(p.get("sent")),
            "effective": parse_time(p.get("effective")),
            "onset": parse_time(p.get("onset")),
            "expires": parse_time(p.get("expires")),
            "ends": parse_time(p.get("ends")),
            "url": p.get("@id") or feature.get("id"),
            "magnitude": None,
            "radius_km": None,
            "geometry": geometry if geometry and geometry.get("type") in ("Polygon", "MultiPolygon") else None,
            "zones": list(p.get("affectedZones") or []),
            "point": None,
            "refs": [r.get("identifier") for r in p.get("references") or [] if r.get("identifier")],
            "raw": {"id": feature.get("id"), "properties": p},
        })
    return rows


def fetch_zone(client, url: str) -> dict | None:
    """One NWS zone (GeoJSON Feature); None when the zone does not exist."""
    r = client.get(url, headers={"Accept": "application/geo+json"})
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def parse_zone(url: str, feature: dict | None) -> dict:
    p = (feature or {}).get("properties") or {}
    geometry = (feature or {}).get("geometry")
    if geometry and geometry.get("type") == "GeometryCollection":
        polys = [g for g in geometry.get("geometries", []) if g.get("type") in ("Polygon", "MultiPolygon")]
        geometry = {"type": "GeometryCollection", "geometries": polys} if polys else None
    elif geometry and geometry.get("type") not in ("Polygon", "MultiPolygon"):
        geometry = None
    return {"zone_url": url, "zone_id": p.get("id") or url.rstrip("/").rsplit("/", 1)[-1],
            "zone_type": p.get("type"), "name": p.get("name"), "state": p.get("state"),
            "geometry": geometry}


# ---- USGS earthquakes -------------------------------------------

QUAKE_INSTRUCTION = (
    "If you feel shaking: Drop, Cover, and Hold On. Expect aftershocks. "
    "Stay away from damaged buildings, downed power lines and broken gas lines. "
    "Near the coast, if shaking was strong or long, move to high ground right away."
)


def fetch_usgs(client, url: str = USGS_FEED_URL) -> dict:
    r = client.get(url)
    r.raise_for_status()
    return r.json()


def parse_usgs(collection: dict, now: datetime | None = None) -> list[dict]:
    """USGS summary GeoJSON -> earthquake alert rows (point + magnitude-based radius)."""
    now = now or datetime.now(timezone.utc)
    rows = []
    for feature in collection.get("features") or []:
        p = feature.get("properties") or {}
        geometry = feature.get("geometry") or {}
        if p.get("type") not in (None, "earthquake") or p.get("status") == "deleted":
            continue
        coords = geometry.get("coordinates") or []
        if len(coords) < 2 or p.get("time") is None:
            continue
        lng, lat = float(coords[0]), float(coords[1])
        depth = float(coords[2]) if len(coords) > 2 and coords[2] is not None else None
        mag = float(p["mag"]) if p.get("mag") is not None else None
        origin = datetime.fromtimestamp(p["time"] / 1000, tz=timezone.utc)
        severity = quake_severity(mag)
        recent = now - origin <= timedelta(hours=QUAKE_IMMEDIATE_HOURS)
        place = p.get("place") or "unknown location"
        mag_text = f"M{mag:.1f}" if mag is not None else "Earthquake"
        details = [f"A magnitude {mag:.1f} earthquake" if mag is not None else "An earthquake",
                   f"occurred {place} at {origin:%Y-%m-%d %H:%M} UTC"]
        if depth is not None:
            details.append(f"at a depth of {depth:.0f} km")
        description = " ".join(details) + "."
        if p.get("tsunami"):
            description += (" USGS flags this event for possible tsunami relevance;"
                            " check tsunami.gov and official warnings.")
        if p.get("alert"):
            description += f" USGS PAGER impact alert level: {p['alert']}."
        rows.append({
            "source": "usgs",
            "source_id": str(feature.get("id") or (p.get("net", "") + p.get("code", ""))),
            "feed": "2.5_day",
            "event": "Earthquake",
            "event_code": "EQW",
            "hazard": "earthquake",
            "classified_by": "source",
            "confidence": None,
            "severity": severity,
            "urgency": "Immediate" if recent else "Past",
            "certainty": "Observed",
            "status": "Actual",
            "msg_type": "Alert",
            "headline": p.get("title") or f"{mag_text} - {place}",
            "description": description,
            "instruction": QUAKE_INSTRUCTION if (mag or 0) >= 4 else None,
            "area_desc": place,
            "sender": "U.S. Geological Survey",
            "sent": origin,
            "effective": origin,
            "onset": origin,
            "expires": origin + timedelta(hours=quake_expires_hours(mag)),
            "ends": None,
            "url": p.get("url"),
            "magnitude": round(mag, 2) if mag is not None else None,
            "radius_km": quake_radius_km(mag),
            "geometry": None,
            "zones": None,
            "point": (lng, lat),
            "refs": [],
            "raw": {"id": feature.get("id"), "properties": p, "geometry": geometry},
        })
    return rows


# ---- FEMA IPAWS (OpenFEMA archive) ---------------------------------

def fetch_ipaws(client, days: int = 7, bbox: tuple[float, float, float, float] = WA_BBOX,
                now: datetime | None = None, page_size: int = 200, max_pages: int = 10) -> list[dict]:
    """IPAWS archived alerts sent in the last `days` days whose area intersects `bbox`."""
    now = now or datetime.now(timezone.utc)
    since = (now - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    w, s, e, n = bbox
    polygon = f"POLYGON(({w} {s},{e} {s},{e} {n},{w} {n},{w} {s}))"
    records: list[dict] = []
    for page in range(max_pages):
        r = client.get(IPAWS_URL, params={
            "$filter": f"sent ge '{since}' and geo.intersects(searchGeometry, geography'{polygon}')",
            "$orderby": "sent desc", "$top": str(page_size), "$skip": str(page * page_size),
        }, timeout=120)
        r.raise_for_status()
        batch = r.json().get("IpawsArchivedAlerts") or []
        records.extend(batch)
        if len(batch) < page_size:
            break
    return records


def _pick_info(infos: list[dict]) -> dict | None:
    for info in infos:
        if (info.get("language") or "en-US").lower().startswith("en"):
            return info
    return infos[0] if infos else None


def _params(info: dict) -> dict[str, str]:
    out: dict[str, str] = {}
    for param in info.get("parameter") or []:
        out.setdefault(param.get("name"), param.get("value"))
    return out


def parse_ipaws(records: list[dict], classifier=...) -> list[dict]:
    """OpenFEMA IpawsArchivedAlerts records -> alert rows (English info block, area polygons)."""
    rows = []
    for x in records:
        if x.get("status") in SKIP_STATUSES or (x.get("sender") or "").lower() in NWS_SENDERS:
            continue
        info = _pick_info(x.get("info") or [])
        if not info:
            continue
        codes = [c.get("value") for c in info.get("eventCode") or [] if c.get("name") == "SAME"]
        if {(c or "").upper() for c in codes} & NWS_SKIP_CODES:
            continue
        event = info.get("event")
        if event and ("test" in event.lower().split() or "administrative" in event.lower()):
            continue
        params = _params(info)
        headline = _clean(info.get("headline")) or _clean(params.get("CMAMtext"))
        description = _clean(info.get("description")) or _clean(params.get("CMAMlongtext"))
        kwargs = {} if classifier is ... else {"classifier": classifier}
        hazard, classified_by, confidence = resolve_hazard(
            codes, event, _text_for_model(headline, description), **kwargs)

        polygons = []
        areas = info.get("area") or []
        for area in areas:
            poly = area.get("polygon")
            if isinstance(poly, dict) and poly.get("type") in ("Polygon", "MultiPolygon"):
                polygons.append(poly)
        if polygons:
            geometry = (polygons[0] if len(polygons) == 1
                        else {"type": "GeometryCollection", "geometries": polygons})
        else:
            sg = x.get("searchGeometry")
            geometry = sg if isinstance(sg, dict) and sg.get("type") in ("Polygon", "MultiPolygon") else None

        refs = []
        for ref in (x.get("references") or "").split():
            parts = ref.split(",")
            if len(parts) >= 2:
                refs.append(parts[1])
        raw = {k: v for k, v in x.items() if k not in ("searchGeometry", "originalMessage")}
        rows.append({
            "source": "ipaws",
            "source_id": x.get("identifier") or x.get("id"),
            "feed": "openfema",
            "event": event,
            "event_code": (codes or [None])[0],
            "hazard": hazard,
            "classified_by": classified_by,
            "confidence": confidence,
            "severity": info.get("severity"),
            "urgency": info.get("urgency"),
            "certainty": info.get("certainty"),
            "status": x.get("status"),
            "msg_type": x.get("msgType"),
            "headline": headline,
            "description": description,
            "instruction": _clean(info.get("instruction")),
            "area_desc": "; ".join(a.get("areaDesc") for a in areas if a.get("areaDesc")) or None,
            "sender": info.get("senderName") or x.get("sender"),
            "sent": parse_time(x.get("sent")),
            "effective": parse_time(info.get("effective")),
            "onset": parse_time(info.get("onset")),
            "expires": parse_time(info.get("expires")),
            "ends": None,
            "url": _clean(info.get("web")),
            "magnitude": None,
            "radius_km": None,
            "geometry": geometry,
            "zones": None,
            "point": None,
            "refs": refs,
            "raw": raw,
        })
    return rows


# ---- Seattle Fire real-time 911 --------------------------------------

def fetch_seattle_fire(client, hours: int = 6, now: datetime | None = None, limit: int = 2000) -> list[dict]:
    now = now or datetime.now(timezone.utc)
    since = (now - timedelta(hours=hours)).astimezone(SEATTLE_TZ).strftime("%Y-%m-%dT%H:%M:%S")
    r = client.get(SEATTLE_FIRE_URL, params={
        "$where": f"datetime > '{since}'", "$order": "datetime DESC", "$limit": str(limit)})
    r.raise_for_status()
    return r.json()


def parse_seattle_fire(rows: list[dict]) -> list[dict]:
    """Seattle Fire dispatch rows -> emergency_calls rows. Times are Seattle local time."""
    calls = []
    for row in rows:
        number, when = row.get("incident_number"), row.get("datetime")
        try:
            lat, lng = float(row["latitude"]), float(row["longitude"])
        except (KeyError, TypeError, ValueError):
            lat = lng = None
        if not number or not when:
            continue
        local = datetime.fromisoformat(when.replace("Z", ""))
        call_time = local.replace(tzinfo=SEATTLE_TZ) if local.tzinfo is None else local
        calls.append({
            "source_call_id": number,
            "call_time": call_time,
            "call_type": (row.get("type") or "").strip()[:150] or None,
            "lat": lat,
            "lng": lng,
            "hidden": hide_call(row.get("type")),
        })
    return calls
