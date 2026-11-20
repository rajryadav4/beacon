"""Hazard outlook sources: parsers and rules. Pure functions on downloaded payloads,
no network or database (pipeline/outlook_worker.py fetches and stores).

Every parser returns outlook items:

    {"id", "hazard", "level", "title", "summary", "valid_from", "valid_to",
     "sources": [{"name", "url", "observed"}], "confidence",
     "geometry": GeoJSON (Multi)Polygon in EPSG:4326,
     "zones": optional list of hazard_zones kinds: when given, the item's area is
              those mapped zones inside `geometry` (e.g. tsunami inundation zones),
     "group": optional; of items with the same group only the most serious one
              that touches the region is kept (nested outlook polygons)}

Levels: watch (possible), likely (expected / forecast to cross an official
threshold), imminent (official warning or already happening). Model-only
forecasts never go above "likely". Earthquakes are never forecast: the only
earthquake item is the aftershock notice after a large quake, as published by USGS.
"""

from __future__ import annotations

import importlib.util
import math
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("hazard_taxonomy", ROOT / "apps" / "api" / "app" / "hazard_taxonomy.py")
taxonomy = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(taxonomy)

HORIZON = timedelta(hours=72)
LEVEL_RANK = {"watch": 1, "likely": 2, "imminent": 3}
CONFIDENCE_RANK = {"low": 1, "medium": 2, "high": 3}


# ---- geometry helpers -----------------------------------------------------------

def utc(text: str | None) -> datetime | None:
    if not text:
        return None
    text = text.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def bbox_polygon(bbox) -> dict:
    w, s, e, n = bbox
    return {"type": "Polygon", "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}


def circle_polygon(lng: float, lat: float, radius_km: float, steps: int = 32) -> dict:
    """Approximate circle (good enough for a 'near this point' area)."""
    ring = []
    for i in range(steps + 1):
        a = 2 * math.pi * (i % steps) / steps
        dlat = radius_km / 111.32 * math.sin(a)
        dlng = radius_km / (111.32 * max(math.cos(math.radians(lat)), 0.01)) * math.cos(a)
        ring.append([round(lng + dlng, 5), round(lat + dlat, 5)])
    return {"type": "Polygon", "coordinates": [ring]}


def haversine_km(lng1, lat1, lng2, lat2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(min(1.0, a)))


def km_to_bbox(lng: float, lat: float, bbox) -> float:
    """Distance from a point to the nearest edge of the box (0 inside)."""
    w, s, e, n = bbox
    return haversine_km(lng, lat, min(max(lng, w), e), min(max(lat, s), n))


def bbox_center(bbox) -> tuple[float, float]:
    w, s, e, n = bbox
    return (w + e) / 2, (s + n) / 2


def representative_point(geometry: dict) -> tuple[float, float] | None:
    """A point of a GeoJSON geometry: the point itself, or the mean of the outer ring."""
    if not geometry:
        return None
    t, c = geometry.get("type"), geometry.get("coordinates")
    if t == "Point":
        return float(c[0]), float(c[1])
    if t == "Polygon":
        ring = c[0]
    elif t == "MultiPolygon":
        ring = c[0][0]
    elif t in ("LineString", "MultiPoint"):
        ring = c
    else:
        return None
    return sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)


def item(source: str, ident: str, hazard: str, level: str, title: str, summary: str, valid_from: datetime,
         valid_to: datetime, sources: list[dict], confidence: str, geometry: dict, zones=None, group=None) -> dict:
    assert hazard in taxonomy.HAZARDS and level in LEVEL_RANK and confidence in CONFIDENCE_RANK
    return {"id": f"{source}:{ident}"[:120], "source": source, "hazard": hazard, "level": level,
            "title": title[:255], "summary": summary, "valid_from": valid_from, "valid_to": valid_to,
            "sources": sources, "confidence": confidence, "geometry": geometry, "zones": zones, "group": group}


# ---- NASA EONET ---------------------------------------------------------------------

# category -> (hazard, max km from the region, level inside the region, level nearby, area radius km)
EONET_RULES = {
    "wildfires": ("wildfire", 40, "imminent", "watch", 15),
    "volcanoes": ("volcano", 350, "imminent", "watch", None),   # ashfall can reach the whole region
    "severeStorms": ("storm", 300, "likely", "watch", 150),
    "floods": ("flood", 50, "imminent", "watch", None),
    "snow": ("winter", 100, "likely", "watch", 50),
    "dustHaze": ("air_quality", 150, "likely", "watch", 60),
    "manmade": ("hazmat", 10, "imminent", "watch", 5),
}


