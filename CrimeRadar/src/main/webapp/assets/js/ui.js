// Small DOM, format and timing helpers. User text always goes in through textContent.

import { iconEl, LEVEL_ICON } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Build an element. Children that are not Nodes become text nodes (never HTML). */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv); // custom properties need setProperty
        else el.style[sk] = sv;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export const fmt = {
  int: (n) => Math.round(n).toLocaleString('en-US'),
  compact: (n) => (n < 1000
    ? String(Math.round(n))
    : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: n < 10000 ? 1 : 0 }).format(n)),
  pct: (x) => `${Math.round(x * 100)}%`,
  duration(seconds) {
    const m = Math.max(1, Math.round(seconds / 60));
    if (m < 60) return `${m} min`;
    const hrs = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${hrs} h ${rest} min` : `${hrs} h`;
  },
  distance(meters) {
    const miles = meters / 1609.344;
    if (miles < 0.1) return `${Math.max(10, Math.round((meters * 3.28084) / 10) * 10)} ft`;
    return `${miles.toFixed(miles < 10 ? 1 : 0)} mi`;
  },
  perYear: (n) => (n >= 10 ? fmt.int(n) : n >= 1 ? n.toFixed(1).replace(/\.0$/, '') : n > 0 ? '<1' : '0'),
};

/** fetch with a timeout; an outer AbortSignal still cancels it. */
export async function fetchWithTimeout(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('The request timed out.', 'TimeoutError')), ms);
  const outer = opts.signal;
  if (outer) {
    if (outer.aborted) ctrl.abort(outer.reason);
    else outer.addEventListener('abort', () => ctrl.abort(outer.reason), { once: true });
  }
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** True when a request was cancelled on purpose (a newer request replaced it). Timeouts are not aborts. */
export const isAbort = (e) => !!e && e.name === 'AbortError';

// ---- Seattle clock: the crime data uses Seattle local time ----
const SEATTLE_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
});
export function seattleClock(date = new Date()) {
  const parts = SEATTLE_FMT.formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour').value) % 24;
  const minute = Number(parts.find((p) => p.type === 'minute').value);
  return { hour, minute };
}
export const bandOfHour = (hour) => Math.floor(((hour % 24) + 24) % 24 / 6);
export function clockLabel(hour, minute = 0) {
  const h12 = ((hour + 11) % 12) + 1;
  return `${h12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}
export function greeting(hour) {
  if (hour < 5) return 'Hello';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Ring gauge (0-100). `color` is a code constant (never user input). */
export function ring(value, { size = 54, stroke = 6, color = 'var(--brand)', text, cls = '' } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = clamp(Number(value) || 0, 0, 100) / 100;
  const wrap = h('span', { class: `ring ${cls}`.trim(), style: { width: `${size}px`, height: `${size}px` }, 'aria-hidden': 'true' });
  const mid = size / 2;
  wrap.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<circle class="ring-track" cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke-width="${stroke}"/>`
    + `<circle class="ring-value" cx="${mid}" cy="${mid}" r="${r}" fill="none" style="stroke:${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - pct)).toFixed(2)}"/></svg>`;
  wrap.append(h('b', null, text != null ? text : String(Math.round(Number(value) || 0))));
  return wrap;
}

/** Status badge: icon + label, never color alone. */
export function levelBadge(level, text) {
  const label = text || { low: 'Lower risk', elevated: 'Elevated risk', high: 'High risk' }[level];
  return h('span', { class: `level level-${level}` }, iconEl(LEVEL_ICON[level], 'icon-sm'), label);
}

// ---- Toast: one at a time; a new toast replaces the old one ----
let toastTimer = null;
export function toast(message, { actionLabel, onAction, duration = 5000 } = {}) {
  const el = $('#toast');
  clearTimeout(toastTimer);
  el.replaceChildren(h('span', null, message));
  if (actionLabel && onAction) {
    el.append(h('button', {
      class: 'link', type: 'button',
      onclick: () => { hideToast(); onAction(); },
    }, actionLabel));
  }
  el.hidden = false;
  toastTimer = setTimeout(hideToast, duration);
}
export function hideToast() {
  clearTimeout(toastTimer);
  $('#toast').hidden = true;
}

/** Put a button into a busy state; returns a function that restores it. */
export function busy(button, label) {
  const old = [...button.childNodes];
  const width = button.offsetWidth;
  button.setAttribute('aria-busy', 'true');
  button.disabled = true;
  button.style.minWidth = `${width}px`;
  button.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), label || '');
  return () => {
    button.removeAttribute('aria-busy');
    button.disabled = false;
    button.style.minWidth = '';
    button.replaceChildren(...old);
  };
}

export const isPhone = () => window.matchMedia('(max-width: 760px)').matches;
export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
