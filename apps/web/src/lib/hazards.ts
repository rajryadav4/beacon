// Hazard keys, labels and safe-place kinds.
// The API (`GET /api/hazards`) is the source of truth; FALLBACK_HAZARDS mirrors
// apps/api/app/hazard_taxonomy.py so the UI still works when that endpoint is down.

export type HazardKey =
  | 'earthquake' | 'tsunami' | 'flood' | 'storm' | 'winter' | 'wildfire' | 'heat'
  | 'air_quality' | 'hazmat' | 'volcano' | 'conflict' | 'crime' | 'other';

export interface Hazard { key: string; label: string; placeKinds: string[] }

export const FALLBACK_HAZARDS: Hazard[] = [
  { key: 'earthquake', label: 'Earthquake', placeKinds: ['assembly_point', 'shelter', 'hospital', 'fire_station'] },
  { key: 'tsunami', label: 'Tsunami', placeKinds: ['assembly_point', 'shelter', 'hospital'] },
  { key: 'flood', label: 'Flood', placeKinds: ['shelter', 'community_centre', 'school', 'hospital'] },
  { key: 'storm', label: 'Severe storm, tornado or hurricane', placeKinds: ['shelter', 'community_centre', 'school', 'hospital'] },
  { key: 'winter', label: 'Winter storm or extreme cold', placeKinds: ['shelter', 'community_centre', 'library', 'hospital'] },
  { key: 'wildfire', label: 'Wildfire', placeKinds: ['shelter', 'community_centre', 'hospital'] },
  { key: 'heat', label: 'Extreme heat', placeKinds: ['shelter', 'community_centre', 'library', 'hospital'] },
  { key: 'air_quality', label: 'Air quality or smoke', placeKinds: ['library', 'community_centre', 'shelter', 'hospital'] },
  { key: 'hazmat', label: 'Hazardous materials, chemical or radiological', placeKinds: ['shelter', 'hospital', 'community_centre'] },
  { key: 'volcano', label: 'Volcano', placeKinds: ['shelter', 'assembly_point', 'hospital'] },
  { key: 'conflict', label: 'Conflict, attack or civil danger', placeKinds: ['bunker', 'shelter', 'subway_station', 'hospital'] },
  { key: 'crime', label: 'Crime or police activity', placeKinds: ['police', 'fire_station', 'hospital'] },
  { key: 'other', label: 'Other emergency', placeKinds: ['shelter', 'hospital', 'police', 'fire_station'] },
];

export function hazardLabel(hazards: Hazard[], key: string | null | undefined): string {
  if (!key) return 'Emergency';
  return hazards.find((h) => h.key === key)?.label
    ?? FALLBACK_HAZARDS.find((h) => h.key === key)?.label
    ?? key.replace(/_/g, ' ');
}

// Map colours per place kind (unknown kinds use OTHER_KIND_COLOR).
export const KIND_COLOR: Record<string, string> = {
  hospital: '#d6336c',
  clinic: '#e64980',
  police: '#1c7ed6',
  fire_station: '#e8590c',
  shelter: '#2f9e44',
  bunker: '#495057',
  subway_station: '#5f3dc4',
  assembly_point: '#0ca678',
  community_centre: '#1098ad',
  school: '#f59f00',
  library: '#7048e8',
  pharmacy: '#c2255c',
};
export const OTHER_KIND_COLOR = '#868e96';

export const kindColor = (kind: string) => KIND_COLOR[kind] ?? OTHER_KIND_COLOR;

export const KIND_LABEL: Record<string, string> = {
  hospital: 'Hospital', clinic: 'Clinic', police: 'Police station', fire_station: 'Fire station',
  shelter: 'Shelter', bunker: 'Bunker', subway_station: 'Underground station', assembly_point: 'Assembly point',
  community_centre: 'Community centre', school: 'School', library: 'Library', pharmacy: 'Pharmacy',
};
