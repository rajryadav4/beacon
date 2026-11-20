import { useEffect, useMemo, useState } from 'react';
import { api, type BandKey, type HeatmapData, type Meta, type RiskData } from './api';
import MapView, { LEVEL_COLOR, type Layer } from './components/MapView';

const BANDS: { key: BandKey | 'all'; label: string }[] = [
  { key: 'all', label: 'All day' },
  { key: 'morning', label: 'Morning' },
  { key: 'afternoon', label: 'Afternoon' },
  { key: 'evening', label: 'Evening' },
  { key: 'night', label: 'Night' },
];

/** The band that is happening now in Seattle (the default for the risk grid). */
function currentBand(): BandKey {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Los_Angeles',
  }).format(new Date()));
  return (['night', 'morning', 'afternoon', 'evening'] as const)[Math.floor(hour / 6)];
}

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [layer, setLayer] = useState<Layer>('heatmap');
  const [band, setBand] = useState<BandKey | 'all'>('all');
  const [groups, setGroups] = useState<string[]>([]);   // empty = every group
  const [extrude, setExtrude] = useState(false);
  const [heatmap, setHeatmap] = useState<HeatmapData | null>(null);
  const [risk, setRisk] = useState<RiskData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    api.meta(ctrl.signal).then(setMeta).catch((e) => { if (!ctrl.signal.aborted) setError(String(e)); });
    return () => ctrl.abort();
  }, []);

  // The risk grid has no "all day": switching to it picks the current band.
  const riskBand: BandKey = band === 'all' ? currentBand() : band;

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    const request = layer === 'heatmap'
      ? api.heatmap(band, groups, ctrl.signal).then(setHeatmap)
      : api.risk(riskBand, ctrl.signal).then(setRisk);
    request
      .then(() => setError(null))
      .catch((e) => { if (!ctrl.signal.aborted) setError(String(e)); })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [layer, band, riskBand, groups]);

  const shown = useMemo(() => {
    if (layer === 'heatmap' && heatmap) {
      return `${heatmap.features.reduce((s, f) => s + f.properties.count, 0).toLocaleString()} incidents in ${heatmap.features.length.toLocaleString()} blocks`;
    }
    if (layer === 'risk' && risk) {
      const high = risk.features.filter((f) => f.properties.level === 'high').length;
      return `${risk.features.length.toLocaleString()} blocks scored, ${high} high risk`;
    }
    return '';
  }, [layer, heatmap, risk]);

  const toggleGroup = (key: string) =>
    setGroups((g) => (g.includes(key) ? g.filter((k) => k !== key) : [...g, key]));

  return (
    <div className="app">
      <MapView layer={layer} heatmap={heatmap} risk={risk} extrude={extrude} />

      <aside className="panel" aria-label="Map controls">
        <header className="brand">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <div>
            <h1>CrimeRadar</h1>
            <p>Seattle reported crime and block risk</p>
          </div>
        </header>

        <div className="segmented" role="tablist" aria-label="Layer">
          <button role="tab" aria-selected={layer === 'heatmap'} onClick={() => setLayer('heatmap')}>Heatmap</button>
          <button role="tab" aria-selected={layer === 'risk'} onClick={() => setLayer('risk')}>Risk grid (ML)</button>
        </div>

        <section>
          <h2>Time of day</h2>
          <div className="chips">
            {BANDS.filter((b) => layer === 'heatmap' || b.key !== 'all').map((b) => {
              const active = layer === 'risk' ? riskBand === b.key : band === b.key;
              return (
                <button key={b.key} className="chip" aria-pressed={active} onClick={() => setBand(b.key)}>
                  {b.label}
                </button>
              );
            })}
          </div>
        </section>

        {layer === 'heatmap' && meta && (
          <section>
            <h2>Crime types <span className="hint">{groups.length ? `${groups.length} selected` : 'all'}</span></h2>
            <div className="chips">
              {meta.groups.map((g) => (
                <button key={g.key} className="chip" aria-pressed={groups.includes(g.key)} onClick={() => toggleGroup(g.key)}>
                  {g.label}
                </button>
              ))}
              {groups.length > 0 && <button className="chip clear" onClick={() => setGroups([])}>Clear</button>}
            </div>
          </section>
        )}

        {layer === 'risk' && (
          <section>
            <h2>Risk level</h2>
            <ul className="legend">
              {(['low', 'elevated', 'high'] as const).map((lvl) => (
                <li key={lvl}><span className="swatch" style={{ background: LEVEL_COLOR[lvl] }} />{lvl}
                  {meta?.risk.levels && lvl !== 'low' && <small> &ge; {meta.risk.levels[lvl]}</small>}
                </li>
              ))}
            </ul>
            <label className="toggle">
              <input type="checkbox" checked={extrude} onChange={(e) => setExtrude(e.target.checked)} /> 3D skyline
            </label>
            <p className="note">Expected severity-weighted reported incidents per year in each ~225 m block during this time of day.</p>
          </section>
        )}

        <p className="status" aria-live="polite">
          {error ? <span className="error">Could not load data: {error}</span> : loading ? 'Loading…' : shown}
        </p>

        {meta && (
          <footer className="fresh">
            Data: <a href={meta.source?.url} target="_blank" rel="noreferrer">SPD crime reports</a>{' '}
            {meta.dataRange.from} to {meta.dataRange.to}
            {meta.model && <> · model {meta.model.version}</>}
            <br />Reported crime only, not a guarantee of safety.
          </footer>
        )}
      </aside>
    </div>
  );
}
