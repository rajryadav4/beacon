# Beacon hazard classifier: model card

## Purpose

Beacon picks up emergency messages and tells users what kind of calamity is happening and how severe it is.
When a message carries an official code (an EAS/SAME event code or an NWS event name),
Beacon uses that code directly (`apps/api/app/hazard_taxonomy.py`).
This model is only for free text with no usable code: alerts from other senders, local feeds,
dispatch notes and messages that users paste in.

It answers one of the 12 specific hazard keys of the taxonomy, or `other` when it is not sure,
plus a CAP severity (Extreme, Severe, Moderate or Minor).

It is a decision aid. It must never override an official code.

## Data

- Source: FEMA OpenFEMA `IpawsArchivedAlerts`, the archive of real CAP messages sent through IPAWS
  (about 4.9 million messages, June 2012 to November 2026). Downloaded by `ml/hazard/fetch_ipaws.py`.
- Sample, not the whole archive: up to 2,000 messages per EAS/SAME event code, spread over every year
  (two random offsets per year), so rare hazards are not drowned out. Rare codes are fetched whole
  (tsunami, earthquake, volcano, hazmat, radiological, civil danger).
  NWS products sent with the generic SAME code `NWS` (air quality, ashfall, tsunami advisories, ...)
  are fetched by event name.
- 57,952 alerts, 60,862 CAP info blocks. 57,952 English blocks are used. Spanish blocks are left out.
- Text per message: headline + description + instruction (cut at 3,000 characters).
  The WEA phone text (`CMAMtext`, `CMAMlongtext`, 90 to 360 characters) is an extra, separate short sample.
- The archive stores messages from 2023 on in a slightly different format (`parameter` instead of
  `parameters`). The download that this model used read the WEA phone text of those messages for only
  16 of 86 query plans. So there are almost no WEA texts from 2023 on (16 in the test set).
  The fixed `fetch_ipaws.py` reads both formats.

## Labels

- Hazard = `SAME_CODE_HAZARD[eventCode]`. Test and administrative codes (RWT, RMT, DMO, ADR, NPT) are dropped.
- Messages with the generic SAME code `NWS` (or no code) get their label from the NWS event name
  (`hazard_from_event_name`): 12,842 messages. All others: 44,486 messages labelled from the SAME code.
- SAME codes in the archive that `SAME_CODE_HAZARD` does not map:
  - `NWS` (12,842 in our sample): the generic code of NWS products that are not EAS events. Its real product
    is in the separate `NationalWeatherService` code (FWW, WCW, EHW, FZW, WCY, HTY, ASY, SMY, ESF, FZA, MWS,
    WCA, HFW, TSY, SAB, HFA, MSY, AFY, MHY). Labelled from the event name, as above.
  - Dropped (611 messages): `OTH` (377: NWS heat, freeze, smoke and red flag products),
    `SPS` (195, Special Weather Statement, mixed hazards), `MEP` (39, Missing and Endangered Persons).
    `MEP` could map to `crime` like `CAE`.
- The generic codes CEM, LAE, SPW, EVI and TOE map to `other`. They say nothing about the hazard:
  a "Local Area Emergency" can be a chemical leak, a flood or a road closure.
  So the hazard head learns the 12 specific hazards only. `other` is the answer below the confidence threshold.
  The generic messages still train the severity head, and we report what the model makes of them (below).
- Severity = CAP `severity`. `Unknown` is dropped for the severity head.

## Masking

Free text has no event code. So the training text hides the explicit label:

- the event name (e.g. "Flash Flood Warning", in any letter case),
- the SAME code and the NWS product code,
- AWIPS ids that embed the code (e.g. `FFWLZK`, `MOBFLSMOB`).

The words that describe the hazard stay ("heavy rain", "move to higher ground").
We train and test both masked and unmasked. The shipped model is trained on masked text.

## Dedupe and short-text snippets

The archive has many updates of the same alert. Before any split:

1. Exact duplicates after removing digits and punctuation (same hazard and text kind): 55,974 to 48,613 full texts.
2. Near duplicates: word TF-IDF cosine 0.9 or more with an older kept message of the same hazard and text kind.
   48,613 to 40,659 full texts. WEA texts: 11,651 to 4,245 (they are templates).

Free text is often one or two sentences. So each full message also gives one "snippet":
one or two random sentences (20 to 300 characters) of its masked description and instruction.
39,263 snippets. A snippet is in the same time period as its message.

After dedupe, per hazard (full texts + WEA texts):

