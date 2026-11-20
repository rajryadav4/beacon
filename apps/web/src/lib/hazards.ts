// Hazard keys, labels and safe-place kinds.
// The API (`GET /api/hazards`) is the source of truth; FALLBACK_HAZARDS mirrors it
// (apps/api/app/hazard_taxonomy.py) so the UI still works when that endpoint is down.

export type HazardKey =
  | 'earthquake' | 'tsunami' | 'flood' | 'storm' | 'winter' | 'wildfire' | 'heat'
  | 'air_quality' | 'hazmat' | 'volcano' | 'conflict' | 'crime' | 'other';

export interface Hazard { key: string; label: string; placeKinds: string[] }

export const FALLBACK_HAZARDS: Hazard[] = [
  { key: 'earthquake', label: 'Earthquake', placeKinds: ['assembly_point', 'emergency_hub', 'hospital', 'fire_station'] },
  { key: 'tsunami', label: 'Tsunami', placeKinds: ['emergency_hub', 'shelter', 'assembly_point'] },
  { key: 'flood', label: 'Flood', placeKinds: ['emergency_hub', 'shelter', 'assembly_point', 'community_centre'] },
  { key: 'storm', label: 'Severe storm, tornado or hurricane', placeKinds: ['shelter', 'bomb_shelter', 'community_centre', 'emergency_hub', 'hospital'] },
  { key: 'winter', label: 'Winter storm or extreme cold', placeKinds: ['shelter', 'community_centre', 'emergency_hub', 'hospital'] },
  { key: 'wildfire', label: 'Wildfire', placeKinds: ['shelter', 'community_centre', 'emergency_hub', 'hospital'] },
  { key: 'heat', label: 'Extreme heat', placeKinds: ['community_centre', 'shelter', 'hospital'] },
  { key: 'air_quality', label: 'Air quality or smoke', placeKinds: ['community_centre', 'shelter', 'hospital'] },
  { key: 'hazmat', label: 'Hazardous materials, chemical or radiological', placeKinds: ['shelter', 'hospital', 'emergency_hub'] },
  { key: 'volcano', label: 'Volcano', placeKinds: ['shelter', 'emergency_hub', 'community_centre', 'hospital'] },
  { key: 'conflict', label: 'Conflict, attack or civil danger', placeKinds: ['bomb_shelter', 'bunker', 'underground_station', 'shelter', 'hospital'] },
  { key: 'crime', label: 'Crime or police activity', placeKinds: ['police', 'fire_station', 'hospital'] },
  { key: 'other', label: 'Other emergency', placeKinds: ['emergency_hub', 'shelter', 'hospital', 'police', 'fire_station'] },
];

export function hazardLabel(hazards: Hazard[], key: string | null | undefined): string {
  if (!key) return 'Emergency';
  return hazards.find((h) => h.key === key)?.label
    ?? FALLBACK_HAZARDS.find((h) => h.key === key)?.label
    ?? key.replace(/_/g, ' ');
}

// Map colours per place kind (unknown kinds use OTHER_KIND_COLOR).
export const KIND_COLOR: Record<string, string> = {
  emergency_hub: '#2f9e44',
  shelter: '#0ca678',
  assembly_point: '#66a80f',
  community_centre: '#1098ad',
  hospital: '#d6336c',
  fire_station: '#e8590c',
  police: '#1c7ed6',
  underground_station: '#5f3dc4',
  bomb_shelter: '#495057',
  bunker: '#343a40',
};
export const OTHER_KIND_COLOR = '#868e96';

export const kindColor = (kind: string) => KIND_COLOR[kind] ?? OTHER_KIND_COLOR;

export const KIND_LABEL: Record<string, string> = {
  emergency_hub: 'Emergency hub', shelter: 'Shelter', assembly_point: 'Emergency assembly point',
  community_centre: 'Community centre', hospital: 'Hospital', fire_station: 'Fire station',
  police: 'Police station', underground_station: 'Underground station', bomb_shelter: 'Bomb shelter', bunker: 'Bunker',
};
