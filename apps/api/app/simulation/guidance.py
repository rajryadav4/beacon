"""Plain-words guidance for simulated scenarios, in the style of widely published official
advice (Ready.gov, FEMA, NOAA/NWS, USGS, CDC, US EPA AirNow, civil-defence agencies).

`plan(hazard, status)` -> (action, headline, now, steps). The destination sentence is
added by the router once the safe place is known.
"""

from __future__ import annotations

ACTION_LABEL = {
    "evacuate": "Leave the area now",
    "go_to_high_ground": "Go to high ground",
    "move_to_open_ground": "Move to open ground",
    "go_underground": "Get underground",
    "shelter_in_place": "Shelter in place",
    "go_indoors": "Get inside a sturdy building",
    "stay_away": "Stay away from the area",
}

STATUS_HEADLINE = {
    "inside_severe": "You are inside the severe danger zone",
    "inside_moderate": "You are inside the danger zone",
    "outside": "You are outside the danger zone",
}

# hazard -> status -> (action, now, steps)
PLANS: dict[str, dict[str, tuple[str, str, list[str]]]] = {
    "earthquake": {
        "inside_severe": ("move_to_open_ground", "Drop, cover and hold on until the shaking stops.", [
            "Drop to your hands and knees, cover your head and neck under a sturdy table, and hold on.",
            "Stay put until the shaking stops. Do not run outside while the ground is shaking.",
            "When it stops, check yourself and others for injuries. Expect aftershocks.",
            "If the building is damaged or you smell gas, leave by the stairs, never the elevator.",
            "Walk to open ground away from buildings, power lines and glass: the route below avoids the worst-hit area.",
            "Stay off the phone except for emergencies; send texts to tell family you are safe.",
        ]),
        "inside_moderate": ("move_to_open_ground", "Drop, cover and hold on until the shaking stops.", [
            "Drop, cover and hold on until the shaking stops.",
            "Check for injuries, gas leaks and damage. Expect aftershocks.",
            "If your building is damaged, leave and go to open ground or the emergency hub below.",
            "Do not drive unless you must: roads and bridges may be damaged and are needed by responders.",
        ]),
        "outside": ("stay_away", "You felt it, but you are outside the damage area.", [
            "Expect aftershocks. Drop, cover and hold on if shaking starts again.",
            "Stay away from the damaged area so responders can work.",
            "Check on neighbours, especially older people and people living alone.",
        ]),
    },
    "tsunami": {
        "inside_severe": ("go_to_high_ground", "Go to high ground or inland now, on foot.", [
            "Leave now. Do not wait for an official order or to see the wave.",
            "Go on foot if you can: roads jam quickly. Follow tsunami evacuation signs uphill or inland.",
            "Get at least 15 m (50 ft) above sea level, or as far inland as you can.",
            "If you cannot get out in time, go to the third floor or higher of a sturdy concrete building.",
            "Stay away from the shore: more waves come for hours, and the first is often not the largest.",
            "Go back only when officials say it is safe.",
        ]),
        "inside_moderate": ("go_to_high_ground", "Move to higher ground now.", [
            "Water may reach here. Leave now and head uphill or inland.",
            "Go on foot if you can. Do not go to the shore to watch.",
            "Stay on high ground until officials say it is safe.",
        ]),
        "outside": ("stay_away", "You are on safe ground: stay here and away from the shore.", [
            "Stay where you are. Do not go toward the water to watch.",
            "Keep roads clear for people leaving the low-lying area.",
            "Listen to local officials and emergency alerts for the all-clear.",
        ]),
    },
    "flood": {
        "inside_severe": ("go_to_high_ground", "Move to higher ground now. Never walk or drive through flood water.", [
            "Leave now for higher ground. Take only essentials.",
            "Never walk, swim or drive through flood water: 15 cm (6 in) of moving water can knock you down, 30 cm (1 ft) can float a car.",
            "Turn around, don't drown: if the route ahead is flooded, find another way.",
            "If you are trapped in a building, go to the highest floor (not a closed attic) and signal for help.",
            "Stay away from downed power lines and electrical equipment in water.",
        ]),
        "inside_moderate": ("go_to_high_ground", "Get ready to leave, and move to higher ground.", [
            "Water may reach here. Move to higher ground before roads flood.",
            "Never walk or drive through flood water.",
            "Move valuables and medicines upstairs if you have time.",
        ]),
        "outside": ("stay_away", "You are above the flood: stay out of the flooded area.", [
            "Stay away from flooded roads and river banks.",
            "Do not drive through water over the road.",
            "Follow local alerts: rivers can keep rising after the rain stops.",
        ]),
    },
    "wildfire": {
        "inside_severe": ("evacuate", "Leave now, away from the fire and across the wind.", [
            "Leave immediately. Do not wait for the flames to be visible.",
            "Move away from the fire and across the wind, not straight downwind where the fire is heading.",
            "Use the route shown: shortcuts may be blocked by fire or responders.",
            "Wear an N95 mask if you have one; cover nose and mouth with a damp cloth if not.",
            "In a car, keep windows shut, lights on and air on recirculate.",
            "If you are trapped, call 911, go to a cleared area or a building away from trees, and close doors and windows.",
        ]),
        "inside_moderate": ("evacuate", "Embers and smoke are coming: leave early, across the wind.", [
            "Leave now while roads are clear. Embers start new fires far ahead of the front.",
            "Head across the wind or upwind, away from where the fire is moving.",
            "Close windows and doors behind you; move flammable items away from the house if you have a minute.",
            "Wear an N95 mask against smoke.",
        ]),
        "outside": ("stay_away", "Stay out of the fire area and be ready to leave.", [
            "Stay away from the fire area and keep roads clear for evacuees and fire crews.",
            "Watch for wind changes: fire can turn fast.",
            "Keep windows closed and limit time outdoors if smoke reaches you.",
        ]),
    },
    "hazmat": {
        "inside_severe": ("evacuate", "Leave now, across the wind, away from the plume.", [
            "Move away from the release now, across the wind (sideways to it), then upwind.",
            "Cover your nose and mouth with a cloth. Do not walk into or touch any spilled material.",
            "Do not go toward the source to look.",
            "If you were exposed, remove outer clothing and wash skin with soap and water as soon as you can.",
            "Follow responders' directions: they may set a different evacuation route.",
        ]),
        "inside_moderate": ("shelter_in_place", "Go inside now and shelter in place.", [
            "Go indoors now and stay there.",
            "Close and lock all windows and doors. Turn off fans, heating and air conditioning.",
            "Go to an inner room, above ground level if you can (many gases are heavier than air).",
            "Seal gaps around doors and vents with wet towels or tape and plastic.",
            "Stay inside until officials give the all-clear; leave only if told to evacuate (route below).",
        ]),
        "outside": ("stay_away", "Stay away from the area and keep windows closed.", [
            "Stay out of the area and do not drive through it.",
            "Close windows if you are close and downwind.",
            "Follow local alerts: the wind can shift the plume.",
        ]),
    },
    "conflict": {
        "inside_severe": ("go_underground", "Get underground now: the nearest shelter is safer than running.", [
            "Go to the nearest bomb shelter, bunker or underground station right now.",
            "If you cannot reach one in a couple of minutes, go to a basement or an inner stairwell of a solid building, away from windows.",
            "If you are caught in the open, lie flat in a ditch or low ground and cover your head.",
            "Stay underground until the official all-clear, even if it goes quiet.",
            "Do not film or post the location of shelters or damage.",
        ]),
        "inside_moderate": ("go_underground", "Go underground now, not out of the city.", [
            "Go to the nearest underground shelter or station now. Going underground beats fleeing on open roads.",
            "Take water, medicines, a phone and a charger if they are at hand. Do not go back for them.",
            "Stay away from windows. Stay underground until the official all-clear.",
        ]),
        "outside": ("go_underground", "Know where your nearest shelter is and go if sirens sound.", [
            "Go to the nearest underground shelter when the sirens sound.",
            "Keep your phone charged and alerts on.",
            "Avoid the target area and stay off roads responders need.",
        ]),
    },
    "storm": {
        "inside_severe": ("go_indoors", "Get inside a sturdy building now, to an inner room on the lowest floor.", [
            "Go to a basement or a small inner room on the lowest floor with no windows.",
            "Stay away from windows and doors. Cover your head and neck.",
            "Cars and mobile homes are not safe: get into a sturdy building.",
            "After the storm, stay away from downed power lines and fallen trees.",
        ]),
        "inside_moderate": ("go_indoors", "Go indoors and stay away from windows.", [
            "Get inside a sturdy building before the storm arrives.",
            "Stay away from windows, trees and power lines.",
            "Charge your phone and keep a torch at hand in case the power goes.",
        ]),
        "outside": ("stay_away", "The storm is nearby: stay informed.", [
            "Watch the sky and alerts: storms can change track.",
            "Avoid travel into the storm area.",
        ]),
    },
    "heat": {
        "inside_severe": ("go_indoors", "Get to a cooling centre or an air-conditioned building.", [
            "Go to a cooling centre, library or other air-conditioned public building.",
            "Drink water regularly, even if you are not thirsty. Avoid alcohol.",
            "Stay out of the sun between 11 am and 5 pm. Never leave anyone in a parked car.",
            "Heat stroke (hot skin, confusion, fainting) is an emergency: call 911 and cool the person down.",
            "Check on older neighbours and people living alone.",
        ]),
        "inside_moderate": ("go_indoors", "Stay cool: spend the hottest hours indoors.", [
            "Spend the hottest hours somewhere cool: a cooling centre or an air-conditioned building.",
            "Drink water often and rest in the shade.",
            "Check on people at risk.",
        ]),
        "outside": ("stay_away", "It is hot, but less extreme here.", ["Drink water and limit hard work outdoors."]),
    },
    "winter": {
        "inside_severe": ("go_indoors", "Get warm and stay off the roads.", [
            "Go to a warming centre if your home has no heat.",
            "Wear layers, a hat and gloves. Change out of wet clothes.",
            "Never use a generator, grill or camp stove indoors: carbon monoxide kills.",
            "If you are stranded in a car, stay in it and keep the exhaust pipe clear of snow.",
        ]),
        "inside_moderate": ("go_indoors", "Stay indoors and stay warm.", [
            "Stay inside and off icy roads.",
            "Keep warm and check on neighbours.",
        ]),
        "outside": ("stay_away", "Conditions are better here: avoid travel into the storm.", ["Avoid travel into the storm area."]),
    },
    "air_quality": {
        "inside_severe": ("go_indoors", "Go indoors with filtered air now.", [
            "Go to a clean-air centre or a building with filtered air.",
            "Keep windows and doors shut. Run an air purifier or an HVAC system with a good filter on recirculate.",
            "Wear a well-fitting N95 mask outdoors; cloth masks do not stop smoke.",
            "Avoid exercise outdoors. People with asthma or heart disease should follow their action plan.",
        ]),
        "inside_moderate": ("go_indoors", "Limit time outdoors and keep windows closed.", [
            "Spend as much time as you can indoors with windows closed.",
            "Wear an N95 mask outdoors.",
            "Check on children, older people and anyone with lung or heart conditions.",
        ]),
        "outside": ("stay_away", "The smoke is elsewhere for now.", ["Watch the air quality: wind can bring smoke here."]),
    },
    "volcano": {
        "inside_severe": ("evacuate", "Leave the area now, away from river valleys.", [
            "Leave now. Follow official evacuation routes.",
            "Stay out of river valleys and low areas: lahars (volcanic mudflows) flow down them fast.",
            "Cover nose and mouth with an N95 mask; wear goggles if there is ash.",
        ]),
        "inside_moderate": ("shelter_in_place", "Ash is falling: go indoors and keep it out.", [
            "Go indoors and close windows, doors and vents.",
            "Wear an N95 mask and goggles if you must go outside.",
            "Avoid driving in heavy ash; it damages engines and cuts visibility.",
        ]),
        "outside": ("stay_away", "You are outside the ash and lahar area.", ["Stay informed: wind can carry ash further."]),
    },
    "crime": {
        "inside_severe": ("evacuate", "Move away from the scene to a safe place.", [
            "Leave the area calmly and quickly, away from the activity.",
            "If you cannot leave, get inside, lock the door, silence your phone and stay out of sight.",
            "Call 911 when it is safe to do so.",
            "Follow police instructions and keep your hands visible.",
        ]),
        "inside_moderate": ("stay_away", "Avoid the area.", ["Take another route and keep away from the scene.",
                                                             "Follow police instructions."]),
        "outside": ("stay_away", "Avoid the area.", ["Keep away from the scene and follow police updates."]),
    },
    "other": {
        "inside_severe": ("evacuate", "Leave the area now and follow responders' directions.", [
            "Leave the area now by the route shown.",
            "Follow directions from police, fire and emergency staff.",
            "Help others if you can do so safely.",
        ]),
        "inside_moderate": ("stay_away", "Be ready to leave, and follow local instructions.", [
            "Stay alert and be ready to leave.",
            "Follow directions from local officials.",
        ]),
        "outside": ("stay_away", "Avoid the area.", ["Keep away so responders can work."]),
    },
}


def plan(hazard: str, status: str) -> tuple[str, str, str, list[str]]:
    action, now, steps = PLANS[hazard][status]
    return action, STATUS_HEADLINE[status], now, list(steps)