def parse_eonet(payload: dict, bbox, now: datetime, max_age_days: int = 10) -> list[dict]:
    """Open EONET events near the region. Prescribed fires are skipped (planned and controlled;
    their smoke is caught by the air-quality forecast). Earthquake events are never turned into
    a forecast."""
    out = []
    for ev in payload.get("events", []):
        cats = [c.get("id") for c in ev.get("categories", [])]
        cat = next((c for c in cats if c in EONET_RULES), None)
        geoms = ev.get("geometry") or []
        if not cat or not geoms or ev.get("closed"):
            continue
        title = ev.get("title") or "Natural event"
        if cat == "wildfires" and "prescribed" in title.lower():
            continue
        latest = max(geoms, key=lambda g: g.get("date") or "")
        when = utc(latest.get("date"))
        if not when or now - when > timedelta(days=max_age_days):
            continue
        pt = representative_point(latest)
        if not pt:
            continue
        hazard, max_km, level_in, level_near, radius = EONET_RULES[cat]
        dist = km_to_bbox(pt[0], pt[1], bbox)
        if dist > max_km:
            continue
        level = level_in if dist == 0 else level_near
        if radius is None:
            # Volcano: ash can fall anywhere in the region. Flood: the mapped flood zones.
            geometry, zones = bbox_polygon(bbox), (["flood_zone"] if hazard == "flood" else None)
        else:
            geometry = latest if latest.get("type") in ("Polygon", "MultiPolygon") else circle_polygon(pt[0], pt[1], radius)
            zones = None
        where = "inside the area" if dist == 0 else f"about {round(dist)} km from the area"
        summary = {
            "wildfire": f"NASA EONET reports an active wildfire {where} (last update {iso(when)}). "
                        "Be ready to leave if officials order evacuation; smoke may affect air quality.",
            "volcano": f"NASA EONET reports volcanic activity {where}. Depending on the wind, ash could fall here; "
                       "lahars follow river valleys that drain the volcano. Follow USGS and local officials.",
            "storm": f"NASA EONET tracks a severe storm {where}. Check the NWS forecast for your area.",
            "flood": f"NASA EONET reports flooding {where}. Avoid low ground and flooded roads.",
            "winter": f"NASA EONET reports a significant snow event {where}.",
            "air_quality": f"NASA EONET reports dust or haze {where}.",
            "hazmat": f"NASA EONET reports a man-made event {where}.",
        }[hazard]
        sources = [{"name": "NASA EONET", "url": ev.get("link") or "https://eonet.gsfc.nasa.gov/", "observed": iso(when)}]
        for s in ev.get("sources", [])[:2]:
            if s.get("url"):
                sources.append({"name": s.get("id") or "source", "url": s["url"], "observed": iso(when)})
        out.append(item("nasa-eonet", ev.get("id", title), hazard, level, title, summary, when,
                        now + timedelta(hours=24), sources, "medium", geometry, zones))
    return out


# ---- GDACS ---------------------------------------------------------------------------

# eventtype -> (hazard, max km, area radius km). Earthquakes (EQ) and droughts are skipped:
# quakes cannot be forecast (tsunami.gov covers tsunami threats) and drought is not a short-term hazard.
GDACS_RULES = {"TC": ("storm", 1000, 300), "FL": ("flood", 100, 50), "VO": ("volcano", 350, None),
               "WF": ("wildfire", 50, 15)}


def parse_gdacs(payload: dict, bbox, now: datetime) -> list[dict]:
    out = []
    for f in payload.get("features", []):
        p = f.get("properties", {})
        rule = GDACS_RULES.get(p.get("eventtype"))
        pt = representative_point(f.get("geometry"))
        if not rule or not pt or str(p.get("iscurrent", "true")).lower() != "true":
            continue
        hazard, max_km, radius = rule
        dist = km_to_bbox(pt[0], pt[1], bbox)
        alert = (p.get("alertlevel") or "Green").capitalize()
        if dist > max_km or (alert == "Green" and dist > 0):
            continue
        level = {"Red": "likely", "Orange": "watch"}.get(alert, "watch")
        to = utc(p.get("todate")) or now
        geometry = bbox_polygon(bbox) if radius is None else circle_polygon(pt[0], pt[1], radius)
        url = (p.get("url") or {}).get("report") or "https://www.gdacs.org/"
        title = p.get("name") or p.get("description") or "GDACS event"
        summary = (f"GDACS {alert} alert: {p.get('htmldescription') or title}. "
                   f"About {round(dist)} km from the area. GDACS rates likely humanitarian impact, not local conditions.")
        out.append(item("gdacs", f"{p.get('eventtype')}{p.get('eventid')}", hazard, level, title, summary,
                        utc(p.get("fromdate")) or now, max(to, now) + timedelta(hours=24),
                        [{"name": "GDACS", "url": url, "observed": p.get("datemodified")}],
                        "medium", geometry))
    return out


