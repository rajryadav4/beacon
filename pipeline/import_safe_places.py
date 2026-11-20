"""Import safe places (shelters, hubs, hospitals, police, ...) into PostgreSQL.

Works for any area. Sources:

  * OpenStreetMap through the Overpass API, for a bounding box: hospitals,
    police, fire stations, community centres, emergency assembly points, bomb
    shelters, public bunkers and social/emergency shelters. Bus, picnic and
    other weather shelters are skipped. Data (c) OpenStreetMap contributors, ODbL.
  * Official lists as GeoJSON points (a file or an http(s) URL, e.g. an ArcGIS
    FeatureServer query with f=geojson): every feature gets one --kind.
  * --seattle-official: the City of Seattle's open GIS layers (emergency hubs,
    fire stations, police precincts, hospitals, community centres).

Rows are upserted on (source, source_ref). Places of the same source that are
no longer in the data are removed (for OSM: only inside the bounding box).
The schema (db/schema/003_safe_places.sql) is applied first, so this also
works on a database created before the file existed.

Usage, from the repository root:

    python pipeline/import_safe_places.py                          # OSM, Seattle grid box
    python pipeline/import_safe_places.py --bbox 60.10,24.80,60.30,25.20   # OSM, Helsinki
    python pipeline/import_safe_places.py --seattle-official --no-osm
    python pipeline/import_safe_places.py --no-osm --geojson shelters.geojson \\
        --kind bomb_shelter --source-name helsinki-civil-defence

On a python.org build of Python on macOS, set SSL_CERT_FILE=$(python -m certifi).
"""

from __future__ import annotations

import argparse
import json
import re
import ssl
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pg import ROOT, connect  # noqa: E402

SCHEMA = ROOT / "db" / "schema" / "003_safe_places.sql"
USER_AGENT = "beacon-dev/0.1 (+https://github.com/rajryadav4/beacon)"
SEATTLE_BBOX = (47.48, -122.46, 47.75, -122.22)  # south, west, north, east (the crime grid box)

KINDS = ("shelter", "bomb_shelter", "bunker", "assembly_point", "emergency_hub",
         "hospital", "police", "fire_station", "community_centre")
KIND_LABELS = {
    "shelter": "Shelter", "bomb_shelter": "Bomb shelter", "bunker": "Bunker",
    "assembly_point": "Emergency assembly point", "emergency_hub": "Emergency hub",
    "hospital": "Hospital", "police": "Police station", "fire_station": "Fire station",
    "community_centre": "Community centre",
}

# Public Overpass instances, tried in order. Override with --overpass-url.
OVERPASS_URLS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
)

PUBLIC_ACCESS = {"yes", "public", "permissive", "designated"}
NO_ACCESS = {"private", "no", "military", "customers", "permit"}
SIMPLE_AMENITY = {"hospital": "hospital", "police": "police", "fire_station": "fire_station",
                  "community_centre": "community_centre"}


# ---- OpenStreetMap --------------------------------------------------------

def overpass_query(bbox: tuple[float, float, float, float], timeout: int) -> str:
    b = ",".join(f"{v:.6f}" for v in bbox)
    return f"""[out:json][timeout:{timeout}];
(
  nwr["amenity"~"^(hospital|police|fire_station|community_centre|refugee_site)$"]({b});
  nwr["emergency"~"^(assembly_point|shelter)$"]({b});
  nwr["amenity"="shelter"]["shelter_type"="bomb_shelter"]({b});
  nwr["military"="bunker"]({b});
  nwr["building"="bunker"]({b});
  nwr["social_facility"="shelter"]({b});
);
out center tags;"""


def classify_osm(tags: dict) -> str | None:
    """OSM tags -> safe place kind, or None to skip (bus/picnic shelters, private bunkers, ...)."""
    access = (tags.get("access") or "").lower()
    if access in NO_ACCESS:
        return None
    amenity = tags.get("amenity")
    shelter_type = tags.get("shelter_type")
    if shelter_type == "bomb_shelter" and (amenity == "shelter" or tags.get("building") == "bunker"
                                           or tags.get("military") == "bunker"):
        return "bomb_shelter"
    if amenity == "hospital" and tags.get("emergency") == "no":
        return None  # no emergency department
    if amenity in SIMPLE_AMENITY:
        return SIMPLE_AMENITY[amenity]
    if tags.get("emergency") == "assembly_point":
        return "assembly_point"
    if tags.get("military") == "bunker" or tags.get("building") == "bunker":
        # Most bunkers are historic or military; only ones open to the public count.
        return "bunker" if access in PUBLIC_ACCESS else None
    if tags.get("social_facility") == "shelter" or tags.get("emergency") == "shelter" \
            or amenity == "refugee_site":
        return "shelter"
    return None  # plain amenity=shelter (bus stop, picnic, gazebo, weather) and the rest


