// Stat tiles: reports a year, peak time, most dangerous area and the ML model's accuracy.

import { useApp } from '../../context';
import type { BandSel } from '../../lib/clock';
import { fmt } from '../../lib/format';
import type { RankRow } from '../../lib/risk';
import { LevelBadge, Ring } from '../ui';

export default function ExploreStats({ band, groups, top }: { band: BandSel; groups: number[]; top: RankRow | undefined }) {
  const { model } = useApp();
  const perBand = [0, 0, 0, 0];
  for (const hd of model.hoods) for (let b = 0; b < 4; b++) for (const g of groups) perBand[b] += hd.counts[b * 8 + g];
  const total = model.bandList(band).reduce<number>((s, b) => s + perBand[b], 0);
  const all = perBand.reduce((s, x) => s + x, 0) || 1;
  const peak = perBand.indexOf(Math.max(...perBand));
  const when = band === 'all' ? 'all day' : model.bandLabel(band).toLowerCase();
  const m = model.meta.model;
  const capture = m?.metrics?.hotspotCapture10;
  const base = m?.baseline?.hotspotCapture10;
  const rho = m?.metrics?.spearman;

  return (
    <div className="section">
      <div className="stats">
        <div className="stat">
          <div className="stat-label">Reports a year</div>
          <div className="stat-value">{fmt.compact(total / model.years)}</div>
          <div className="stat-sub">{when}, selected types</div>
        </div>
        <div className="stat">
          <div className="stat-label">Peak time</div>
          <div className="stat-value">{model.bands[peak]?.label}</div>
          <div className="stat-sub">{fmt.pct(perBand[peak] / all)} of reports</div>
        </div>
        {top && (
          <div className="stat stat-wide stat-top">
            <div className="stat-label">Most dangerous area · {when}</div>
            <div className="row-between">
              <div className="stat-value">{top.hood.name}</div>
              <LevelBadge level="high" text="Index 100" />
            </div>
            <div className="stat-sub">{fmt.perYear(top.perYear)} reports a year · mostly {top.top ? top.top.label.toLowerCase() : 'mixed'}</div>
          </div>
        )}
        {capture != null && (
          <div className="stat stat-wide stat-hero">
            <Ring value={capture * 100} size={72} stroke={8} color="#6d5dfc" text={fmt.pct(capture)} className="ring-lg" />
            <div>
              <div className="stat-label">ML model accuracy</div>
              <div className="stat-sub">
                of the test year's weighted crime happened in the 10% of blocks the model flagged.
                {base != null && ` Simple history: ${fmt.pct(base)}.`}
                {rho != null && ` Rank match ${rho.toFixed(2)}${m?.baseline?.spearman != null ? ` vs ${m.baseline.spearman.toFixed(2)}` : ''}.`}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