# ---- tsunami.gov ---------------------------------------------------------------------

ATOM = {"a": "http://www.w3.org/2005/Atom", "geo": "http://www.w3.org/2003/01/geo/wgs84_pos#"}
TSUNAMI_LEVEL = {"warning": "imminent", "advisory": "likely", "watch": "watch"}


def parse_tsunami_atom(xml_text: str | bytes) -> list[dict]:
    """Entries of a tsunami.gov Atom feed: category (Warning/Advisory/Watch/Information/Threat),
    title, updated, CAP and bulletin links."""
    root = ET.fromstring(xml_text)
    entries = []
    for e in root.findall("a:entry", ATOM):
        node = e.find("a:summary", ATOM)
        summary = " ".join(node.itertext()) if node is not None else ""
        m = re.search(r"Category:\s*([A-Za-z]+)", summary)
        links = {l.get("title"): l.get("href") for l in e.findall("a:link", ATOM)}
        entries.append({
            "id": (e.findtext("a:id", default="", namespaces=ATOM) or "").replace("urn:uuid:", ""),
            "title": e.findtext("a:title", default="", namespaces=ATOM).strip(),
            "updated": utc(e.findtext("a:updated", default="", namespaces=ATOM)),
            "category": (m.group(1) if m else "Information").strip(),
            "lat": e.findtext("geo:lat", namespaces=ATOM), "lng": e.findtext("geo:long", namespaces=ATOM),
            "cap": links.get("CapXML document"), "bulletin": links.get("Bulletin"),
            "no_threat": "NO tsunami danger" in summary or "no tsunami threat" in summary.lower(),
        })
    return entries


def cap_mentions_region(cap_xml: str | bytes, keywords=("washington", "puget sound", "WAZ", "PZZ13")) -> bool:
    """Does a tsunami CAP message's area mention the region (state name, Puget Sound or WA zone codes)?"""
    text = cap_xml.decode("utf-8", "replace") if isinstance(cap_xml, bytes) else cap_xml
    areas = " ".join(re.findall(r"<(?:\w+:)?(?:areaDesc|value)>([^<]*)<", text))
    low = areas.lower()
    return any(k.lower() in low if k.islower() else k in areas for k in keywords)


def tsunami_items(entries: list[dict], affects_region: dict[str, bool], bbox, now: datetime) -> list[dict]:
    """Warnings / advisories / watches whose CAP area includes the region -> items over the mapped
    tsunami inundation zones. Information statements never become items."""
    out = []
    for e in entries:
        level = TSUNAMI_LEVEL.get(e["category"].lower())
        if not level or e["no_threat"] or not affects_region.get(e["id"]):
            continue
        updated = e["updated"] or now
        if now - updated > timedelta(hours=24):
            continue
        what = {"imminent": "Tsunami WARNING", "likely": "Tsunami advisory", "watch": "Tsunami watch"}[level]
        summary = {
            "imminent": "A tsunami warning includes this area. Move to high ground or inland now, on foot if you can, "
                        "and stay away from the shore until officials say it is safe.",
            "likely": "A tsunami advisory includes this area: strong currents and waves are expected near the water. "
                      "Leave beaches, harbours and the waterfront.",
            "watch": "A tsunami watch includes this area: a tsunami is possible. Be ready to move to high ground.",
        }[level]
        out.append(item("tsunami-gov", e["id"], "tsunami", level, f"{what}: {e['title']}", summary, updated,
                        updated + timedelta(hours=12),
                        [{"name": "NOAA National Tsunami Warning Center", "url": e["bulletin"] or "https://www.tsunami.gov/",
                          "observed": iso(updated)}],
                        "high", bbox_polygon(bbox), zones=["tsunami_inundation"]))
    return out


# ---- NWS alerts ----------------------------------------------------------------------

MARINE_AREAS = {"AM", "AN", "GM", "LC", "LE", "LH", "LM", "LO", "LS", "PH", "PK", "PM", "PS", "PZ", "SL"}
CERTAINTY_CONFIDENCE = {"Observed": "high", "Likely": "high", "Possible": "medium", "Unlikely": "low"}


def nws_level(event: str, urgency: str, onset: datetime | None, now: datetime) -> str | None:
    """Watches/outlooks -> watch; advisories -> likely; warnings -> imminent when onset is within
    12 h, else likely. Immediate-urgency alerts are left to Beacon's official alerts feed."""
    e = event.lower()
    if urgency == "Immediate" or urgency == "Past":
        return None
    if "watch" in e or "outlook" in e or "statement" in e:
        return "watch"
    if "advisory" in e:
        return "likely"
    if "warning" in e:
        return "imminent" if onset is None or onset - now <= timedelta(hours=12) else "likely"
    return None