def osm_address(tags: dict) -> str | None:
    if tags.get("addr:full"):
        return tags["addr:full"]
    street = " ".join(p for p in (tags.get("addr:housenumber"), tags.get("addr:street")) if p)
    parts = [p for p in (street, tags.get("addr:city")) if p]
    return ", ".join(parts) or None


def parse_int(value) -> int | None:
    if value is None:
        return None
    match = re.match(r"^\s*(\d+)", str(value))
    return int(match.group(1)) if match else None


def osm_rows(elements: list[dict]) -> list[dict]:
    rows = []
    for el in elements:
        tags = el.get("tags") or {}
        kind = classify_osm(tags)
        if kind is None:
            continue
        if el["type"] == "node":
            lat, lng = el.get("lat"), el.get("lon")
        else:
            center = el.get("center") or {}
            lat, lng = center.get("lat"), center.get("lon")
        if lat is None or lng is None:
            continue
        rows.append({
            "source_ref": f"{el['type']}/{el['id']}",
            "kind": kind,
            "name": tags.get("name") or tags.get("official_name") or tags.get("operator")
                    or KIND_LABELS[kind],
            "address": osm_address(tags),
            "phone": tags.get("phone") or tags.get("contact:phone"),
            "opening_hours": tags.get("opening_hours"),
            "capacity": parse_int(tags.get("capacity")),
            "wheelchair": tags.get("wheelchair"),
            "tags": tags,
            "lat": lat,
            "lng": lng,
        })
    return rows


def http_get(url: str, data: bytes | None = None, timeout: int = 60) -> bytes:
    request = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    try:
        import certifi
        context = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        context = None
    with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
        return response.read()


def fetch_osm(bbox, urls, timeout: int) -> tuple[list[dict], str]:
    data = urllib.parse.urlencode({"data": overpass_query(bbox, timeout)}).encode()
    errors = []
    for url in urls:
        try:
            body = json.loads(http_get(url, data=data, timeout=timeout + 15))
            if body.get("remark") and not body.get("elements"):
                raise RuntimeError(body["remark"])
            return body.get("elements", []), url
        except Exception as exc:  # noqa: BLE001 - try the next mirror
            errors.append(f"{url}: {exc}")
            print(f"  overpass failed: {url}: {exc}", file=sys.stderr)
    raise RuntimeError("every Overpass instance failed:\n  " + "\n  ".join(errors))


# ---- GeoJSON (official lists) ---------------------------------------------

NAME_KEYS = ("name", "Name", "NAME", "SiteName", "FACILITY", "facility", "title", "Title")
ADDRESS_KEYS = ("address", "Address", "ADDRESS", "SiteAddress", "location", "LOCATION")
PHONE_KEYS = ("phone", "Phone", "PHONE", "TELEPHONE", "telephone")
HOURS_KEYS = ("opening_hours", "hours", "Hours", "HOURS")
CAPACITY_KEYS = ("capacity", "Capacity", "CAPACITY")
REF_KEYS = ("id", "ID", "GlobalID", "globalid", "OBJECTID", "ObjectID", "objectid", "FID")


def first(props: dict, keys) -> str | None:
    for key in keys:
        value = props.get(key)
        if value not in (None, ""):
            return str(value).strip()
    return None


def load_geojson(src: str) -> dict:
    if re.match(r"^https?://", src):
        return json.loads(http_get(src, timeout=120))
    return json.loads(Path(src).read_text())


def geojson_rows(collection: dict, kind: str, fields: dict | None = None) -> list[dict]:
    """Point features -> rows. `fields` may set name/address/phone/ref property names,
    a `name` callable, a `skip` callable and a `phone_prefix` for local numbers."""
    fields = fields or {}
    if collection.get("properties", {}).get("exceededTransferLimit"):
        print("  warning: the server returned only part of the layer", file=sys.stderr)
    rows = []
    for i, feature in enumerate(collection.get("features") or []):
        geom = feature.get("geometry") or {}
        if geom.get("type") != "Point":
            continue
        lng, lat = geom["coordinates"][:2]
        props = feature.get("properties") or {}
        if fields.get("skip") and fields["skip"](props):
            continue
        get = lambda key, defaults: first(props, [fields[key]] if fields.get(key) else defaults)  # noqa: E731
        ref = get("ref", REF_KEYS) or (str(feature["id"]) if feature.get("id") is not None else str(i))
        name = fields["name"](props) if callable(fields.get("name")) else get("name", NAME_KEYS)
        phone = get("phone", PHONE_KEYS)
        if phone and fields.get("phone_prefix") and re.fullmatch(r"\d{3}-\d{4}", phone):
            phone = fields["phone_prefix"] + phone
        address = get("address", ADDRESS_KEYS)
        if address and fields.get("city"):
            address = f"{address}, {props.get(fields['city']) or ''}".rstrip(", ")
        rows.append({
            "source_ref": ref,
            "kind": kind,
            "name": name or KIND_LABELS[kind],
            "address": address,
            "phone": phone,
            "opening_hours": get("hours", HOURS_KEYS),
            "capacity": parse_int(get("capacity", CAPACITY_KEYS)),
            "wheelchair": None,
            "tags": props,
            "lat": float(lat),
            "lng": float(lng),
        })
    return rows


