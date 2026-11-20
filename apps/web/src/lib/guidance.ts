// Short, plain-words guidance per hazard, written for Beacon from widely published
// official advice (Ready.gov, FEMA, NOAA/NWS, CDC, US EPA AirNow, USGS).
// Official instructions in an alert always come first; this is the backup checklist.

import type { HazardKey } from './hazards';

export interface Guidance {
  /** One line: the single most important action. */
  now: string;
  /** Ordered checklist, most urgent first. */
  steps: string[];
}

export const GUIDANCE: Record<HazardKey, Guidance> = {
  earthquake: {
    now: 'Drop, cover, hold on until the shaking stops.',
    steps: [
      'Drop to your hands and knees. Cover your head and neck under a sturdy table or next to an inside wall. Hold on.',
      'Stay where you are until the shaking stops. Do not run outside during shaking.',
      'If you are outdoors, move away from buildings, trees, streetlights and power lines, then drop.',
      'After the shaking, expect aftershocks. Check yourself and others for injuries.',
      'Leave damaged buildings and move to open ground away from buildings. Use stairs, not elevators.',
      'If you smell gas, get out and do not use flames or light switches.',
      'Near the coast, if the shaking was strong or long: go to high ground now. A tsunami may follow.',
    ],
  },
  tsunami: {
    now: 'Go to high ground or inland immediately.',
    steps: [
      'Go to high ground or as far inland as you can, right now. Go on foot if you can.',
      'Do not wait for an official order if you feel strong shaking near the coast, see the sea pull back, or hear a roar from the ocean.',
      'If you cannot leave the area, go to an upper floor or the roof of a tall, sturdy building.',
      'Stay away from the coast. More waves can come for hours, and the first is often not the largest.',
      'Go back only when officials say it is safe.',
    ],
  },
  flood: {
    now: 'Move to higher ground. Never walk or drive through flood water.',
    steps: [
      'Move to higher ground now. Leave if you are told to evacuate.',
      'Never walk, swim or drive through flood water. 15 cm (6 in) of moving water can knock you down; 30 cm (1 ft) can carry a car away.',
      'Turn around, don\'t drown: find another way.',
      'Stay off bridges over fast-moving water.',
      'If you are trapped in a building, go to the highest floor. Go onto the roof only if you must, and signal for help. Do not climb into a closed attic.',
      'Stay away from downed power lines and anything electrical in water.',
    ],
  },
  storm: {
    now: 'Get inside a sturdy building, to an inner room away from windows.',
    steps: [
      'Tornado: go to a basement, or a small inner room on the lowest floor with no windows (bathroom, closet, hallway).',
      'Stay away from windows and doors. Cover your head and neck with your arms, a mattress or blankets.',
      'Cars and mobile homes are not safe in a tornado. Go to a sturdy building.',
      'Hurricane: follow evacuation orders. If you stay, shelter in an inner room away from windows.',
      'Thunderstorm: go indoors. Stay away from water, open fields, hilltops and lone trees.',
      'After the storm, stay away from downed power lines and flood water.',
    ],
  },
  winter: {
    now: 'Stay indoors, stay warm and stay off the roads.',
    steps: [
      'Stay inside and off the roads if you can.',
      'Wear layers, a hat and gloves. Change out of wet clothes: they lose heat fast.',
      'Watch for frostbite (numb, white or greyish skin) and hypothermia (shivering, confusion, slurred speech). Get warm and get help.',
      'Never run a generator, grill or camp stove indoors or in a garage. Carbon monoxide kills.',
      'If you are stranded in a car, stay in it. Run the engine 10 minutes an hour and keep the exhaust pipe clear of snow.',
      'If your heat is out, go to a warming centre.',
    ],
  },
  wildfire: {
    now: 'If told to evacuate, leave now.',
    steps: [
      'If you are told to evacuate, leave immediately. Do not wait.',
      'Use official evacuation routes. Shortcuts may be blocked by fire.',
      'If you are trapped, call 911 and give your location. Go to a cleared area or a building away from trees and brush. Close windows and doors.',
      'Wear an N95 mask if you have one to protect against smoke.',
      'In a car, keep windows closed and set the air to recirculate.',
      'Watch for wind changes: fire can turn fast.',
    ],
  },
  heat: {
    now: 'Get to a cool place and drink water.',
    steps: [
      'Go to an air-conditioned place: a cooling centre, library or shopping centre.',
      'Drink water often, before you feel thirsty. Avoid alcohol and sugary drinks.',
      'Stay out of the sun from 10 am to 4 pm. Rest in the shade.',
      'Never leave a person or a pet in a parked car.',
      'Heat stroke signs: very high temperature, confusion, hot red skin, fainting. Call 911 and cool the person with water.',
      'Check on older neighbours and people who live alone.',
    ],
  },
  air_quality: {
    now: 'Stay indoors with windows and doors closed.',
    steps: [
      'Stay inside with windows and doors closed.',
      'Run an air purifier, or an air conditioner with a clean filter set to recirculate.',
      'Avoid exercise and heavy work outdoors.',
      'If you must go out, wear a well-fitting N95 or KN95 mask. Cloth masks do not stop smoke.',
      'Children, older adults, pregnant people and anyone with asthma, heart or lung disease: follow your health plan and call a doctor if symptoms get worse.',
      'If you cannot keep the air clean at home, go to a clean-air centre.',
    ],
  },
  hazmat: {
    now: 'Follow official orders: get inside and seal the room, or evacuate.',
    steps: [
      'Do what officials say: evacuate, or shelter in place.',
      'To shelter in place: get inside, close windows, doors, vents and fireplace dampers, and turn off fans and air conditioning.',
      'Go to an inner room. For most chemicals, a room above ground level is better; some gases sink.',
      'If you are outside, move away, upwind and uphill. Cover your nose and mouth.',
      'If you may be contaminated, take off your outer clothes, put them in a bag, and wash with soap and water.',
      'Radiation: get inside, stay inside, stay tuned. Go to the middle of a brick or concrete building, or a basement.',
    ],
  },
  volcano: {
    now: 'Follow evacuation orders and stay out of low valleys.',
    steps: [
      'Follow evacuation orders and stay out of closed areas.',
      'Avoid river valleys and low areas downstream: mudflows (lahars) move fast.',
      'During ashfall, stay indoors with windows and doors closed. Wear an N95 mask.',
      'If you go out, wear long sleeves and goggles. Avoid driving in heavy ash.',
      'Keep ash out of drinking water.',
    ],
  },
  conflict: {
    now: 'Go to the nearest shelter or underground space now. Stay away from windows.',
    steps: [
      'Go to the nearest shelter, basement or underground space now, such as an underground station or a lower parking level.',
      'Stay away from windows, glass and outside walls.',
      'If there is no shelter, get into the most solid building nearby and go to an inner room or corridor on a low floor.',
      'If you are caught in the open, lie flat on the ground and cover your head.',
      'Stay inside until officials say it is safe. Keep your phone charged and follow official channels only.',
      'Active attacker: run if there is a safe way out, hide if not, fight only as a last resort. Call 911 when it is safe.',
    ],
  },
  crime: {
    now: 'Move away from the area and follow police instructions.',
    steps: [
      'Move away from the area and follow police instructions.',
      'Go to a busy, well-lit public place, or a police or fire station.',
      'If there is an active threat: run, hide, fight. Silence your phone.',
      'Call 911 when it is safe. Report what you saw; do not approach.',
      'Stay away from the area until police say it is clear.',
    ],
  },
  other: {
    now: 'Follow official instructions and move away from the danger.',
    steps: [
      'Follow the official instructions first.',
      'Move away from the danger. Help others only if it is safe.',
      'If told to shelter in place: get inside, close windows and doors, and follow official channels.',
      'If told to evacuate: leave right away using official routes.',
      'Keep your phone charged. Text instead of calling to keep lines free.',
      'Call 911 for life-threatening emergencies.',
    ],
  },
};

export function guidanceFor(hazard: string | null | undefined): Guidance {
  return GUIDANCE[(hazard ?? 'other') as HazardKey] ?? GUIDANCE.other;
}

export const EMERGENCY_NUMBERS = [
  { label: 'Emergency (US)', number: '911' },
  { label: 'Poison control (US)', number: '1-800-222-1222' },
  { label: 'Crisis line (US)', number: '988' },
];
