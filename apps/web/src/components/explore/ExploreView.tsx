// Explore (ported from the class app's explore.js): time of day with "Play the day", crime types, the GPU
// heatmap / risk grid / 3D risk skyline, stat tiles, the ranked areas, and pulsing blips on the riskiest blocks.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../context';
import { BAND_ORDER, SHORT_HOURS, bandOfHour, clockLabel, isDarkBand, nowBand, seattleClock, type BandSel } from '../../lib/clock';
import { fmt } from '../../lib/format';
import { tipNode } from '../../lib/map/controller';
import { HEAT_DARK, HEAT_LIGHT, LEVEL_COLOR } from '../../lib/map/style';
import { ALL_GROUPS, STREET_GROUPS, type RankRow } from '../../lib/risk';
import { readJson, writeJson } from '../../lib/storage';
import { BAND_ICON, Floating, Icon, LevelBadge } from '../ui';
import ExploreStats from './ExploreStats';
import RankList from './RankList';

type LayerKey = 'heat' | 'grid' | 'skyline';
interface ExploreState { band: BandSel; groups: number[]; layer: LayerKey }
const STATE_KEY = 'beacon.explore.v1';

function initialState(): ExploreState {
  const saved = readJson<Partial<ExploreState> | null>(STATE_KEY, null);
  return {
    band: saved?.band ?? nowBand(),
    groups: saved?.groups?.length ? saved.groups : [0, 1, 2, 3, 4, 5, 6],
    layer: saved?.layer === 'grid' || saved?.layer === 'skyline' ? saved.layer : 'heat',
  };
}