SEATTLE_ARCGIS = "https://services.arcgis.com/ZOyb2t4B0UYuYNYH/ArcGIS/rest/services/{}/FeatureServer/0/query?" \
    + urllib.parse.urlencode({"where": "1=1", "outFields": "*", "outSR": 4326, "f": "geojson"})

# (source name, layer, kind, field mapping). City of Seattle open GIS data.
SEATTLE_OFFICIAL = (
    ("seattle-emergency-hubs", "EmergencyHubs_view", "emergency_hub",
     {"name": lambda p: f"{p.get('SiteName') or 'Community'} Emergency Hub", "address": "SiteAddress",
      "ref": "GlobalID"}),
    ("seattle-fire-stations", "Fire_Stations", "fire_station",
     {"name": lambda p: "Seattle Fire " + ("Headquarters" if p.get("STNID") == "SFD HQ"
                                           else "Station " + (p.get("STNID") or "").replace("SFD ", "")),
      "address": "ADDRESS", "ref": "STNID"}),
    ("seattle-police-precincts", "SPD_Precinct_Points", "police",
     {"name": lambda p: f"Seattle Police {p.get('facility') or 'Precinct'}", "address": "location",
      "ref": "facility"}),
    ("seattle-hospitals", "Hospital", "hospital",
     {"name": "FACILITY", "address": "ADDRESS", "city": "CITY", "phone": "TELEPHONE", "ref": "GlobalID"}),
    ("seattle-community-centers", "Community_Centers", "community_centre",
     {"name": "NAME", "address": "ADDRESS", "phone": "PHONE", "phone_prefix": "206-", "ref": "NAME",
      "skip": lambda p: (p.get("OPEN_") or "").lower() == "closed"}),
)


# ---- Database --------------------------------------------------------------

UPSERT = """
INSERT INTO safe_places (source, source_ref, kind, name, address, phone, opening_hours,
                         capacity, wheelchair, tags, geom, updated_at)
VALUES (%(source)s, %(source_ref)s, %(kind)s, %(name)s, %(address)s, %(phone)s, %(opening_hours)s,
        %(capacity)s, %(wheelchair)s, %(tags)s,
        ST_SetSRID(ST_MakePoint(%(lng)s, %(lat)s), 4326)::geography, now())
ON CONFLICT (source, source_ref) DO UPDATE SET
    kind = EXCLUDED.kind, name = EXCLUDED.name, address = EXCLUDED.address,
    phone = EXCLUDED.phone, opening_hours = EXCLUDED.opening_hours, capacity = EXCLUDED.capacity,
    wheelchair = EXCLUDED.wheelchair, tags = EXCLUDED.tags, geom = EXCLUDED.geom,
    updated_at = now()
"""


def apply_schema(conn) -> None:
    conn.autocommit = True
    conn.execute(SCHEMA.read_text())
    conn.autocommit = False


def clip(value, size: int):
    return value[:size] if isinstance(value, str) else value


def save(conn, source: str, rows: list[dict], prune_bbox=None, prune_all: bool = False) -> tuple[int, int]:
    """Upsert rows; remove this source's rows that were not in `rows`
    (inside `prune_bbox` for OSM, or everywhere with `prune_all`). Returns (saved, removed)."""
    from psycopg.types.json import Jsonb

    seen: dict[str, dict] = {}
    for row in rows:
        seen[row["source_ref"]] = row  # last one wins on duplicate refs
    with conn.cursor() as cur:
        cur.executemany(UPSERT, [{
            **row, "source": source, "tags": Jsonb(row["tags"]),
            "name": clip(row["name"], 255), "address": clip(row["address"], 255),
            "phone": clip(row["phone"], 60), "opening_hours": clip(row["opening_hours"], 255),
            "wheelchair": clip(row["wheelchair"], 20), "source_ref": clip(row["source_ref"], 120),
        } for row in seen.values()])
        removed = 0
        if prune_bbox or prune_all:
            south, west, north, east = prune_bbox or (-90, -180, 90, 180)
            cur.execute(
                """DELETE FROM safe_places
                   WHERE source = %(source)s AND NOT (source_ref = ANY(%(refs)s))
                     AND geom::geometry && ST_MakeEnvelope(%(w)s, %(s)s, %(e)s, %(n)s, 4326)""",
                {"source": source, "refs": list(seen), "w": west, "s": south, "e": east, "n": north})
            removed = cur.rowcount
    conn.commit()
    return len(seen), removed


