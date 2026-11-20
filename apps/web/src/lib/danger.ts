// Danger alerts: a warning before the traveller enters a high-risk block, adjusted for the travel mode.
// Ported from the class app (assets/js/trip.js, DangerAlerts). The banner itself is a React component.

import type { Band } from './clock';
import { fmt } from './format';
import type { Pt } from './geo';
import { STREET_GROUPS, type Cell, type Mode, type RiskModel } from './risk';

const TIPS: Record<Mode, string> = {
  walk: 'Stay on busy, well-lit streets and keep your phone out of sight.',
  bike: 'Stay on main streets and keep moving; lock your bike where people can see it.',
  car: 'Keep the doors locked and valuables out of sight when you park.',
};

export interface DangerHit { cell: Cell; kind: 'inside' | 'ahead' }
export interface DangerNotice { id: number; title: string; text: string; area: string; ahead: boolean }

export class DangerAlerts {
  private warned = new Map<string, number>();
  private lastAt = 0;
  private ctx: AudioContext | null = null;
  private seq = 0;
  sound = true;

  constructor(private model: RiskModel, private show: (n: DangerNotice) => void) {}

  reset() {
    this.warned.clear();
    this.lastAt = 0;
  }

  /** High-risk block here or just ahead? */
  evaluate(lat: number, lng: number, band: Band, mode: Mode, ahead: Pt[] = []): DangerHit | null {
    const vul = this.model.vulnerability(mode);
    const isHigh = (cell: Cell | null) => cell !== null && this.model.level(this.model.riskAt(cell, band) * vul) === 'high';
    const here = this.model.cellAt(lat, lng);
    if (here && isHigh(here)) return { cell: here, kind: 'inside' };
    for (const p of ahead) {
      const cell = this.model.cellAt(p[0], p[1]);
      if (cell && isHigh(cell)) return { cell, kind: 'ahead' };
    }
    return null;
  }

  /** Show the alert unless this area was announced recently. */
  maybeWarn(hit: DangerHit | null, band: Band, mode: Mode, { areaCooldown = 120000, globalCooldown = 15000 } = {}): DangerNotice | null {
    if (!hit) return null;
    const now = Date.now();
    const key = hit.cell.nb >= 0 ? `nb${hit.cell.nb}` : `c${hit.cell.id}`;
    const last = this.warned.get(key);
    if (last !== undefined && now - last < areaCooldown) return null;
    if (this.lastAt && now - this.lastAt < globalCooldown) return null;
    this.warned.set(key, now);
    this.lastAt = now;
    return this.notify(hit, band, mode);
  }

  private notify(hit: DangerHit, band: Band, mode: Mode): DangerNotice {
    const cell = hit.cell;
    const m = this.model;
    const area = m.hoodName(cell.nb) ?? 'this area';
    const perYear = m.countCell(cell, band, STREET_GROUPS) / m.years;
    const top = m.topGroups(cell.c, band, STREET_GROUPS, 2).map((t) => t.label.toLowerCase());
    const when = m.bands[band].label.toLowerCase();
    const ahead = hit.kind === 'ahead';
    const title = ahead ? `High-risk area ahead · ${area}` : `You are in a high-risk area · ${area}`;
    const text = `${fmt.perYear(perYear)} street crimes a year on this block in the ${when}${top.length ? `, mostly ${top.join(' and ')}` : ''}. ${TIPS[mode]}`;
    const notice = { id: ++this.seq, title, text, area, ahead };
    this.show(notice);
    const activated = !('userActivation' in navigator) || (navigator as Navigator & { userActivation: { hasBeenActive: boolean } }).userActivation.hasBeenActive;
    if (navigator.vibrate && activated) navigator.vibrate([180, 90, 180]);
    if (this.sound) this.beep();
    return notice;
  }

  private beep() {
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = this.ctx ?? new AC();
      const ctx = this.ctx;
      const t = ctx.currentTime;
      [880, 660].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t + i * 0.16);
        gain.gain.exponentialRampToValueAtTime(0.12, t + i * 0.16 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.14);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t + i * 0.16);
        osc.stop(t + i * 0.16 + 0.15);
      });
    } catch {
      // sound is optional
    }
  }
}
