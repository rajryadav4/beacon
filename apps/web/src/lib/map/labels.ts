// Route label placement for the "R1 · 31 min" pills (ported from the class app's mapstyle.js).

import { cumulative, densify, pointAt, type Pt } from '../geo';

/**
 * A label point for each route, on the part of the route farthest from the other routes,
 * so the pills do not sit on top of each other.
 */
export function labelPoints(routes: { coords: Pt[] }[]): Pt[] {
  const samples = routes.map((r) => densify(r.coords, 60));
  return routes.map((r, i) => {
    const acc = cumulative(r.coords);
    const total = acc[acc.length - 1];
    let best = pointAt(r.coords, acc, total * (0.35 + 0.15 * i));
    let bestD = -1;
    for (let f = 0.2; f <= 0.8001; f += 0.05) {
      const p = pointAt(r.coords, acc, total * f);
      let d = Infinity;
      samples.forEach((pts, j) => {
        if (j === i) return;
        for (const q of pts) {
          const dy = (p[0] - q[0]) * 111320;
          const dx = (p[1] - q[1]) * 75000;
          const dd = dy * dy + dx * dx;
          if (dd < d) d = dd;
        }
      });
      if (d > bestD) { bestD = d; best = p; }
    }
    return best;
  });
}

/** Screen-space layout for route pills: a vertical offset (px) per pill, selected pill first. */
export function pillOffsets(items: { x: number; y: number; selected: boolean }[]): number[] {
  const order = items.map((it, i) => ({ ...it, i })).sort((a, b) => (Number(b.selected) - Number(a.selected)) || (a.y - b.y));
  const placed: { x: number; y: number }[] = [];
  const out = new Array<number>(items.length).fill(0);
  for (const it of order) {
    let dy = 0;
    for (let tries = 0; tries < 6; tries++) {
      const y = it.y + dy;
      if (!placed.some((q) => Math.abs(q.x - it.x) < 92 && Math.abs(q.y - y) < 30)) break;
      dy += 30;
    }
    placed.push({ x: it.x, y: it.y + dy });
    out[it.i] = dy;
  }
  return out;
}