| Hazard | Total | Train (before 2023) | Test (2023 on) |
|---|---|---|---|
| storm | 16,701 | 15,115 | 1,586 |
| flood | 9,729 | 9,026 | 703 |
| winter | 5,245 | 4,828 | 417 |
| wildfire | 2,769 | 2,428 | 341 |
| crime | 2,191 | 1,827 | 364 |
| heat | 1,939 | 1,735 | 204 |
| air_quality | 909 | 868 | 41 |
| conflict | 354 | 282 | 72 |
| hazmat | 187 | 109 | 78 |
| tsunami | 63 | 62 | 1 |
| earthquake | 32 | 29 | 3 |
| volcano | 18 | 18 | 0 |
| other (generic codes) | 4,767 | 3,642 | 1,125 |

## Splits

By time, so no message from the test period is seen in training:

| Run | Train | Evaluate | Use |
|---|---|---|---|
| Validation | sent before 2022-01-01 | 2022 | Picks the abstain threshold |
| Test | sent before 2023-01-01 | 2023-01-01 to 2026-11-18 | All results below |
| Shipped | everything | none | The model in `hazard_model.joblib` |

Why 2023: during 2023 the archive stops carrying routine NWS products (winter, heat, river-flood statements).
A later cut would leave winter, heat and air quality out of the test. We fixed this cut, the settings and the
threshold rule before looking at the test results.

## Model

- Features: TF-IDF word 1-2 grams (200k, min_df 2, max_df 0.5) + TF-IDF char_wb 3-5 grams (300k, min_df 3),
  sublinear tf, lower case, accents stripped.
- Hazard head: `LinearSVC` (C 0.5, `class_weight="balanced"`) with sigmoid calibration
  (`CalibratedClassifierCV`, 3 folds). 12 classes.
- Severity head: the same, on the same features, 4 classes.
- Abstain threshold: the lowest of 0.30, 0.35, ..., 0.95 at which the kept answers on the validation
  short texts (WEA + snippets) are at least 90% right. Result: **0.50**
  (on validation short texts: 93.5% kept, 90.6% of them right).
- scikit-learn 1.9.1. Load the joblib with the same scikit-learn version.

## Results on the test period (2023 on)

3,810 test messages with a specific hazard (full texts and WEA texts).
Macro-F1 is the mean F1 over the 11 hazards that occur in the test period (no volcano message since 2023).

| Method | Text | Macro-F1 | Accuracy |
|---|---|---|---|
| **Shipped setup: masked-trained model** | masked | **0.689** | **0.939** |
| Masked-trained model | unmasked | 0.704 | 0.943 |
| Unmasked-trained model | unmasked | 0.716 | 0.950 |
| Unmasked-trained model | masked | 0.691 | 0.936 |
| Baseline: event-name keywords on the text | masked | 0.438 | 0.681 |
| Baseline: event-name keywords on the text | unmasked | 0.465 | 0.718 |
| Masked-trained model | snippets (3,618) | 0.610 | 0.870 |
| Baseline | snippets | 0.358 | 0.387 |

Per hazard (masked model, masked text):

| Hazard | Precision | Recall | F1 | Test messages | Baseline F1 |
|---|---|---|---|---|---|
| heat | 0.995 | 1.000 | 0.998 | 204 | 0.877 |
| winter | 0.969 | 0.986 | 0.977 | 417 | 0.413 |
| flood | 0.957 | 0.989 | 0.973 | 703 | 0.912 |
| storm | 0.957 | 0.986 | 0.971 | 1,586 | 0.820 |
| wildfire | 0.877 | 0.944 | 0.910 | 341 | 0.452 |
| crime | 0.887 | 0.882 | 0.884 | 364 | 0.151 |
| air_quality | 0.806 | 0.610 | 0.694 | 41 | 0.646 |
| hazmat | 0.879 | 0.372 | 0.522 | 78 | 0.050 |
| tsunami | 0.333 | 1.000 | 0.500 | 1 | 0.500 |
| conflict | 0.280 | 0.097 | 0.144 | 72 | 0.000 |
| earthquake | 0.000 | 0.000 | 0.000 | 3 | 0.000 |

- The weather hazards are easy: F1 0.91 to 1.00.
- Hazmat is often called wildfire (21 of 78: fires at plants and "evacuate" messages).
- Conflict (civil danger) is mostly called crime (32 of 72). The CDW messages in the archive are about
  armed suspects and police standoffs, so they look like law-enforcement warnings.
- Earthquake (3), tsunami (1) and volcano (0) have too few test messages to measure.
- Masking costs little (0.716 to 0.689). The model learns from the description, not only from the event name.

Abstention at 0.50 (masked test text): the model answers 97.6% of the messages, and 95.5% of those answers
are right. On snippets: 94.0% answered, 90.0% right.

Severity head (all 4,855 test messages with a severity, generic codes included): macro-F1 **0.827**,
accuracy 0.844. Baseline (most common severity of the true hazard in training): macro-F1 0.353, accuracy 0.643.

## Generic-code messages

