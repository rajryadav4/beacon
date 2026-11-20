// Formatting helpers shared by every view.

const WALK_SPEED_MPS = 1.3; // about 4.7 km/h, a typical adult walking pace

export function formatDistance(m: number): string {
  if (!Number.isFinite(m)) return '';
  if (m < 950) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(m < 9500 ? 1 : 0)} km`;
}

export function formatDuration(seconds: number): string {
  const min = Math.max(1, Math.round(seconds / 60));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

/** Estimated walking time for a straight-line or route distance. */
export const walkTime = (m: number) => formatDuration(m / WALK_SPEED_MPS);
export const walkSeconds = (m: number) => m / WALK_SPEED_MPS;

export const fmt = {
  int: (n: number) => Math.round(n).toLocaleString('en-US'),
  compact: (n: number) => (n < 1000
    ? String(Math.round(n))
    : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: n < 10000 ? 1 : 0 }).format(n)),
  pct: (x: number) => `${Math.round(x * 100)}%`,
  perYear: (n: number) => (n >= 10 ? fmt.int(n) : n >= 1 ? n.toFixed(1).replace(/\.0$/, '') : n > 0 ? '<1' : '0'),
};

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
}

/** "3 min ago", "in 2 h". */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Math.round((t - now) / 1000);
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
  if (abs < 60) return rtf.format(diff, 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

export const SEVERITY_COLOR: Record<string, string> = {
  Extreme: '#b91c1c',
  Severe: '#d03b3b',
  Moderate: '#ec835a',
  Minor: '#c08a10',
  Unknown: '#6b7280',
};
export const severityColor = (s: string | null | undefined) => SEVERITY_COLOR[s ?? 'Unknown'] ?? SEVERITY_COLOR.Unknown;
export const SEVERITY_RANK: Record<string, number> = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };

/** fetch with a timeout; an outer AbortSignal still cancels it. */
export async function fetchWithTimeout(url: string, opts: RequestInit = {}, ms = 10000): Promise<Response> {
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

/** True when a request was cancelled on purpose (a newer request replaced it). */
export const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

export const isPhone = () => window.matchMedia('(max-width: 760px)').matches;
export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