def parse_nws_alerts(payload: dict, bbox, now: datetime) -> list[dict]:
    """NWS watches and future/expected alerts. Items carry their own polygon when the alert has
    one; otherwise `affected_zones` lists the zone URLs whose union is the area (the worker fetches them)."""
    out = []
    for f in payload.get("features", []):
        p = f.get("properties", {})
        if p.get("status") != "Actual" or p.get("messageType") == "Cancel":
            continue
        event = p.get("event") or ""
        ugc = (p.get("geocode") or {}).get("UGC") or []
        if ugc and all(code[:2] in MARINE_AREAS for code in ugc):
            continue
        hazard = taxonomy.hazard_from_event_name(event)
        onset = utc(p.get("onset")) or utc(p.get("effective"))
        level = nws_level(event, p.get("urgency") or "", onset, now)
        ends = utc(p.get("ends")) or utc(p.get("expires"))
        if not hazard or not level or (ends and ends < now) or (onset and onset > now + HORIZON):
            continue
        summary = (p.get("headline") or event).strip()
        if p.get("instruction"):
            summary += " " + " ".join(p["instruction"].split())[:600]
        it = item("nws", p.get("id") or p.get("@id", event), hazard, level, event, summary,
                  onset or now, ends or now + timedelta(hours=12),
                  [{"name": p.get("senderName") or "National Weather Service",
                    "url": p.get("@id") or "https://www.weather.gov/", "observed": p.get("sent")}],
                  CERTAINTY_CONFIDENCE.get(p.get("certainty"), "medium"),
                  f.get("geometry") or bbox_polygon(bbox))
        it["affected_zones"] = [] if f.get("geometry") else list(p.get("affectedZones") or [])
        out.append(it)
    return out


# ---- NWS river forecasts (NWPS) ----------------------------------------------------------

def flood_categories(gauge: dict) -> dict[str, float]:
    cats = ((gauge.get("flood") or {}).get("categories") or {})
    return {k: float(v["stage"]) for k, v in cats.items() if v and v.get("stage") not in (None, -9999)}


def stage_category(stage: float | None, cats: dict[str, float]) -> str | None:
    if stage is None:
        return None
    for name in ("major", "moderate", "minor", "action"):
        if name in cats and stage >= cats[name]:
            return name
    return None


def parse_nwps(gauge: dict, stageflow: dict, now: datetime, radius_km: float = 6) -> list[dict]:
    """One gauge: observed stage now and the forecast crest in the next 72 h against the official
    NWS flood categories (action / minor / moderate / major stage)."""
    cats = flood_categories(gauge)
    if "minor" not in cats:
        return []
    lid, name = gauge.get("lid"), gauge.get("name") or gauge.get("lid")
    units = (gauge.get("flood") or {}).get("stageUnits") or "ft"
    obs = [d for d in (stageflow.get("observed") or {}).get("data") or [] if d.get("primary") not in (None, -999)]
    latest = max(obs, key=lambda d: d["validTime"]) if obs else None
    obs_stage = float(latest["primary"]) if latest else None
    fc = [d for d in (stageflow.get("forecast") or {}).get("data") or []
          if d.get("primary") not in (None, -999) and (t := utc(d.get("validTime"))) and now <= t <= now + HORIZON]
    crest = max(fc, key=lambda d: d["primary"]) if fc else None
    crest_stage = float(crest["primary"]) if crest else None
    crest_time = utc(crest["validTime"]) if crest else None
    obs_cat, crest_cat = stage_category(obs_stage, cats), stage_category(crest_stage, cats)
    flooding = ("minor", "moderate", "major")
    if obs_cat in flooding:
        level, when = "imminent", now
    elif crest_cat in flooding:
        first = min((utc(d["validTime"]) for d in fc if d["primary"] >= cats["minor"]), default=crest_time)
        level, when = ("imminent" if first - now <= timedelta(hours=12) else "likely"), first
    elif "action" in (obs_cat, crest_cat):
        level, when = "watch", crest_time or now
    else:
        return []
    lat, lng = float(gauge.get("latitude")), float(gauge.get("longitude"))
    parts = []
    if obs_stage is not None:
        parts.append(f"now {obs_stage:.1f} {units}")
    if crest_stage is not None:
        parts.append(f"forecast crest {crest_stage:.1f} {units} at {iso(crest_time)}")
    worst = max([c for c in (obs_cat, crest_cat) if c], key=["action", "minor", "moderate", "major"].index)
    summary = (f"{name}: {', '.join(parts)}. Flood stage (minor) is {cats['minor']:.1f} {units}"
               + (f", moderate {cats['moderate']:.1f}" if "moderate" in cats else "")
               + f". Highest category reached: {worst}. Stay out of low ground and flood zones near the river.")
    title = {"imminent": f"Flooding on {name}", "likely": f"Flooding forecast on {name}",
             "watch": f"{name} near flood stage"}[level]
    url = f"https://water.noaa.gov/gauges/{lid}"
    return [item("nwps", lid, "flood", level, title, summary, when, max(when, now) + timedelta(hours=24),
                 [{"name": "NWS National Water Prediction Service", "url": url,
                   "observed": latest["validTime"] if latest else None}],
                 "high" if level == "imminent" else "medium", circle_polygon(lng, lat, radius_km),
                 zones=["flood_zone"])]


