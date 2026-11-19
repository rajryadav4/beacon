// Map colors and helpers shared by both map engines (MapLibre GL and the Leaflet fallback).

import { densify, cumulative, pointAt } from './geo.js';

// Sequential "fire" ramps with lightness that changes in one direction only.
// Light map: light -> dark (more = darker). Dark map: dark -> light (more = brighter).
export const HEAT_LIGHT = { 0.15: '#ffe39a', 0.35: '#ffb55c', 0.55: '#f9773f', 0.75: '#e03b3b', 1.0: '#9d174d' };
export const HEAT_DARK = { 0.15: '#5b1a5e', 0.35: '#a3245f', 0.55: '#e4453e', 0.75: '#ff8c3a', 1.0: '#ffe17d' };
export const LEVEL_COLOR = { low: '#0ca30c', elevated: '#ec835a', high: '#e5484d' };
/** Route colors compare the options with each other: best = recommended, mid = moderate, worst = most dangerous. */
export const ROLE_COLOR = { best: '#16a34a', mid: '#f59f00', worst: '#e03131' };
export const ROLE_LABEL = { best: 'Recommended', mid: 'Moderate risk', worst: 'Most dangerous' };
export const ROLE_ORDER = { worst: 0, mid: 1, best: 2 }; // drawn later = on top

/**
 * A label point for each route, on the part of the route that is farthest from the other routes,
 * so the "R1 · 31 min" pills do not sit on top of each other. Returns [lat, lng] per route.
 */
export function labelPoints(routes) {
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

/** Screen-space layout for route pills: returns a vertical offset (px) per pill, selected pill first. */
export function pillOffsets(items) {
  // items: [{ x, y, selected }]
  const order = items.map((it, i) => ({ ...it, i })).sort((a, b) => (b.selected - a.selected) || (a.y - b.y));
  const placed = [];
  const out = new Array(items.length).fill(0);
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

/** HTML for a route pill. Numbers and fixed words only: never user text. */
export function pillHtml(role, idx, minutes, selected) {
  return `<div class="route-pill route-pill-${role || 'best'}${selected ? ' is-selected' : ''}">R${idx + 1}<span>${minutes} min</span></div>`;
}
