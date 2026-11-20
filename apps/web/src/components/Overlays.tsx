// Floating pieces over the map: boot screen, toast, danger banner, pick banner and the map buttons.

import { useEffect } from 'react';
import type { DangerNotice } from '../lib/danger';
import { Floating, Icon, Logo } from './ui';

export function Boot({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <div className="boot" role="status" aria-live="polite">
      <div className="boot-inner">
        <div className="radar" aria-hidden="true" />
        <div className="brand brand-lg" style={{ color: '#fff' }}><Logo size={44} /> Beacon</div>
        <div className={`boot-text${error ? ' boot-error' : ''}`}>{error ?? 'Loading 4 years of Seattle crime data and the map…'}</div>
        {error && <button className="btn btn-secondary" type="button" onClick={onRetry}>Try again</button>}
      </div>
    </div>
  );
}

export interface ToastState { id: number; message: string; actionLabel?: string; onAction?: () => void; duration: number }

export function Toast({ toast, onClose }: { toast: ToastState | null; onClose: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(onClose, toast.duration);
    return () => window.clearTimeout(t);
  }, [toast, onClose]);
  if (!toast) return null;
  return (
    <Floating>
      <div className="toast" role="status" aria-live="polite" key={toast.id}>
        <span>{toast.message}</span>
        {toast.actionLabel && toast.onAction && (
          <button className="link" type="button" onClick={() => { onClose(); toast.onAction?.(); }}>{toast.actionLabel}</button>
        )}
      </div>
    </Floating>
  );
}

export function DangerBanner({ notice, onClose }: { notice: DangerNotice | null; onClose: () => void }) {
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(onClose, 10000);
    return () => window.clearTimeout(t);
  }, [notice, onClose]);
  if (!notice) return null;
  return (
    <Floating>
      <div className="danger-banner" role="alert" key={notice.id}>
        <div className="d-icon"><Icon name="octagon" /></div>
        <div><b>{notice.title}</b><span>{notice.text}</span></div>
        <button className="btn btn-sm" type="button" onClick={onClose}>OK</button>
        <i className="banner-timer" aria-hidden="true" />
      </div>
    </Floating>
  );
}

export function PickBanner({ label, onCancel }: { label: string | null; onCancel: () => void }) {
  if (!label) return null;
  return (
    <Floating>
      <div className="pick-banner" role="status">
        <Icon name="crosshair" className="icon-sm" /><span>{label}</span>
        <button className="link" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </Floating>
  );
}

export function MapButtons({ threeD, onThreeD, onLocate, hidden3D }: { threeD: boolean; onThreeD: () => void; onLocate: () => void; hidden3D?: boolean }) {
  return (
    <Floating>
      <button className="map-btn" type="button" title="Show my location" aria-label="Show my location" onClick={onLocate}><Icon name="locate" /></button>
      {!hidden3D && (
        <button className="map-btn tilt-btn" type="button" title={threeD ? 'Back to 2D' : '3D view'} aria-label="3D view" aria-pressed={threeD} onClick={onThreeD}>3D</button>
      )}
    </Floating>
  );
}
