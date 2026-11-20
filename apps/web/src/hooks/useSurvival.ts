// When is survival mode on, and for which hazard? A real alert with survival:true, the manual switch, or a DEMO.
// Auto survival is keyed by the alerts that caused it, so "I'm safe" lasts until a new alert arrives.

import { useMemo, useState } from 'react';
import type { ActiveAlerts, Alert, Hazard } from '../api';
import { makeDemoAlert } from '../lib/demo';
import { SEVERITY_RANK } from '../lib/format';
import { hazardLabel } from '../lib/hazards';

export function useSurvival(data: ActiveAlerts | null, hazards: Hazard[]) {
  const [manualHazard, setManualHazard] = useState<string | null>(null);
  const [demoAlert, setDemoAlert] = useState<Alert | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  const alerts = useMemo(() => {
    const real = [...(data?.alerts ?? [])].sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));
    return demoAlert ? [demoAlert, ...real] : real;
  }, [data, demoAlert]);
  const topHazard = demoAlert?.hazard ?? data?.topHazard ?? alerts[0]?.hazard ?? null;
  const autoKey = demoAlert ? String(demoAlert.id)
    : data?.survival ? `api:${alerts.map((a) => String(a.id)).sort().join(',')}` : null;
  const on = manualHazard !== null || (autoKey !== null && autoKey !== dismissedKey);
  const hazard = manualHazard ?? topHazard ?? 'other';
  const alert = manualHazard
    ? alerts.find((a) => a.hazard === manualHazard) ?? null
    : alerts.find((a) => a.hazard === hazard) ?? alerts[0] ?? null;

  return {
    alerts, topHazard, on, hazard, alert,
    label: alert?.hazardLabel || hazardLabel(hazards, hazard),
    demoActive: demoAlert !== null,
    start: (h: string) => setManualHazard(h),
    demo: (h: string) => setDemoAlert(makeDemoAlert(h, hazardLabel(hazards, h))),
    clearDemo: () => setDemoAlert(null),
    exit: () => { setManualHazard(null); setDemoAlert(null); setDismissedKey(autoKey); },
  };
}
