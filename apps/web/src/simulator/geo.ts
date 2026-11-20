// Small geometry helpers for the simulator map (no dependencies).

import type { Position } from 'geojson';
import type { ZoneGeometry } from './api';

type Ring = Position[];

function inRing(ring: Ring, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A prepared polygon test with a bounding-box shortcut. */
export function polygonTester(geom: ZoneGeometry): (lng: number, lat: number) => boolean {
  const polys: Ring[][] = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  const boxes = polys.map((poly) => {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [x, y] of poly[0]) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
    return [w, s, e, n];
  });
  return (x, y) => polys.some((poly, i) => {
    const [w, s, e, n] = boxes[i];
    if (x < w || x > e || y < s || y > n) return false;
    return inRing(poly[0], x, y) && !poly.slice(1).some((hole) => inRing(hole, x, y));
  });
}

export function bboxOf(points: Position[]): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of points) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  return [w, s, e, n];
}

export function zonePoints(geom: ZoneGeometry): Position[] {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  return polys.flatMap((p) => p[0]);
}

const R = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function meters(a: Position, b: Position): number {
  const p1 = rad(a[1]), p2 = rad(b[1]);
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(rad(b[0] - a[0]) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function bearing(a: Position, b: Position): number {
  const p1 = rad(a[1]), p2 = rad(b[1]), dl = rad(b[0] - a[0]);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Cumulative distances along a line, for drawing it progressively. */
export function cumulative(coords: Position[]): number[] {
  const out = [0];
  for (let i = 1; i < coords.length; i++) out.push(out[i - 1] + meters(coords[i - 1], coords[i]));
  return out;
}

/** The part of the line up to `dist` metres, and its head point. */
export function sliceLine(coords: Position[], cum: number[], dist: number): { part: Position[]; head: Position } {
  if (dist <= 0) return { part: [coords[0], coords[0]], head: coords[0] };
  const total = cum[cum.length - 1];
  if (dist >= total) return { part: coords, head: coords[coords.length - 1] };
  let i = 1;
  while (cum[i] < dist) i++;
  const t = (dist - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
  const a = coords[i - 1], b = coords[i];
  const head: Position = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { part: [...coords.slice(0, i), head], head };
}

/** Smallest signed turn from one bearing to another, -180..180. */
export function turn(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}
