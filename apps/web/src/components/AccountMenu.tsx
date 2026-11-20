// "You" menu (class app's account menu, kept in this browser): usual travel mode, safety vs speed,
// danger alerts, saved places, trip history, data info and the Test Beacon link.

import { useEffect, useRef } from 'react';
import { useApp } from '../context';
import { fmt, formatDistance, relativeTime } from '../lib/format';
import { MODES } from '../lib/risk';
import { Icon, KIND_ICON, LevelBadge, MODE_ICON } from './ui';

function weightText(pct: number) {
  if (pct >= 90) return 'Always pick the safest route, even if it takes longer.';
  if (pct <= 10) return 'Always pick the fastest route.';
  return `Routes are ranked ${pct}% on safety and ${100 - pct}% on travel time.`;
}

export default function AccountMenu({ open, onClose, onTrip }: { open: boolean; onClose: () => void; onTrip: (to: { lat: number; lng: number; name: string }) => void }) {
  const { prefs, setPrefs, places, setPlaces, trips, model, live, toast } = useApp();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || (t as Element).closest?.('.avatar')) return;
      onClose();
    };
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', down, true);
    ref.current?.querySelector<HTMLElement>('input, button')?.focus();
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', down, true); };
  }, [open, onClose]);

  if (!open) return null;
  const pct = Math.round(prefs.safetyWeight * 100);
  const order = { home: 0, work: 1, saved: 2 };
  const meta = model.meta;
  const remove = (id: string) => {
    const gone = places.find((p) => p.id === id);
    setPlaces(places.filter((p) => p.id !== id));
    if (gone) toast(`Removed ${gone.label}.`, { actionLabel: 'Undo', onAction: () => setPlaces([...places]) });
  };

  return (
    <div className="account-menu" role="dialog" aria-label="Your settings" ref={ref}>
      <div className="account-head">
        <span className="avatar-lg" aria-hidden="true"><Icon name="user" /></span>
        <div style={{ flex: 1, minWidth: 0 }}><b>Your places and settings</b><span>Stored only in this browser</span></div>
        <button className="icon-btn" type="button" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
      </div>
      <div>
        <div className="section-title"><span>How I usually travel</span></div>
        <div className="seg" role="radiogroup" aria-label="Usual travel mode">
          {MODES.map((m) => (
            <label key={m}>
              <input type="radio" name="pref-mode" checked={prefs.mode === m} onChange={() => setPrefs({ ...prefs, mode: m })} />
              <span><Icon name={MODE_ICON[m]} className="icon-sm" />{model.modes[m]?.label ?? m}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="menu-section">
        <div className="section-title"><span>Route choice</span></div>
        <input className="range" type="range" min={0} max={100} step={10} value={pct} aria-label="Safety versus speed" aria-valuetext={weightText(pct)}
          onChange={(e) => setPrefs({ ...prefs, safetyWeight: Number(e.target.value) / 100 })} />
        <div className="range-labels"><span>Fastest</span><span>Safest</span></div>
        <p className="hint">{weightText(pct)}</p>
      </div>
      <div className="menu-section switch-row">
        <div><b>Danger alerts</b><p className="hint" style={{ margin: '2px 0 0' }}>Warn me before I enter a high-risk block. Uses my location in Seattle, only if I already allowed it.</p></div>
        <label className="toggle"><input type="checkbox" checked={prefs.alerts} aria-label="Danger alerts" onChange={(e) => setPrefs({ ...prefs, alerts: e.target.checked })} /><span /></label>
      </div>
      <div className="menu-section">
        <div className="section-title"><span>Saved places</span></div>
        <ul className="place-list">
          {!places.length && <li style={{ display: 'block' }}><span className="hint">No saved places yet. Tap the star next to a destination to save it.</span></li>}
          {[...places].sort((a, b) => order[a.kind] - order[b.kind]).map((p) => (
            <li key={p.id}>
              <span className="s-icon"><Icon name={KIND_ICON[p.kind] ?? 'star'} className="icon-sm" /></span>
              <span style={{ minWidth: 0 }}><div className="p-name">{p.label}</div><div className="p-addr">{p.address}</div></span>
              <button className="icon-btn" type="button" aria-label={`Remove ${p.label}`} onClick={() => remove(p.id)}><Icon name="trash" className="icon-sm" /></button>
            </li>
          ))}
        </ul>
      </div>
      <div className="menu-section">
        <div className="section-title"><span>Trip history</span></div>
        <ul className="place-list">
          {!trips.length && <li style={{ display: 'block' }}><span className="hint">Trips you start or simulate appear here.</span></li>}
          {trips.slice(0, 8).map((t) => (
            <li key={t.id}>
              <span className="s-icon"><Icon name={MODE_ICON[t.mode]} className="icon-sm" /></span>
              <button className="trip-row" type="button" onClick={() => onTrip({ lat: t.toLat, lng: t.toLng, name: t.toLabel })}>
                <div className="p-name">{t.toLabel}</div>
                <div className="p-addr">from {t.fromLabel} · {formatDistance(t.distanceMeters)} · {relativeTime(t.createdAt)}</div>
              </button>
              <LevelBadge level={t.riskLevel} text={String(t.riskScore)} />
            </li>
          ))}
        </ul>
      </div>
      <div className="menu-section">
        <div className="section-title"><span>About the data</span></div>
        <p className="hint" style={{ margin: 0 }}>
          {live ? 'Live: Beacon API (PostgreSQL)' : 'Offline copy of the data (the API did not answer)'}. {fmt.int(meta.totals.incidents ?? 0)} Seattle Police reports,
          {' '}{meta.dataRange.from} to {meta.dataRange.to}. Risk model: {meta.model?.version ?? 'baseline'}. Reported crime only, not a guarantee of safety.
        </p>
      </div>
      <div className="menu-section">
        <a className="btn btn-secondary btn-block" href="/simulator.html"><Icon name="test" className="icon-sm" />Test Beacon (alert simulator)</a>
      </div>
    </div>
  );
}