export default function ExploreView({ onWhereTo }: { onWhereTo: () => void }) {
  const { model, ctrl, threeD, setThreeD, toast } = useApp();
  const [state, setState] = useState<ExploreState>(initialState);
  const [playing, setPlaying] = useState(false);
  const [hood, setHood] = useState<number | null>(null);
  const { band, groups, layer } = state;
  const weights = useRef(new Map<string, [number, number, number][]>());

  useEffect(() => writeJson(STATE_KEY, state), [state]);
  const set = (patch: Partial<ExploreState>) => setState((s) => ({ ...s, ...patch }));

  // Play the day: morning, afternoon, evening, night, again and again. The map and the whole app follow.
  useEffect(() => {
    if (!playing) return;
    const order = [1, 2, 3, 0] as const;
    let i = Math.max(0, order.indexOf(band as 0 | 1 | 2 | 3));
    const stepOnce = () => { set({ band: order[i % order.length] }); i += 1; };
    stepOnce();
    const timer = window.setInterval(stepOnce, 2600);
    return () => window.clearInterval(timer);
    // only (re)start when play is pressed
  }, [playing]);

  const weightsFor = (b: BandSel) => {
    const key = `${b}|${[...groups].sort().join(',')}`;
    const hit = weights.current.get(key);
    if (hit) return hit;
    const pts: [number, number, number][] = [];
    for (const cell of model.cells.values()) {
      const w = model.countCell(cell, b, groups);
      if (w > 0) pts.push([cell.lat, cell.lng, w]);
    }
    weights.current.set(key, pts);
    return pts;
  };

  const ranking = useMemo(() => model.rankHoods(band, groups), [model, band, groups]);

  // Map: palette, layer, heat or grid, blips and hover text follow the selection.
  useEffect(() => {
    ctrl.setDark(isDarkBand(band));
    ctrl.setLayer(layer === 'heat' ? 'heat' : 'grid');
    ctrl.hideBuildings(layer === 'skyline');
    if (layer === 'heat') {
      // Max for the color ramp: 99.5th percentile, shared by the 4 bands so night looks calmer than evening.
      const pool: number[] = [];
      for (const b of band === 'all' ? (['all'] as BandSel[]) : ([0, 1, 2, 3] as BandSel[])) for (const p of weightsFor(b)) pool.push(p[2]);
      pool.sort((a, b) => a - b);
      ctrl.setHeat(weightsFor(band), pool.length ? pool[Math.floor(pool.length * 0.995)] || pool[pool.length - 1] : 1);
    } else {
      const cells = [];
      for (const cell of model.cells.values()) {
        const risk = model.riskAt(cell, band);
        const level = model.level(risk);
        if (level !== 'low') cells.push({ bounds: model.bounds(cell.id), level, risk });
      }
      ctrl.setGrid(cells);
    }
    // Radar blips on the 6 riskiest blocks for the selected time, at least 600 m apart.
    const ranked = [...model.cells.values()].sort((a, b) => model.riskAt(b, band) - model.riskAt(a, band));
    const picked: { lat: number; lng: number }[] = [];
    for (const c of ranked) {
      if (picked.length >= 6) break;
      if (picked.some((p) => Math.abs(p.lat - c.lat) < 0.0055 && Math.abs(p.lng - c.lng) < 0.008)) continue;
      picked.push({ lat: c.lat, lng: c.lng });
    }
    ctrl.setBlips(picked);
    ctrl.cellInfo = ({ lat, lng }) => {
      const cell = model.cellAt(lat, lng);
      if (!cell) return null;
      const count = model.countCell(cell, band, groups) / model.years;
      const level = model.level(model.riskAt(cell, band));
      const top = model.topGroups(cell.c, band, groups, 2);
      const when = band === 'all' ? 'all day' : model.bandLabel(band).toLowerCase();
      return {
        title: model.hoodName(cell.nb) ?? 'Seattle',
        lines: [
          `${fmt.perYear(count)} reports a year (${when})`,
          top.length ? `Mostly ${top.map((t) => t.label.toLowerCase()).join(', ')}` : 'No reports of these types',
          `Predicted risk: ${{ low: 'lower', elevated: 'elevated', high: 'high' }[level]}`,
        ],
      };
    };
  }, [ctrl, model, band, groups, layer]);

  // Leaving Explore clears its map layers.
  useEffect(() => () => {
    ctrl.cellInfo = null;
    ctrl.closeTip();
    ctrl.closePopup();
    ctrl.setBlips([]);
    ctrl.setHood(null);
    ctrl.setLayer('none');
    ctrl.hideBuildings(false);
  }, [ctrl]);

  useEffect(() => {
    if (hood === null) { ctrl.setHood(null); return; }
    const cells = [...model.cells.values()].filter((c) => c.nb === hood).map((c) => model.bounds(c.id));
    ctrl.setHood(cells);
  }, [ctrl, model, hood]);

  const pickBand = (b: BandSel) => { setPlaying(false); set({ band: b }); };
  const pickLayer = (l: LayerKey) => {
    set({ layer: l });
    if (l === 'skyline' && !threeD) setThreeD(true);
    if (l === 'skyline') ctrl.tilt();
    if (l === 'skyline') toast('3D risk skyline: taller, redder blocks have higher predicted risk. Drag with two fingers or right-click to tilt.');
  };
  const toggleGroup = (id: number, on: boolean) => {
    const next = on ? [...new Set([...groups, id])] : groups.filter((g) => g !== id);
    if (next.length) set({ groups: next.sort() });
  };

  const focusHood = (r: RankRow) => {
    setHood(r.i);
    ctrl.flyTo(r.hood.lat, r.hood.lng, 14);
    const lines = [
      `Danger index ${r.index} (rank ${ranking.indexOf(r) + 1} of ${ranking.length})`,
      `${fmt.perYear(r.perYear)} reports a year`,
      r.top ? `Mostly ${r.top.label.toLowerCase()}` : '',
      r.hood.precinct ? `${r.hood.precinct} precinct` : '',
    ];
    window.setTimeout(() => ctrl.popupAt(r.hood.lat, r.hood.lng, tipNode(r.hood.name, lines)), 1150);
  };

  const chipTotals = new Array<number>(8).fill(0);
  for (const hd of model.hoods) for (const b of model.bandList(band)) for (let g = 0; g < 8; g++) chipTotals[g] += hd.counts[b * 8 + g];
  const range = model.meta.dataRange;
  const fmtDate = (s: string | null) => (s ? new Date(`${s}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '?');
  const caption = band === 'all' ? 'all day' : model.bandLabel(band).toLowerCase();

  return (
    <section aria-label="Explore">
      <div className="section">
        <button className="search-btn" type="button" onClick={onWhereTo}>
          <Icon name="search" /><span>Where to? Find a safer route</span>
        </button>
      </div>

      <div className="section">
        <div className="row-between section-title">
          <span>Time of day</span>
          <span className="title-actions">
            <button className="play-btn" type="button" aria-pressed={playing} title="Watch crime move through a whole day" onClick={() => setPlaying(!playing)}>
              {playing ? 'Stop' : 'Play the day'}
            </button>
            <button className="link" type="button" onClick={() => pickBand(bandOfHour(seattleClock().hour))}>Now</button>
          </span>
        </div>
        <div className="seg seg-bands" role="radiogroup" aria-label="Time of day">
          {BAND_ORDER.map((b) => {
            const label = model.bandLabel(b);
            return (
              <label key={String(b)} title={b === 'all' ? 'All hours' : model.bandHours(b)} data-band={String(b)}>
                <input type="radio" name="band" value={String(b)} checked={band === b} onChange={() => pickBand(b)} aria-label={`${label}, ${SHORT_HOURS[String(b)]}`} />
                <span><Icon name={BAND_ICON[String(b)]} className="icon-sm" />{label}<small>{SHORT_HOURS[String(b)]}</small></span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="section">
        <div className="section-title"><span>Crime types</span>
          <span><button className="link" type="button" onClick={() => set({ groups: ALL_GROUPS })}>All</button> · <button className="link" type="button" onClick={() => set({ groups: STREET_GROUPS })}>Street safety</button></span>
        </div>
        <div className="chips">
          {model.groups.map((g) => (
            <label key={g.id} className="chip" title={`Severity weight ${g.severity}`}>
              <input type="checkbox" checked={groups.includes(g.id)} onChange={(e) => toggleGroup(g.id, e.target.checked)} />
              <span><Icon name="check" className="check" />{g.label}<span className="chip-count">{fmt.compact(chipTotals[g.id] / model.years)}</span></span>
            </label>
          ))}
        </div>
      </div>

      <div className="section">
        <div className="section-title"><span>Map layer</span></div>
        <div className="seg" role="radiogroup" aria-label="Map layer">
          {([['heat', 'Heatmap', 'where crime happened'], ['grid', 'Risk grid', 'model prediction'], ['skyline', '3D skyline', 'risk as towers']] as const).map(([k, t, s]) => (
            <label key={k}>
              <input type="radio" name="layer" value={k} checked={layer === k} onChange={() => pickLayer(k)} />
              <span>{t}<small>{s}</small></span>
            </label>
          ))}
        </div>
      </div>

      <ExploreStats band={band} groups={groups} top={ranking[0]} />
      <RankList ranking={ranking} caption={caption} selected={hood} onFocus={focusHood} />

      <p className="hint" style={{ marginTop: 18, textAlign: 'center' }}>
        Seattle Police reports from {fmtDate(range.from)} to {fmtDate(range.to)} · {fmt.int(model.meta.totals.incidents ?? 0)} reports
      </p>

      <Floating>
        <TimeBadge band={band} />
        <ExploreLegend band={band} layer={layer} />
      </Floating>
    </section>
  );
}

function TimeBadge({ band }: { band: BandSel }) {
  const { model } = useApp();
  const now = seattleClock();
  return (
    <div className="time-badge" aria-live="polite">
      <Icon name={BAND_ICON[String(band)]} />
      <span>{model.bandLabel(band)} <small>{model.bandHours(band)}</small></span>
      {band === bandOfHour(now.hour) && <small>· Seattle now {clockLabel(now.hour, now.minute)}</small>}
    </div>
  );
}

function ExploreLegend({ band, layer }: { band: BandSel; layer: LayerKey }) {
  const { model } = useApp();
  const when = model.bandLabel(band);
  if (layer === 'heat') {
    const ramp = isDarkBand(band) ? HEAT_DARK : HEAT_LIGHT;
    const stops = Object.entries(ramp).map(([k, c]) => `${c} ${Math.round(Number(k) * 100)}%`).join(', ');
    return (
      <div className="legend">
        <div className="legend-title">Reported crime<small>{when}</small></div>
        <div className="legend-ramp" style={{ background: `linear-gradient(90deg, rgba(255,255,255,0) 0%, ${stops})` }} />
        <div className="legend-scale"><span>Fewer</span><span>More reports</span></div>
        <div className="legend-note">Hover or tap the map for details. Red rings: riskiest blocks.</div>
      </div>
    );
  }
  const q = model.levels;
  return (
    <div className="legend">
      <div className="legend-title">Predicted risk<small>{when}</small></div>
      <div className="legend-levels">
        <div><span className="swatch" style={{ background: LEVEL_COLOR.high }} /><LevelBadge level="high" text="High" /><span className="tip-sub">≥ {q.high.toFixed(1)}</span></div>
        <div><span className="swatch" style={{ background: LEVEL_COLOR.elevated, opacity: 0.75 }} /><LevelBadge level="elevated" text="Elevated" /><span className="tip-sub">≥ {q.elevated.toFixed(1)}</span></div>
        <div><span className="swatch" style={{ background: 'transparent', border: '1px dashed var(--border-strong)' }} /><span>No color = lower risk</span></div>
      </div>
      <div className="legend-note">{layer === 'skyline' ? 'Tower height = predicted risk. ' : ''}ML model, all crime types weighted by severity. Score = expected weighted incidents a year in the block.</div>
    </div>
  );
}