# ---- Open-Meteo weather forecast -------------------------------------------------------------

# NWS Seattle (Western Region) wind criteria, mph: Wind Advisory 31+ sustained or 46+ gusts;
# High Wind Warning 40+ sustained or 58+ gusts.
WIND_ADVISORY = (31.0, 46.0)
HIGH_WIND = (40.0, 58.0)
# NWS heat index categories, deg F: Extreme Caution 90-102, Danger 103-124, Extreme Danger 125+.
HEAT_EXTREME_CAUTION, HEAT_DANGER = 90.0, 103.0
# USGS Seattle landslide thresholds. Cumulative (Chleborad 2003, USGS OFR 03-463):
#   P3 >= 3.5 - 0.67 * P15 (inches): 3-day total vs the 15 days before it -> landslides possible.
# Intensity-duration (Godt et al. 2006): I >= 82.73 * D^-1.13 (mm/h, D hours) -> landslides likely.
LANDSLIDE_P3_INCH, LANDSLIDE_P15_SLOPE = 3.5, 0.67
LANDSLIDE_ID = (82.73, -1.13)
MM_PER_INCH = 25.4


def _hours(series: dict) -> list[datetime]:
    return [datetime.fromisoformat(t).replace(tzinfo=timezone.utc) for t in series.get("time", [])]


def landslide_check(times: list[datetime], precip_mm: list[float], now: datetime) -> dict | None:
    """Worst landslide-threshold result over the next 72 h, or None. Hourly UTC series with past days."""
    vals = [v or 0.0 for v in precip_mm]
    best = None
    for i, t in enumerate(times):
        if t < now or t > now + HORIZON or i < 72 + 360:
            continue
        p3 = sum(vals[i - 71:i + 1]) / MM_PER_INCH
        p15 = sum(vals[i - 71 - 360:i - 71]) / MM_PER_INCH
        threshold = LANDSLIDE_P3_INCH - LANDSLIDE_P15_SLOPE * p15
        cumulative = p3 >= max(threshold, 0.0) and p3 > 0.1
        id_hit = None
        for d in range(1, 49):
            intensity = sum(vals[i - d + 1:i + 1]) / d
            if intensity >= LANDSLIDE_ID[0] * d ** LANDSLIDE_ID[1]:
                id_hit = d
                break
        if cumulative:
            res = {"time": t, "p3": p3, "p15": p15, "threshold": threshold, "id_hours": id_hit,
                   "level": "likely" if id_hit else "watch"}
            if best is None or LEVEL_RANK[res["level"]] > LEVEL_RANK[best["level"]]:
                best = res
    return best


def _box_union(boxes: list) -> dict:
    return {"type": "MultiPolygon", "coordinates": [bbox_polygon(b)["coordinates"] for b in boxes]}