1,125 test messages have a generic code (EVI 299, LAE 273, SPW 229, CEM 211, TOE 113).
There is no hazard ground truth for them. After the threshold the model says:
wildfire 406, other 251, crime 209, storm 123, flood 56, conflict 49, hazmat 26, others 5.
Examples from `metrics.json`: an ammonia-leak shelter order gives hazmat, wildfire evacuation orders give wildfire,
a creek-level shelter order gives flood, a boil-water notice gives other.
Errors: "911 outage" messages (TOE) are often called conflict or crime, and evacuation orders without a cause
are called wildfire. Beacon should show these as "Other emergency" unless the confidence is high.

## Hand-written check set

20 short messages in our own words (`CHECK_SET` in `train_hazard_model.py`). Shipped model:

- **14 of 20** right as top answer, **12 of 20** right after the threshold. Baseline: 7 of 20.
- Right: flash flooding, tornado, hurricane, heavy snow, blizzard, wildfire, extreme heat, smoke,
  chemical leak, gas plant explosion, armed suspect, missing child; gunfire at a mall (crime) and
  strong shaking (earthquake) are right but below the threshold, so they become `other`.
- Wrong: "Air raid sirens, go to the nearest shelter now" (hazmat 0.48, so `other`),
  "Missile attack warning ..." (storm 0.53), "Large waves expected after the undersea quake ..." (flood 0.56),
  "River rising rapidly, evacuate low areas" (wildfire 0.59, flood 0.38),
  "Dam failure imminent ..." (conflict 0.50), "Ash falling from the volcano eruption ..." (conflict 0.53).
- War and air-raid text is not in the data. "Take shelter, stay away from windows" is tornado language in US alerts.

## Limits

- **English US alerts only.** Trained on US IPAWS messages: NWS weather products, state and county alerts.
  Other countries word alerts differently. Spanish blocks were left out.
- **No war or air-raid text.** It was not trained on war, air-raid or missile alerts from other countries.
  It calls them storm or hazmat. Do not use it for those until it has such data.
- **Never override an official code.** A SAME code or NWS event name is always more reliable.
- **Abstain below the threshold.** Below confidence 0.50 the answer is `other`. Show `other` as "Other emergency",
  not as "no danger".
- **Not a detector of emergencies.** It assumes the text is an emergency message. Ordinary text
  ("lunch at noon") still gets a hazard, sometimes above the threshold.
- **Rare hazards.** Earthquake (32 messages), tsunami (63) and volcano (18) have very little training data,
  and conflict is mostly active-shooter and police text. Expect errors on short messages about them.
- **Weather-heavy.** Over 80% of the messages are NWS weather text, which uses its own style
  (upper case before 2017, "* WHAT...", "* WHERE..."). Short plain-language messages are harder (snippet macro-F1 0.61).
- **Old messages dominate.** 89% of the messages (after dedupe) are from before 2023.
- **Few recent WEA texts** (see Data). A fresh download fixes this.
- Calibration is per class, so confidences of different classes are not exactly comparable.

## Files

- `ml/hazard/fetch_ipaws.py`: downloads the sample to `data/ipaws/` (git-ignored).
- `ml/hazard/train_hazard_model.py`: labels, masks, dedupes, splits, trains, tests and writes the outputs.
- `ml/hazard/output/metrics.json`: every number in this card, confusion matrices, threshold tables, check set.
- `ml/hazard/output/hazard_model.joblib`: the shipped model (git-ignored, about 65 MB).
- `apps/api/app/hazard_model.py`: `classify(text)`, used by `POST /api/hazard/classify`.

Rebuild: `python ml/hazard/fetch_ipaws.py`, then `python ml/hazard/train_hazard_model.py`.

## Rules on top of the model (serving, `apps/api/app/hazard_model.py`)

US alerts contain very few earthquake (32), tsunami (63), volcano (18) and conflict (354) messages, so the
model alone confuses them with storms ("Strong shaking felt downtown" -> storm; "Air raid sirens" -> storm).
At serving time two transparent rules run on top of the model; the result's `method` says which decided:

| `method` | When | Answer |
|---|---|---|
| `rules` | A clear rare-hazard term: tsunami / tidal wave; volcano, eruption, ash fall, lahar; air raid, missile, airstrike, shelling, bombing, active shooter, armed or terrorist attack, invasion; earthquake, quake, aftershock, seismic, tremor, shaking. Checked in that order (a tsunami warning often names its earthquake). | That hazard, `confidence` 0.8 (a fixed rule confidence, not a probability), `matched` = the term |
| `abstain` | No emergency vocabulary at all (e.g. "Lunch at noon") and model confidence below 0.8 | `other` |
| `model` | Otherwise | The model's answer, `other` below the 0.50 threshold |

"Sirens" alone is not treated as an attack (tornado warnings mention sirens). The metrics above are for the
model alone; the rules are checked by tests in `apps/api/tests/test_hazard.py`. An official alert code still
always wins over both.
