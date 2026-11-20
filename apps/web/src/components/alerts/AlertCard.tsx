import type { Alert, AlertsStatus } from '../../api';
import { formatTime, relativeTime, severityColor } from '../../lib/format';

interface SourceFreshness { name: string; ok: boolean; at: string | null; error: string | null }

/** Normalise `/api/alerts/status`, which may be `{sources: [...]}` or `{nws: {...}, usgs: {...}}`. */
export function sourceFreshness(status: AlertsStatus | null): SourceFreshness[] {
  if (!status) return [];
  const pick = (o: Record<string, unknown>, keys: string[]) => {
    for (const k of keys) if (typeof o[k] === 'string') return o[k] as string;
    return null;
  };
  const toRow = (name: string, value: unknown): SourceFreshness | null => {
    if (!value || typeof value !== 'object') return null;
    const o = value as Record<string, unknown>;
    const error = pick(o, ['error', 'lastError']);
    return {
      name: pick(o, ['label', 'name', 'source']) ?? name,
      at: pick(o, ['lastSuccess', 'lastSuccessAt', 'updatedAt', 'fetchedAt', 'lastFetch', 'lastRun']),
      ok: typeof o.ok === 'boolean' ? o.ok : typeof o.stale === 'boolean' ? !o.stale : !error,
      error,
    };
  };
  const list = Array.isArray(status.sources)
    ? (status.sources as unknown[]).map((v, i) => toRow(`source ${i + 1}`, v))
    : Object.entries((status.sources as Record<string, unknown>) ?? status).map(([k, v]) => toRow(k, v));
  return list.filter((r): r is SourceFreshness => r !== null);
}

export default function AlertCard({ alert, open }: { alert: Alert; open?: boolean }) {
  const color = severityColor(alert.severity);
  return (
    <article className={`alert-card${alert.demo ? ' demo' : ''}`} style={{ '--sev': color } as React.CSSProperties}>
      <header>
        <span className="sev">{alert.severity || 'Unknown'}</span>
        {alert.demo && <span className="demo-tag">DEMO</span>}
        <h3>{alert.event}</h3>
      </header>
      {alert.headline && <p className="headline">{alert.headline}</p>}
      <p className="meta">
        {alert.sender && <>{alert.sender} · </>}
        {alert.expires ? <>expires {formatTime(alert.expires)} ({relativeTime(alert.expires)})</> : alert.effective && <>issued {formatTime(alert.effective)}</>}
        {alert.magnitude != null && <> · M{alert.magnitude.toFixed(1)}</>}
        {alert.distanceKm != null && alert.distanceKm > 0 && <> · {alert.distanceKm.toFixed(0)} km away</>}
      </p>
      {alert.instruction && (
        <div className="instruction">
          <strong>Official instructions</strong>
          <p>{alert.instruction}</p>
        </div>
      )}
      {alert.description && (
        <details open={open}>
          <summary>Details{alert.areaDesc ? ` · ${alert.areaDesc}` : ''}</summary>
          <p className="desc">{alert.description}</p>
        </details>
      )}
      {alert.url && /^https?:/.test(alert.url) && (
        <a className="source" href={alert.url} target="_blank" rel="noreferrer">Read the official alert ↗</a>
      )}
    </article>
  );
}