def parse_open_meteo(points: list[dict], boxes: list, bbox, now: datetime) -> list[dict]:
    """Open-Meteo hourly forecasts at sample points (one per sub-box of the region; units: deg F,
    mph, mm). Heat, wind and the USGS Seattle landslide thresholds."""
    out = []
    heat, wind, slides = [], [], []
    for pt, box in zip(points, boxes):
        h = pt.get("hourly") or {}
        times = _hours(h)
        idx = [i for i, t in enumerate(times) if now <= t <= now + HORIZON]
        if not idx:
            continue
        at = [h.get("apparent_temperature", [None] * len(times))[i] for i in idx]
        gust = [h.get("wind_gusts_10m", [None] * len(times))[i] for i in idx]
        sust = [h.get("wind_speed_10m", [None] * len(times))[i] for i in idx]
        max_at = max((v for v in at if v is not None), default=None)
        if max_at is not None and max_at >= HEAT_EXTREME_CAUTION:
            t = times[idx[at.index(max_at)]]
            heat.append((box, max_at, t))
        max_g = max((v for v in gust if v is not None), default=0.0)
        max_s = max((v for v in sust if v is not None), default=0.0)
        if max_g >= WIND_ADVISORY[1] or max_s >= WIND_ADVISORY[0]:
            k = gust.index(max_g) if max_g >= WIND_ADVISORY[1] else sust.index(max_s)
            wind.append((box, max_s, max_g, times[idx[k]]))
        ls = landslide_check(times, h.get("precipitation") or [], now)
        if ls:
            slides.append(ls)
    src = [{"name": "Open-Meteo forecast (CC BY 4.0)", "url": "https://open-meteo.com/", "observed": iso(now)}]
    if heat:
        top = max(v for _, v, _ in heat)
        t0 = min(t for _, _, t in heat)
        level = "likely" if top >= HEAT_DANGER else "watch"
        cat = "Danger" if top >= HEAT_DANGER else "Extreme Caution"
        out.append(item("open-meteo", "heat", "heat", level, f"Extreme heat forecast (feels like {round(top)}°F)",
                        f"Forecast apparent temperature up to {round(top)}°F, in the NWS heat index '{cat}' range "
                        f"(Extreme Caution from {HEAT_EXTREME_CAUTION:.0f}°F, Danger from {HEAT_DANGER:.0f}°F). "
                        "Model forecast, not an official warning. Drink water, limit time outdoors and use a cooling centre.",
                        t0 - timedelta(hours=6), t0 + timedelta(hours=12), src, "low", _box_union([b for b, _, _ in heat])))
    if wind:
        top_g = max(g for _, _, g, _ in wind)
        top_s = max(s for _, s, _, _ in wind)
        t0 = min(t for _, _, _, t in wind)
        level = "likely" if top_g >= HIGH_WIND[1] or top_s >= HIGH_WIND[0] else "watch"
        crit = "High Wind Warning" if level == "likely" else "Wind Advisory"
        out.append(item("open-meteo", "wind", "storm", level, f"Strong wind forecast (gusts to {round(top_g)} mph)",
                        f"Forecast wind up to {round(top_s)} mph with gusts to {round(top_g)} mph, at or above NWS "
                        f"{crit} criteria. Model forecast, not an official warning. Falling trees and power outages are "
                        "possible; stay away from trees and downed lines.",
                        t0 - timedelta(hours=3), t0 + timedelta(hours=9), src, "low", _box_union([b for b, *_ in wind])))
    if slides:
        worst = max(slides, key=lambda r: (LEVEL_RANK[r["level"]], r["p3"]))
        id_text = (f" Rain intensity also crosses the USGS intensity-duration threshold ({worst['id_hours']} h)."
                   if worst["id_hours"] else "")
        out.append(item("open-meteo", "landslide", "flood", worst["level"],
                        "Landslides " + ("likely" if worst["level"] == "likely" else "possible") + " on steep slopes",
                        f"Forecast 3-day rain {worst['p3']:.1f} in after {worst['p15']:.1f} in over the previous 15 days "
                        f"reaches the USGS Seattle landslide threshold (P3 >= 3.5 - 0.67 x P15 = "
                        f"{max(worst['threshold'], 0):.1f} in).{id_text} Model forecast. Stay away from the bottom and "
                        "top of steep slopes and bluffs.",
                        worst["time"] - timedelta(hours=12), worst["time"] + timedelta(hours=24),
                        src + [{"name": "USGS Seattle landslide thresholds",
                                "url": "https://pubs.usgs.gov/of/2003/ofr-03-463/", "observed": None}],
                        "low", bbox_polygon(bbox), zones=["landslide"]))
    return out


# ---- Open-Meteo air quality (CAMS) -------------------------------------------------------------

# US EPA PM2.5 AQI breakpoints (24-hour average, ug/m3; 2024 revision).
PM25_CATEGORIES = [(225.5, "Hazardous"), (125.5, "Very Unhealthy"), (55.5, "Unhealthy"),
                   (35.5, "Unhealthy for Sensitive Groups"), (9.1, "Moderate"), (0.0, "Good")]


def pm25_category(value: float) -> str:
    return next(name for low, name in PM25_CATEGORIES if value >= low)


