import type { BandKey, Meta } from '../api';
import { LEVEL_COLOR, type Layer } from './MapView';

export const BANDS: { key: BandKey | 'all'; label: string }[] = [
  { key: 'all', label: 'All day' },
  { key: 'morning', label: 'Morning' },
  { key: 'afternoon', label: 'Afternoon' },
  { key: 'evening', label: 'Evening' },
  { key: 'night', label: 'Night' },
];

interface Props {
  meta: Meta | null;
  layer: Layer;
  onLayer: (layer: Layer) => void;
  band: BandKey | 'all';
  riskBand: BandKey;
  onBand: (band: BandKey | 'all') => void;
  groups: string[];
  onGroups: (groups: string[]) => void;
  extrude: boolean;
  onExtrude: (on: boolean) => void;
  showPlaces: boolean;
  onShowPlaces: (on: boolean) => void;
  showAlerts: boolean;
  onShowAlerts: (on: boolean) => void;
}

/** Map tab: crime heatmap / ML risk grid (Seattle) and the overlay toggles. */
export default function CrimeLayers(p: Props) {
  const { meta, layer, band, riskBand, groups } = p;
  const toggleGroup = (key: string) =>
    p.onGroups(groups.includes(key) ? groups.filter((k) => k !== key) : [...groups, key]);

  return (
    <>
      <section aria-labelledby="overlay-h">
        <h2 id="overlay-h">Show on map</h2>
        <label className="toggle">
          <input type="checkbox" checked={p.showAlerts} onChange={(e) => p.onShowAlerts(e.target.checked)} /> Official alert areas
        </label>
        <label className="toggle">
          <input type="checkbox" checked={p.showPlaces} onChange={(e) => p.onShowPlaces(e.target.checked)} /> Safe places
        </label>
      </section>

      <section aria-labelledby="crime-h">
        <h2 id="crime-h">Crime in Seattle</h2>
        <div className="segmented" role="radiogroup" aria-label="Crime layer">
          <button role="radio" aria-checked={layer === 'heatmap'} onClick={() => p.onLayer('heatmap')}>Heatmap</button>
          <button role="radio" aria-checked={layer === 'risk'} onClick={() => p.onLayer('risk')}>Risk grid (ML)</button>
          <button role="radio" aria-checked={layer === 'none'} onClick={() => p.onLayer('none')}>Off</button>
        </div>
      </section>

      {layer !== 'none' && (
        <section aria-labelledby="band-h">
          <h2 id="band-h">Time of day</h2>
          <div className="chips">
            {BANDS.filter((b) => layer === 'heatmap' || b.key !== 'all').map((b) => {
              const active = layer === 'risk' ? riskBand === b.key : band === b.key;
              return (
                <button key={b.key} className="chip" aria-pressed={active} onClick={() => p.onBand(b.key)}>
                  {b.label}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {layer === 'heatmap' && meta && (
        <section aria-labelledby="types-h">
          <h2 id="types-h">Crime types <span className="hint">{groups.length ? `${groups.length} selected` : 'all'}</span></h2>
          <div className="chips">
            {meta.groups.map((g) => (
              <button key={g.key} className="chip" aria-pressed={groups.includes(g.key)} onClick={() => toggleGroup(g.key)}>
                {g.label}
              </button>
            ))}
            {groups.length > 0 && <button className="chip clear" onClick={() => p.onGroups([])}>Clear</button>}
          </div>
        </section>
      )}

      {layer === 'risk' && (
        <section aria-labelledby="level-h">
          <h2 id="level-h">Risk level</h2>
          <ul className="legend">
            {(['low', 'elevated', 'high'] as const).map((lvl) => (
              <li key={lvl}><span className="swatch" style={{ background: LEVEL_COLOR[lvl] }} />{lvl}
                {meta?.risk.levels && lvl !== 'low' && <small> &ge; {meta.risk.levels[lvl]}</small>}
              </li>
            ))}
          </ul>
          <label className="toggle">
            <input type="checkbox" checked={p.extrude} onChange={(e) => p.onExtrude(e.target.checked)} /> 3D skyline
            <small className="hint">replaces the 3D buildings</small>
          </label>
          <p className="note">Expected severity-weighted reported incidents per year in each ~225 m block during this time of day.</p>
        </section>
      )}
    </>
  );
}