def parse_bbox(text: str) -> tuple[float, float, float, float]:
    try:
        south, west, north, east = (float(v) for v in text.split(","))
    except ValueError:
        raise argparse.ArgumentTypeError("bbox must be south,west,north,east") from None
    if not (-90 <= south < north <= 90 and -180 <= west < east <= 180):
        raise argparse.ArgumentTypeError("bbox must be south,west,north,east with south < north, west < east")
    return south, west, north, east


def count_kinds(rows: list[dict]) -> str:
    counts: dict[str, int] = {}
    for row in rows:
        counts[row["kind"]] = counts.get(row["kind"], 0) + 1
    return ", ".join(f"{k} {v}" for k, v in sorted(counts.items())) or "nothing"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bbox", type=parse_bbox, default=SEATTLE_BBOX,
                        help="OSM area as south,west,north,east (default: the Seattle grid box)")
    parser.add_argument("--no-osm", action="store_true", help="skip OpenStreetMap")
    parser.add_argument("--overpass-url", action="append", help="Overpass endpoint(s) to try instead of the defaults")
    parser.add_argument("--timeout", type=int, default=120, help="Overpass query timeout in seconds")
    parser.add_argument("--geojson", help="GeoJSON file or URL of an official list (Point features)")
    parser.add_argument("--kind", choices=KINDS, help="kind of every place in --geojson")
    parser.add_argument("--source-name", help="source key for --geojson, e.g. helsinki-civil-defence")
    parser.add_argument("--name-field", help="property holding the name (default: guessed)")
    parser.add_argument("--address-field", help="property holding the address (default: guessed)")
    parser.add_argument("--phone-field", help="property holding the phone number (default: guessed)")
    parser.add_argument("--ref-field", help="property holding a stable id (default: guessed, then feature id)")
    parser.add_argument("--seattle-official", action="store_true",
                        help="also import the City of Seattle's GIS layers (hubs, fire, police, hospitals, centres)")
    parser.add_argument("--no-prune", action="store_true", help="keep places that are no longer in the source")
    args = parser.parse_args()

    if args.geojson and not (args.kind and args.source_name):
        parser.error("--geojson needs --kind and --source-name")
    if args.source_name and not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,59}", args.source_name):
        parser.error("--source-name: lower-case letters, digits, '-', '_' or '.', at most 60 characters")
    if args.source_name == "osm":
        parser.error("--source-name 'osm' is reserved for OpenStreetMap")

    started = time.time()
    with connect() as conn:
        apply_schema(conn)

        if not args.no_osm:
            print(f"OpenStreetMap, bbox {','.join(map(str, args.bbox))} ...")
            elements, url = fetch_osm(args.bbox, args.overpass_url or OVERPASS_URLS, args.timeout)
            rows = osm_rows(elements)
            saved, removed = save(conn, "osm", rows, prune_bbox=None if args.no_prune else args.bbox)
            print(f"  {len(elements)} OSM elements from {url}; kept {saved} ({count_kinds(rows)}), removed {removed}")

        sources = []
        if args.seattle_official:
            sources += [(name, SEATTLE_ARCGIS.format(layer), kind, fields)
                        for name, layer, kind, fields in SEATTLE_OFFICIAL]
        if args.geojson:
            fields = {k: v for k, v in (("name", args.name_field), ("address", args.address_field),
                                        ("phone", args.phone_field), ("ref", args.ref_field)) if v}
            sources.append((args.source_name, args.geojson, args.kind, fields))
        for name, src, kind, fields in sources:
            rows = geojson_rows(load_geojson(src), kind, fields)
            saved, removed = save(conn, name, rows, prune_all=not args.no_prune)
            print(f"{name}: kept {saved} {kind}, removed {removed}")

        total = conn.execute(
            "SELECT kind, count(*) FROM safe_places GROUP BY kind ORDER BY kind").fetchall()
        visible = conn.execute("SELECT count(*) FROM safe_places_visible").fetchone()[0]
    print("safe_places now: " + ", ".join(f"{k} {n}" for k, n in total)
          + f" ({visible} shown after removing OSM duplicates of official places)")
    print(f"done in {time.time() - started:.1f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