def parse_air_quality(points: list[dict], boxes: list, now: datetime) -> list[dict]:
    """24-hour rolling mean of forecast PM2.5 vs the EPA AQI categories:
    Unhealthy for Sensitive Groups (35.5+) -> watch, Unhealthy or worse (55.5+) -> likely."""
    hits = []
    for pt, box in zip(points, boxes):
        h = pt.get("hourly") or {}
        times, vals = _hours(h), h.get("pm2_5") or []
        best = None
        for i in range(23, len(vals)):
            t = times[i]
            window = [v for v in vals[i - 23:i + 1] if v is not None]
            if t < now or t > now + HORIZON or len(window) < 18:
                continue
            mean = sum(window) / len(window)
            if best is None or mean > best[0]:
                best = (mean, t)
        if best and best[0] >= 35.5:
            hits.append((box, *best))
    if not hits:
        return []
    top = max(v for _, v, _ in hits)
    t0 = min(t for _, _, t in hits)
    level = "likely" if top >= 55.5 else "watch"
    cat = pm25_category(top)
    return [item("open-meteo-air", "pm25", "air_quality", level, f"Poor air quality forecast ({cat})",
                 f"Forecast 24-hour average PM2.5 up to {top:.0f} µg/m³, EPA AQI category '{cat}'. Smoke or haze "
                 "likely. Model forecast (CAMS), not an official alert. Keep windows closed and limit outdoor activity; "
                 "sensitive groups should take extra care.",
                 t0 - timedelta(hours=24), t0 + timedelta(hours=6),
                 [{"name": "Open-Meteo air quality (CAMS, CC BY 4.0)", "url": "https://open-meteo.com/en/docs/air-quality-api",
                   "observed": iso(now)}],
                 "low", _box_union([b for b, _, _ in hits]))]


# ---- NOAA SPC convective outlooks and WPC excessive rainfall outlooks ------------------------------

SPC_LEVEL = {"MRGL": "watch", "SLGT": "watch", "ENH": "likely", "MDT": "likely", "HIGH": "likely"}


def _spc_time(text: str | None) -> datetime | None:
    if not text:
        return None
    if "T" in text or "-" in text:
        return utc(text)
    return datetime.strptime(text, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)


def parse_spc(payload: dict, day: int, now: datetime) -> list[dict]:
    """SPC categorical convective outlook (day 1-3). General thunder (TSTM) is skipped."""
    out = []
    for f in payload.get("features", []):
        p = f.get("properties", {})
        label = p.get("LABEL")
        if label not in SPC_LEVEL or not f.get("geometry"):
            continue
        start = _spc_time(p.get("VALID_ISO") or p.get("VALID")) or now
        end = _spc_time(p.get("EXPIRE_ISO") or p.get("EXPIRE")) or start + timedelta(hours=24)
        if end < now:
            continue
        name = p.get("LABEL2") or label
        out.append(item("noaa-spc", f"day{day}-{label}", "storm", SPC_LEVEL[label],
                        f"Severe thunderstorms: {name} (day {day})",
                        f"NOAA Storm Prediction Center day {day} outlook: {name} of severe thunderstorms "
                        "(damaging wind, large hail or tornadoes) in this area.",
                        start, end, [{"name": "NOAA Storm Prediction Center",
                                      "url": "https://www.spc.noaa.gov/products/outlook/", "observed": p.get("ISSUE_ISO")}],
                        "medium", f["geometry"], group=f"spc-day{day}"))
    return out


ERO_LEVEL = [("high", "likely", "high"), ("moderate", "likely", "medium"), ("slight", "watch", "medium"),
             ("marginal", "watch", "low")]


def parse_ero(payload: dict, day: int, now: datetime) -> list[dict]:
    """WPC Excessive Rainfall Outlook (day 1-3): probability that rain exceeds flash-flood guidance
    within 25 miles. Marginal (5%+) and Slight (15%+) -> watch, Moderate (40%+) and High (70%+) -> likely."""
    out = []
    for f in payload.get("features", []):
        p = f.get("properties", {})
        text = (p.get("outlook") or "").strip()
        rule = next((r for r in ERO_LEVEL if text.lower().startswith(r[0])), None)
        if not rule or not f.get("geometry"):
            continue
        start = utc((p.get("start_time") or "").replace(" ", "T")) or now
        end = utc((p.get("end_time") or "").replace(" ", "T")) or start + timedelta(hours=24)
        if end < now:
            continue
        out.append(item("noaa-wpc-ero", f"day{day}-{rule[0]}", "flood", rule[1],
                        f"Heavy rain and flash flooding: {text} (day {day})",
                        f"NOAA Weather Prediction Center excessive rainfall outlook, day {day}: {text} chance that "
                        "rain exceeds flash-flood guidance within 25 miles. Urban streets, underpasses and creeks flood "
                        "first; heavy rain can also trigger landslides on steep slopes.",
                        start, end, [{"name": "NOAA Weather Prediction Center",
                                      "url": "https://www.wpc.ncep.noaa.gov/qpf/excessive_rainfall_outlook_ero.php",
                                      "observed": p.get("issue_time")}],
                        rule[2], f["geometry"], group=f"ero-day{day}"))
    return out


# ---- USGS earthquakes (recent activity only; never a forecast) ----------------------------------

AFTERSHOCK_MIN_MAG = 5.0
AFTERSHOCK_RADIUS_KM = 150


