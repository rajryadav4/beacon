// Locally simulated alerts for showing survival mode when no real alert is active.
// They never leave the browser and are always marked DEMO.

import type { Alert } from '../api';
import { guidanceFor } from './guidance';

export function makeDemoAlert(hazard: string, label: string): Alert {
  const now = Date.now();
  return {
    id: `demo-${hazard}-${now}`,
    source: 'demo',
    event: `DEMO: ${label} warning`,
    hazard,
    hazardLabel: label,
    severity: 'Extreme',
    urgency: 'Immediate',
    certainty: 'Observed',
    headline: `DEMO: ${label} warning for your area. This is a simulation, not a real alert.`,
    description: 'Simulated alert created in this browser to show Beacon survival mode. No official agency issued it.',
    instruction: `${guidanceFor(hazard).now} (Simulated instruction for the demo.)`,
    areaDesc: 'Your area (simulated)',
    sender: 'Beacon demo, not an official source',
    effective: new Date(now).toISOString(),
    expires: new Date(now + 60 * 60000).toISOString(),
    url: null,
    magnitude: null,
    distanceKm: null,
    demo: true,
  };
}
