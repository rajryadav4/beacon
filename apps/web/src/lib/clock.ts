// Seattle clock: the crime data uses Seattle local time (ported from the class app's ui.js).

export type Band = 0 | 1 | 2 | 3;
export type BandSel = Band | 'all';

const SEATTLE_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
});

export function seattleClock(date = new Date()): { hour: number; minute: number } {
  const parts = SEATTLE_FMT.formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return { hour, minute };
}

export const bandOfHour = (hour: number): Band => Math.floor((((hour % 24) + 24) % 24) / 6) as Band;
export const nowBand = (): Band => bandOfHour(seattleClock().hour);
export const isDarkBand = (band: BandSel) => band === 0 || band === 3;

export function clockLabel(hour: number, minute = 0): string {
  const h12 = ((hour + 11) % 12) + 1;
  return `${h12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

export function greeting(hour: number): string {
  if (hour < 5) return 'Hello';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Local Seattle date-time text, `addDays` days from today in Seattle. */
export function isoSeattle(hour: number, minute: number, addDays = 0): string {
  const now = new Date(Date.now() + addDays * 86400000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export const SHORT_HOURS: Record<string, string> = { all: '24 h', 0: '12–6 AM', 1: '6 AM–12', 2: '12–6 PM', 3: '6 PM–12' };
export const BAND_ORDER: BandSel[] = ['all', 1, 2, 3, 0];