def summarize_quakes(payload: dict, now: datetime) -> dict:
    feats = payload.get("features", [])
    mags = [(f["properties"].get("mag") or 0, f) for f in feats]
    largest = max(mags, key=lambda m: m[0], default=(None, None))
    return {"count": len(feats), "largestMag": largest[0],
            "largestPlace": largest[1]["properties"].get("place") if largest[1] else None}


def parse_usgs_quakes(payload: dict, bbox, now: datetime) -> list[dict]:
    """Earthquakes cannot be predicted. After an M5+ quake within 150 km in the past 7 days, USGS
    expects aftershocks and publishes aftershock forecasts; that, and only that, becomes a 'watch'."""
    out = []
    cx, cy = bbox_center(bbox)
    for f in payload.get("features", []):
        p = f.get("properties", {})
        mag = p.get("mag") or 0
        coords = (f.get("geometry") or {}).get("coordinates") or []
        if mag < AFTERSHOCK_MIN_MAG or len(coords) < 2:
            continue
        when = datetime.fromtimestamp(p["time"] / 1000, tz=timezone.utc)
        dist = haversine_km(coords[0], coords[1], cx, cy)
        if dist > AFTERSHOCK_RADIUS_KM or now - when > timedelta(days=7):
            continue
        oaf = ",oaf," in (p.get("types") or "")
        summary = (f"A magnitude {mag:.1f} earthquake struck {p.get('place') or 'nearby'} on {iso(when)}. "
                   "Earthquakes cannot be predicted, but aftershocks are common for days to weeks after a large quake"
                   + (" and USGS has published an aftershock forecast for it." if oaf else ".")
                   + " If you feel shaking: drop, cover and hold on. Stay out of damaged buildings.")
        out.append(item("usgs-quakes", f.get("id", str(p.get("time"))), "earthquake", "watch",
                        f"Aftershocks possible after M{mag:.1f} earthquake", summary, when, now + timedelta(hours=72),
                        [{"name": "USGS Earthquake Hazards Program", "url": p.get("url") or "https://earthquake.usgs.gov/",
                          "observed": iso(when)}],
                        "medium", circle_polygon(coords[0], coords[1], 100)))
    return out


# ---- NASA FIRMS (optional, needs a free MAP_KEY) --------------------------------------------------

def parse_firms_csv(text: str, bbox, now: datetime, max_km: float = 40) -> list[dict]:
    """VIIRS active-fire detections near the region -> one wildfire 'watch'. Low-confidence pixels
    are skipped; a hotspot can also be an industrial heat source, so confidence stays low."""
    lines = [l for l in text.strip().splitlines() if l.strip()]
    if len(lines) < 2:
        return []
    head = [h.strip() for h in lines[0].split(",")]
    pts = []
    for line in lines[1:]:
        row = dict(zip(head, (v.strip() for v in line.split(","))))
        try:
            lat, lng = float(row["latitude"]), float(row["longitude"])
        except (KeyError, ValueError):
            continue
        if row.get("confidence", "n").lower() in ("l", "low"):
            continue
        if km_to_bbox(lng, lat, bbox) <= max_km:
            pts.append((lng, lat, row.get("acq_date"), row.get("acq_time")))
    if not pts:
        return []
    inside = sum(1 for lng, lat, *_ in pts if km_to_bbox(lng, lat, bbox) == 0)
    geometry = {"type": "MultiPolygon", "coordinates": [circle_polygon(lng, lat, 3, 12)["coordinates"]
                                                        for lng, lat, *_ in pts[:200]]}
    latest = max(f"{d} {t}" for *_, d, t in pts)
    return [item("nasa-firms", "hotspots", "wildfire", "likely" if inside else "watch",
                 f"Satellite fire detections near the area ({len(pts)})",
                 f"NASA FIRMS VIIRS detected {len(pts)} active-fire hotspots within {max_km:.0f} km of the area"
                 f" ({inside} inside it), latest {latest} UTC. A hotspot can also be an industrial heat source; "
                 "check local news and officials.",
                 now - timedelta(hours=24), now + timedelta(hours=24),
                 [{"name": "NASA FIRMS", "url": "https://firms.modaps.eosdis.nasa.gov/map/", "observed": latest}],
                 "low", geometry)]


# ---- ordering --------------------------------------------------------------------------------

def most_serious_per_group(items: list[dict]) -> list[dict]:
    """Of items sharing a group (nested outlook polygons), keep the most serious one."""
    best: dict[str, dict] = {}
    out = []
    for it in items:
        g = it.get("group")
        if not g:
            out.append(it)
            continue
        cur = best.get(g)
        if cur is None or (LEVEL_RANK[it["level"]], CONFIDENCE_RANK[it["confidence"]]) > \
                (LEVEL_RANK[cur["level"]], CONFIDENCE_RANK[cur["confidence"]]):
            best[g] = it
    return out + list(best.values())
