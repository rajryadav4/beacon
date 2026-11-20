"""Small planar geometry helpers for scenario shapes (circles, ellipses, cones).

Shapes are built on a local tangent plane around their center (metres east/north),
which is accurate to well under 1 % at city scale, and returned as GeoJSON polygons.
"""

from __future__ import annotations

import math

M_PER_DEG_LAT = 111_200.0  # rough, for quick distance filters only
EARTH_RADIUS_M = 6_371_008.8


def meters(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in metres."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2)
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(min(1.0, a)))


def bearing(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Initial compass bearing from point 1 to point 2, degrees 0-360 (0 = north)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lng2 - lng1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def angle_diff(a: float, b: float) -> float:
    """Smallest absolute difference between two bearings, 0-180."""
    d = abs(a - b) % 360
    return 360 - d if d > 180 else d


def m_per_deg(lat: float) -> tuple[float, float]:
    """Metres per degree of (latitude, longitude) at a latitude (WGS 84 series)."""
    p = math.radians(lat)
    return (111_132.92 - 559.82 * math.cos(2 * p) + 1.175 * math.cos(4 * p),
            111_412.84 * math.cos(p) - 93.5 * math.cos(3 * p))


def offset(lat: float, lng: float, east_m: float, north_m: float) -> tuple[float, float]:
    """The point east_m / north_m metres from (lat, lng) -> (lat, lng)."""
    m_lat, m_lng = m_per_deg(lat)
    return lat + north_m / m_lat, lng + east_m / m_lng


def move(lat: float, lng: float, bearing_deg: float, distance_m: float) -> tuple[float, float]:
    b = math.radians(bearing_deg)
    return offset(lat, lng, distance_m * math.sin(b), distance_m * math.cos(b))


def _polygon(lat: float, lng: float, points_en: list[tuple[float, float]]) -> dict:
    ring = []
    for east, north in points_en:
        plat, plng = offset(lat, lng, east, north)
        ring.append([round(plng, 6), round(plat, 6)])
    ring.append(ring[0])
    return {"type": "Polygon", "coordinates": [ring]}


def circle(lat: float, lng: float, radius_m: float, segments: int = 64) -> dict:
    return ellipse(lat, lng, radius_m, radius_m, 0.0, segments=segments)


def ellipse(lat: float, lng: float, semi_major_m: float, semi_minor_m: float, bearing_deg: float,
            center_offset_m: float = 0.0, segments: int = 64) -> dict:
    """Ellipse whose major axis points along `bearing_deg`; its center sits `center_offset_m`
    from (lat, lng) along that bearing (so a fire or plume can start at the event point)."""
    b = math.radians(bearing_deg)
    ux, uy = math.sin(b), math.cos(b)          # along the major axis (east, north)
    vx, vy = math.cos(b), -math.sin(b)         # across it
    pts = []
    for i in range(segments):
        t = 2 * math.pi * i / segments
        along = center_offset_m + semi_major_m * math.cos(t)
        across = semi_minor_m * math.sin(t)
        pts.append((along * ux + across * vx, along * uy + across * vy))
    return _polygon(lat, lng, pts)


def plume(lat: float, lng: float, radius_m: float, length_m: float, half_width_m: float,
          bearing_deg: float, segments: int = 48) -> dict:
    """A circle of `radius_m` around the source joined to a downwind teardrop that is
    `length_m` long and `half_width_m` wide at its widest (a simple Gaussian-plume outline)."""
    b = math.radians(bearing_deg)
    ux, uy = math.sin(b), math.cos(b)
    vx, vy = math.cos(b), -math.sin(b)
    pts: list[tuple[float, float]] = []
    # Downwind edge: half-width grows like sqrt(distance), then closes at the tip.
    steps = segments // 2
    right, left = [], []
    for i in range(steps + 1):
        s = i / steps
        along = radius_m + (length_m - radius_m) * s
        width = max(radius_m, half_width_m * math.sqrt(s) * (1 - s ** 4) ** 0.5)
        right.append((along, -width))
        left.append((along, width))
    upwind = [(radius_m * math.cos(t), radius_m * math.sin(t))
              for t in (math.pi / 2 + math.pi * k / steps for k in range(1, steps))]
    outline = right + [(length_m, 0.0)] + list(reversed(left)) + upwind
    for along, across in outline:
        pts.append((along * ux + across * vx, along * uy + across * vy))
    return _polygon(lat, lng, pts)
