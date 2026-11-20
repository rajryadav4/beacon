"""Train the Beacon hazard classifier on real IPAWS alerts.

Input: data/ipaws/alerts.jsonl.gz from ml/hazard/fetch_ipaws.py (one row per CAP <info> block).

Labels: hazard = SAME_CODE_HAZARD[eventCode] (apps/api/app/hazard_taxonomy.py). Test and
administrative codes (None) are dropped. NWS products sent with the generic SAME code
"NWS" (or with no code) are labelled from the NWS event name with
hazard_from_event_name(); SAME codes the map does not know are dropped and reported.
Severity = CAP severity (Extreme/Severe/Moderate/Minor; Unknown dropped).

Generic codes (CEM, LAE, SPW, EVI, TOE map to "other") say nothing about the hazard:
the taxonomy leaves those to the classifier. So the hazard head learns the 12 specific
hazards only, and "other" is what it answers below the confidence threshold. Generic-code
messages still train the severity head, and we report what the model makes of them.

Text: headline + description + instruction (English blocks only). The WEA phone text
(CMAMtext / CMAMlongtext, 90 to 360 characters) is added as extra, separate short samples.
To work on short free text, each training message also gives one "snippet": one or two
random sentences of its (masked) description + instruction.

Masking: the explicit event name (e.g. "Flash Flood Warning"), the SAME / NWS codes and
AWIPS ids that embed them (e.g. "FFWLZK") are removed from the text, so the model learns
from what the message says, not from its label. We train and report both masked and
unmasked; the shipped model is trained on masked text.

Dedupe BEFORE the split: exact duplicates after normalising digits and punctuation, then
near-duplicates (word TF-IDF cosine >= 0.9 within the same hazard and text kind, oldest kept).

Split by time:
  validation run: train sent < 2022-01-01, validate on 2022 (abstain threshold, picked on short texts)
  test run:       train sent < 2023-01-01, test on 2023-01-01 and later
  shipped model:  retrained on everything with the same settings.
(The archive stops carrying routine NWS products such as winter, heat and river-flood
statements during 2023, so a later cut would leave those hazards out of the test.)

Model: TF-IDF word 1-2 grams + char_wb 3-5 grams -> LinearSVC (class_weight="balanced")
with sigmoid calibration (CalibratedClassifierCV, 3 folds). A second head with the same
features predicts CAP severity. Baseline: NWS event-name keyword matching on the text.

Writes ml/hazard/output/metrics.json and ml/hazard/output/hazard_model.joblib.

Usage, from the repository root:

    .venv/bin/python ml/hazard/train_hazard_model.py
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import os
import random
import re
import sys
import time
from collections import Counter
from pathlib import Path

os.environ.setdefault("LOKY_MAX_CPU_COUNT", str(max(1, (os.cpu_count() or 2) // 2)))

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.calibration import CalibratedClassifierCV
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score, precision_recall_fscore_support
from sklearn.pipeline import FeatureUnion
from sklearn.svm import LinearSVC

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "api"))
from app.hazard_taxonomy import (  # noqa: E402
    HAZARD_KEYS, HAZARDS, NWS_EVENT_KEYWORDS, SAME_CODE_HAZARD, hazard_from_event_name,
)

DATA = ROOT / "data" / "ipaws" / "alerts.jsonl.gz"
OUT = Path(__file__).resolve().parent / "output"
RANDOM_STATE = 42
MAX_CHARS = 3000          # keep in sync with apps/api/app/hazard_model.py
VALID_FROM = "2022-01-01"
TEST_FROM = "2023-01-01"
NEAR_DUP_COSINE = 0.9
SEVERITIES = ["Extreme", "Severe", "Moderate", "Minor"]
GENERIC = "other"
SPECIFIC = [k for k in HAZARD_KEYS if k != GENERIC]
TARGET_ACCEPTED_ACCURACY = 0.90   # abstain threshold: lowest t with this accuracy on validation short texts
SVC_PARAMS = {"C": 0.5, "class_weight": "balanced", "max_iter": 5000}

# Our own wording, not from the archive. `ok` lists the acceptable answers.
CHECK_SET = [
    ("Air raid sirens, go to the nearest shelter now", ["conflict"]),
    ("Missile attack warning. Take shelter immediately and stay away from windows.", ["conflict"]),
    ("Gunfire reported at the mall, shelter in place and lock doors", ["conflict", "crime"]),
    ("Strong shaking felt downtown. Drop, cover and hold on.", ["earthquake"]),
    ("Large waves expected after the undersea quake. Move to high ground away from the beach.", ["tsunami"]),
    ("River rising rapidly, evacuate low areas", ["flood"]),
    ("Flash flooding on Main Street. Do not drive through water.", ["flood"]),
    ("Dam failure imminent. Downstream residents evacuate now.", ["flood"]),
    ("Tornado on the ground near the highway. Take cover in a basement or inner room.", ["storm"]),
    ("Hurricane force winds and storm surge expected tonight", ["storm", "flood"]),
    ("Heavy snow and ice, roads closed. Stay home and keep warm.", ["winter"]),
    ("Blizzard conditions with zero visibility on the interstate", ["winter"]),
    ("Wildfire spreading toward homes on the ridge, leave now", ["wildfire"]),
    ("Temperatures over 110 degrees today. Drink water and stay out of the sun.", ["heat"]),
    ("Smoke from distant fires has made the air unhealthy. Limit time outdoors.", ["air_quality"]),
    ("Chemical leak at the rail yard. Stay indoors and close all windows.", ["hazmat"]),
    ("Gas plant explosion, evacuate everyone within one mile", ["hazmat"]),
    ("Ash falling from the volcano eruption, wear a mask and stay inside", ["volcano"]),
    ("Police searching for an armed suspect. Avoid the area.", ["crime"]),
    ("Missing child, 6 years old, last seen in a red sedan", ["crime"]),
]


# --------------------------------------------------------------------------- data

def load(path: Path) -> pd.DataFrame:
    if not path.exists():
        sys.exit(f"{path} not found. Run ml/hazard/fetch_ipaws.py first.")
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        df = pd.DataFrame(json.loads(line) for line in fh)
    df = df.astype(object).where(df.notna(), None)
    df["sent"] = pd.to_datetime(df["sent"], utc=True, errors="coerce")
    return df.dropna(subset=["sent"])


def label_row(code: str | None, event: str | None) -> tuple[str | None, str]:
    code = (code or "").strip().upper()
    if code in SAME_CODE_HAZARD:
        return SAME_CODE_HAZARD[code], "same"
    if code in ("", "NWS"):
        return hazard_from_event_name(event), "event_name"
    return None, "unmapped"


def clean(text: str | None) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def mask(text: str, event: str | None, codes: list[str | None]) -> str:
    """Remove the event name and the SAME / NWS codes from the text."""
    if event:
        words = [re.escape(w) for w in event.split()]
        text = re.sub(r"\b" + r"\s+".join(words) + r"s?\b", " ", text, flags=re.IGNORECASE)
    for code in codes:
        if code and len(code) >= 3:
            c = re.escape(code.upper())
            # AWIPS product ids that embed the code, e.g. "FFWLZK" or "MOBFLSMOB"
            text = re.sub(r"\b(?:" + c + r"[A-Z]{3}|[A-Z]{3}" + c + r"[A-Z]{2,3})\b", " ", text)
            text = re.sub(r"\b" + c + r"\b", " ", text, flags=re.IGNORECASE)
    return clean(text)


def redact(text: str) -> str:
    """Hide phone numbers in the example texts written to metrics.json."""
    return re.sub(r"\+?\d[\d\-\s().]{6,}\d", "[number]", text)


def norm_key(text: str) -> str:
    return re.sub(r"[\d\W_]+", " ", text.lower()).strip()


SENTENCE = re.compile(r"(?<=[.!?])\s+|\s*\.\.\.\s*|\s+\*\s+")


def snippet(body: str, rng: random.Random) -> str | None:
    """One or two random sentences (20 to 300 characters) of a message body."""
    parts = [p.strip(" .*-") for p in SENTENCE.split(body)]
    parts = [p for p in parts if 20 <= len(p) <= 300 and sum(ch.isalpha() for ch in p) > 15]
    if not parts:
        return None
    i = rng.randrange(len(parts))
    out = parts[i]
    if rng.random() < 0.5 and i + 1 < len(parts) and len(out) + len(parts[i + 1]) < 300:
        out = f"{out}. {parts[i + 1]}"
    return out + "."


def build_samples(df: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    stats: dict = {"rawInfoBlocks": int(len(df)), "rawAlerts": int(df["identifier"].nunique())}
    lang = df["language"].fillna("en-US").str.lower()
    df = df[lang.str.startswith("en")].copy()
    stats["englishInfoBlocks"] = int(len(df))

    labels = [label_row(c, e) for c, e in zip(df["eventCode"], df["event"])]
    df["hazard"] = [h for h, _ in labels]
    df["labelSource"] = [s for _, s in labels]
    unmapped = df[df["labelSource"] == "unmapped"]
    stats["unmappedCodes"] = {k: int(v) for k, v in unmapped["eventCode"].value_counts().items()}
    stats["unmappedCodeEvents"] = {k: sorted(set(v))[:5] for k, v in unmapped.groupby("eventCode")["event"]}
    stats["droppedNoHazard"] = int(df["hazard"].isna().sum())
    df = df[df["hazard"].notna()].copy()
    stats["labelled"] = int(len(df))
    stats["labelSource"] = {k: int(v) for k, v in df["labelSource"].value_counts().items()}

    rows = []
    for r in df.itertuples(index=False):
        codes = [r.eventCode, r.nwsCode]
        full = clean(" ".join(x for x in (r.headline, r.description, r.instruction) if x))
        body = clean(" ".join(x for x in (r.description, r.instruction) if x))
        sev = r.severity if r.severity in SEVERITIES else None
        if full:
            rows.append((r.id, r.sent, r.hazard, sev, r.eventCode, r.event, "full", full[:MAX_CHARS],
                         mask(full, r.event, codes)[:MAX_CHARS], mask(body, r.event, codes)))
        for k, short in enumerate((r.weaText, r.weaLongText)):
            short = clean(short)
            if short:
                m = mask(short, r.event, codes)
                rows.append((f"{r.id}~wea{k}", r.sent, r.hazard, sev, r.eventCode, r.event, "wea", short, m, m))
    s = pd.DataFrame(rows, columns=["id", "sent", "hazard", "severity", "eventCode", "event", "kind",
                                    "text", "masked", "body"])
    stats["samplesBeforeDedupe"] = {k: int(v) for k, v in s["kind"].value_counts().items()}
    return s.sort_values("sent", kind="stable").reset_index(drop=True), stats


def dedupe(s: pd.DataFrame, stats: dict) -> pd.DataFrame:
    """Exact (normalised) then near-duplicate removal, oldest kept, before any split."""
    s = s.assign(_key=s["masked"].map(norm_key))
    s = s.drop_duplicates(subset=["hazard", "kind", "_key"], keep="first").reset_index(drop=True)
    stats["samplesAfterExactDedupe"] = {k: int(v) for k, v in s["kind"].value_counts().items()}

    keep = np.ones(len(s), dtype=bool)
    vec = TfidfVectorizer(ngram_range=(1, 2), min_df=2, stop_words="english", sublinear_tf=True,
                          dtype=np.float32)
    X = vec.fit_transform(s["_key"])
    for _, idx in s.groupby(["hazard", "kind"]).indices.items():
        idx = np.sort(idx)                       # rows are in time order
        Xg = X[idx]
        kept_mask = np.zeros(len(idx), dtype=bool)
        for start in range(0, len(idx), 2000):
            block = (Xg[start:start + 2000] @ Xg.T).tocsr()
            for i in range(block.shape[0]):
                gi = start + i
                lo, hi = block.indptr[i], block.indptr[i + 1]
                cols, vals = block.indices[lo:hi], block.data[lo:hi]
                hit = (cols < gi) & (vals >= NEAR_DUP_COSINE)
                if hit.any() and kept_mask[cols[hit]].any():
                    continue
                kept_mask[gi] = True
        keep[idx[~kept_mask]] = False
    s = s[keep].drop(columns="_key").reset_index(drop=True)
    stats["samplesAfterNearDedupe"] = {k: int(v) for k, v in s["kind"].value_counts().items()}
    return s


def add_snippets(s: pd.DataFrame, seed: int) -> pd.DataFrame:
    """One snippet row per full-text row (masked body only, since the headline names the event)."""
    rng = random.Random(seed)
    rows = []
    for r in s[s["kind"] == "full"].itertuples(index=False):
        snip = snippet(r.body, rng)
        if snip:
            rows.append({**r._asdict(), "id": f"{r.id}~snip", "kind": "snippet", "text": snip, "masked": snip})
    return pd.DataFrame(rows, columns=s.columns)


# --------------------------------------------------------------------------- model

def make_vectorizer() -> FeatureUnion:
    return FeatureUnion([
        ("word", TfidfVectorizer(ngram_range=(1, 2), min_df=2, max_df=0.5, max_features=200_000,
                                 sublinear_tf=True, strip_accents="unicode", dtype=np.float32)),
        ("char", TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=3, max_features=300_000,
                                 sublinear_tf=True, strip_accents="unicode", dtype=np.float32)),
    ])


def fit_head(X, y) -> CalibratedClassifierCV:
    y = np.asarray(y)
    counts = Counter(y)
    keep = np.array([counts[v] >= 6 for v in y])   # 3-fold calibration needs a few per class
    clf = CalibratedClassifierCV(LinearSVC(**SVC_PARAMS, random_state=RANDOM_STATE), method="sigmoid", cv=3)
    clf.fit(X[keep], y[keep])
    return clf


def fit(train: pd.DataFrame, text_col: str) -> dict:
    """Hazard head on specific hazards, severity head on every row with a severity."""
    vec = make_vectorizer()
    X = vec.fit_transform(train[text_col].tolist())
    spec = (train["hazard"] != GENERIC).to_numpy()
    hz = fit_head(X[spec], train.loc[spec, "hazard"])
    has_sev = train["severity"].notna().to_numpy()
    sv = fit_head(X[has_sev], train.loc[has_sev, "severity"])
    return {"vectorizer": vec, "hazard": hz, "severity": sv}


def predict(model: dict, texts: list[str]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    X = model["vectorizer"].transform(texts)
    proba = model["hazard"].predict_proba(X)
    classes = model["hazard"].classes_
    sev = model["severity"].predict(X)
    return classes[proba.argmax(1)], proba.max(1), sev


def keyword_baseline(text: str) -> str:
    """hazard_from_event_name-style matching on the whole text: first keyword of the list found."""
    low = text.lower()
    for keyword, hazard in NWS_EVENT_KEYWORDS:
        if keyword in low:
            return hazard
    return GENERIC


def report(y_true, y_pred, labels: list[str], extra_pred: list[str] = ()) -> dict:
    y_true, y_pred = list(y_true), list(y_pred)
    cm_labels = labels + [x for x in extra_pred if x not in labels]
    p, r, f, n = precision_recall_fscore_support(y_true, y_pred, labels=labels, zero_division=0)
    present = [i for i in range(len(labels)) if n[i] > 0]
    return {
        "n": len(y_true),
        "accuracy": round(float(accuracy_score(y_true, y_pred)), 4) if y_true else None,
        "macroF1": round(float(np.mean([f[i] for i in present])), 4) if present else None,
        "macroF1Classes": [labels[i] for i in present],
        "weightedF1": round(float(f1_score(y_true, y_pred, labels=labels, average="weighted", zero_division=0)), 4),
        "perClass": {k: {"precision": round(float(p[i]), 4), "recall": round(float(r[i]), 4),
                         "f1": round(float(f[i]), 4), "support": int(n[i])} for i, k in enumerate(labels)},
        "confusion": {"labels": cm_labels, "rows": "true", "columns": "predicted",
                      "matrix": confusion_matrix(y_true, y_pred, labels=cm_labels).tolist()},
    }


def short(rep: dict) -> dict:
    return {"n": rep["n"], "accuracy": rep["accuracy"], "macroF1": rep["macroF1"]}


def pick_threshold(correct: np.ndarray, conf: np.ndarray) -> tuple[float, list[dict]]:
    table = []
    chosen = None
    for t in np.round(np.arange(0.30, 0.96, 0.05), 2):
        acc = conf >= t
        a = float(correct[acc].mean()) if acc.any() else 1.0
        table.append({"threshold": float(t), "coverage": round(float(acc.mean()), 4),
                      "acceptedAccuracy": round(a, 4)})
        if chosen is None and a >= TARGET_ACCEPTED_ACCURACY:
            chosen = float(t)
    return (chosen if chosen is not None else 0.5), table


def coverage_at(correct: np.ndarray, conf: np.ndarray, t: float) -> dict:
    acc = conf >= t
    return {"threshold": t, "coverage": round(float(acc.mean()), 4),
            "acceptedAccuracy": round(float(correct[acc].mean()), 4) if acc.any() else None}


# --------------------------------------------------------------------------- main

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=Path, default=DATA)
    parser.add_argument("--skip-final", action="store_true", help="ship the test-run model, do not retrain on all")
    args = parser.parse_args()
    t0 = time.time()
    OUT.mkdir(parents=True, exist_ok=True)

    raw = load(args.data)
    samples, stats = build_samples(raw)
    stats["sentRange"] = [raw["sent"].min().date().isoformat(), raw["sent"].max().date().isoformat()]
    del raw
    s = dedupe(samples, stats)
    snips = add_snippets(s, RANDOM_STATE)
    stats["snippets"] = int(len(snips))
    print(f"samples: {stats['samplesBeforeDedupe']} -> {stats['samplesAfterNearDedupe']} after dedupe, "
          f"+{len(snips)} snippets ({time.time() - t0:.0f}s)", flush=True)

    def day(df):
        return df["sent"].dt.strftime("%Y-%m-%d")

    sd, nd = day(s), day(snips)
    test_s, test_n = (sd >= TEST_FROM).to_numpy(), (nd >= TEST_FROM).to_numpy()
    val_s = ((sd >= VALID_FROM) & (sd < TEST_FROM)).to_numpy()
    tr_val = pd.concat([s[sd < VALID_FROM], snips[nd < VALID_FROM]])
    tr_test = pd.concat([s[~test_s], snips[~test_n]])
    test = s[test_s]
    test_snip = snips[test_n]
    val = s[val_s & (s["hazard"] != GENERIC).to_numpy()]
    val_n = ((nd >= VALID_FROM) & (nd < TEST_FROM)).to_numpy() & (snips["hazard"] != GENERIC).to_numpy()
    # Free text is short, so the threshold is picked on short validation texts (WEA + snippets).
    val_short = pd.concat([val[val["kind"] == "wea"], snips[val_n]])

    stats["split"] = {
        "validationRun": {"train": f"sent < {VALID_FROM}", "evaluate": f"{VALID_FROM} <= sent < {TEST_FROM}",
                          "trainRows": int(len(tr_val)), "evalRows": int(len(val)),
                          "evalShortRows": int(len(val_short))},
        "testRun": {"train": f"sent < {TEST_FROM}", "evaluate": f"sent >= {TEST_FROM}",
                    "trainRows": int(len(tr_test)), "testRows": int(len(test)), "testSnippets": int(len(test_snip))},
    }
    per_class = {}
    for k in HAZARD_KEYS:
        m = s["hazard"] == k
        if not m.any():
            continue
        per_class[k] = {
            "total": int(m.sum()),
            "full": int((m & (s["kind"] == "full")).sum()),
            "wea": int((m & (s["kind"] == "wea")).sum()),
            "train": int((m & ~test_s).sum()),
            "test": int((m & test_s).sum()),
        }
    stats["perClass"] = per_class
    print(json.dumps(per_class), flush=True)

    # 1) validation run (masked) -> abstain threshold
    m_val = fit(tr_val, "masked")
    pv, cv_, _ = predict(m_val, val["masked"].tolist())
    _, thr_table_full = pick_threshold(pv == val["hazard"].to_numpy(), cv_)
    val_rep = report(val["hazard"], pv, SPECIFIC)
    pvs, cvs, _ = predict(m_val, val_short["masked"].tolist())
    threshold, thr_table = pick_threshold(pvs == val_short["hazard"].to_numpy(), cvs)
    val_short_rep = report(val_short["hazard"], pvs, SPECIFIC)
    print(f"validation macro-F1 {val_rep['macroF1']}, threshold {threshold} ({time.time() - t0:.0f}s)", flush=True)
    del m_val

    # 2) test run: masked model and unmasked model
    spec = test[test["hazard"] != GENERIC]
    generic = test[test["hazard"] == GENERIC]
    snip_spec = test_snip[test_snip["hazard"] != GENERIC]
    y = spec["hazard"].to_numpy()
    kind = spec["kind"].to_numpy()

    m_mask = fit(tr_test, "masked")
    p_mm, c_mm, sev_all = predict(m_mask, spec["masked"].tolist())
    p_mu, c_mu, _ = predict(m_mask, spec["text"].tolist())
    p_ms, c_ms, _ = predict(m_mask, snip_spec["masked"].tolist())
    print(f"masked model done ({time.time() - t0:.0f}s)", flush=True)
    m_unmask = fit(tr_test, "text")
    p_uu, _, _ = predict(m_unmask, spec["text"].tolist())
    p_um, _, _ = predict(m_unmask, spec["masked"].tolist())
    print(f"unmasked model done ({time.time() - t0:.0f}s)", flush=True)
    del m_unmask
    b_m = np.array([keyword_baseline(t) for t in spec["masked"]])
    b_u = np.array([keyword_baseline(t) for t in spec["text"]])
    b_s = np.array([keyword_baseline(t) for t in snip_spec["masked"]])

    ex = [GENERIC]
    results = {
        "maskedModel_maskedText": report(y, p_mm, SPECIFIC),
        "maskedModel_unmaskedText": report(y, p_mu, SPECIFIC),
        "unmaskedModel_unmaskedText": report(y, p_uu, SPECIFIC),
        "unmaskedModel_maskedText": report(y, p_um, SPECIFIC),
        "baseline_maskedText": report(y, b_m, SPECIFIC, ex),
        "baseline_unmaskedText": report(y, b_u, SPECIFIC, ex),
    }
    by_kind = {}
    for k in ("full", "wea"):
        km = kind == k
        if km.any():
            by_kind[k] = {
                "maskedModel_maskedText": short(report(y[km], p_mm[km], SPECIFIC)),
                "maskedModel_unmaskedText": short(report(y[km], p_mu[km], SPECIFIC)),
                "unmaskedModel_unmaskedText": short(report(y[km], p_uu[km], SPECIFIC)),
                "baseline_maskedText": short(report(y[km], b_m[km], SPECIFIC, ex)),
                "baseline_unmaskedText": short(report(y[km], b_u[km], SPECIFIC, ex)),
            }
    ys = snip_spec["hazard"].to_numpy()
    by_kind["snippet"] = {"maskedModel_maskedText": short(report(ys, p_ms, SPECIFIC)),
                          "baseline_maskedText": short(report(ys, b_s, SPECIFIC, ex))}

    # abstention on the test run (masked model, masked text): below threshold -> "other" (wrong here)
    abstain = coverage_at(p_mm == y, c_mm, threshold)
    abstain["withAbstainAsOther"] = short(report(y, np.where(c_mm >= threshold, p_mm, GENERIC), SPECIFIC, ex))
    abstain["snippets"] = coverage_at(p_ms == ys, c_ms, threshold)
    pg, cg, _ = predict(m_mask, generic["masked"].tolist())
    after = np.where(cg >= threshold, pg, GENERIC)
    generic_report = {
        "note": "test messages with generic codes (CEM, LAE, SPW, EVI, TOE); no hazard ground truth",
        "n": int(len(generic)),
        "byCode": {k: int(v) for k, v in generic["eventCode"].value_counts().items()},
        "predictedAfterThreshold": {k: int(v) for k, v in Counter(after).most_common()},
        "examples": [{"code": c, "text": redact(t[:160]),"predicted": str(a), "confidence": round(float(cf), 3)}
                     for c, t, a, cf in list(zip(generic["eventCode"], generic["masked"], after, cg))[:: max(1, len(generic) // 12)][:12]],
    }

    # severity head (all test rows with a severity, generic codes included)
    _, _, sev_pred = predict(m_mask, test["masked"].tolist())
    has = test["severity"].notna().to_numpy()
    sev_true = test["severity"].to_numpy()[has]
    tr_sev = tr_test[tr_test["severity"].notna()]
    by_hz = tr_sev.groupby("hazard")["severity"].agg(lambda x: x.value_counts().index[0]).to_dict()
    sev_base = np.array([by_hz.get(h, tr_sev["severity"].mode()[0]) for h in test["hazard"].to_numpy()[has]])
    severity = {
        "model": report(sev_true, sev_pred[has], SEVERITIES),
        "baseline_majorityPerTrueHazard": report(sev_true, sev_base, SEVERITIES),
        "trainDistribution": {k: int(v) for k, v in tr_sev["severity"].value_counts().items()},
    }

    def run_check(model: dict) -> dict:
        texts = [t for t, _ in CHECK_SET]
        p, c, sv = predict(model, texts)
        rows = []
        for (text, ok), pi, ci, si in zip(CHECK_SET, p, c, sv):
            final = str(pi) if ci >= threshold else GENERIC
            base = keyword_baseline(text)
            rows.append({"text": text, "expected": ok, "predicted": str(pi), "confidence": round(float(ci), 3),
                         "afterThreshold": final, "severity": str(si), "correct": bool(pi in ok),
                         "correctAfterThreshold": final in ok, "baseline": base, "baselineCorrect": base in ok})
        return {"n": len(rows), "correct": sum(r["correct"] for r in rows),
                "correctAfterThreshold": sum(r["correctAfterThreshold"] for r in rows),
                "baselineCorrect": sum(r["baselineCorrect"] for r in rows), "rows": rows}

    check_test_model = run_check(m_mask)

    # 3) shipped model: masked text, all data
    trained_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    version = "hazard-" + trained_at.strftime("%Y%m%d")
    if args.skip_final:
        final, shipped_on = m_mask, "testRun"
    else:
        del m_mask
        final, shipped_on = fit(pd.concat([s, snips]), "masked"), "all"
    check_final = run_check(final)
    print(f"final model done ({time.time() - t0:.0f}s)", flush=True)

    headline = results["maskedModel_maskedText"]
    summary = {
        "version": version,
        "trainedAt": trained_at.isoformat().replace("+00:00", "Z"),
        "trainedOn": shipped_on,
        "sklearn": sklearn.__version__,
        "threshold": threshold,
        "classes": [str(c) for c in final["hazard"].classes_],
        "test": {
            "period": f"sent >= {TEST_FROM}",
            "rows": int(len(spec)),
            "macroF1Masked": headline["macroF1"],
            "macroF1Unmasked": results["maskedModel_unmaskedText"]["macroF1"],
            "macroF1UnmaskedModel": results["unmaskedModel_unmaskedText"]["macroF1"],
            "baselineMacroF1Masked": results["baseline_maskedText"]["macroF1"],
            "baselineMacroF1Unmasked": results["baseline_unmaskedText"]["macroF1"],
            "accuracyMasked": headline["accuracy"],
            "macroF1Snippets": by_kind["snippet"]["maskedModel_maskedText"]["macroF1"],
            "severityMacroF1": severity["model"]["macroF1"],
        },
        "checkSet": {"n": check_final["n"], "correct": check_final["correct"],
                     "correctAfterThreshold": check_final["correctAfterThreshold"]},
    }
    metrics = {
        "generatedAt": summary["trainedAt"],
        "summary": summary,
        "data": stats,
        "params": {"svc": SVC_PARAMS, "calibration": "sigmoid, 3-fold", "maxChars": MAX_CHARS,
                   "nearDupCosine": NEAR_DUP_COSINE, "targetAcceptedAccuracy": TARGET_ACCEPTED_ACCURACY,
                   "word": "1-2 grams, min_df 2, max_df 0.5, 200k", "char": "char_wb 3-5, min_df 3, 300k",
                   "hazardHeadClasses": "12 specific hazards; 'other' only by abstention"},
        "validation": {"macroF1": val_rep["macroF1"], "accuracy": val_rep["accuracy"], "n": val_rep["n"],
                       "short": short(val_short_rep), "threshold": threshold,
                       "thresholdTableShortTexts": thr_table, "thresholdTableAllTexts": thr_table_full},
        "test": results,
        "testByTextKind": by_kind,
        "abstention": abstain,
        "genericCodes": generic_report,
        "severity": severity,
        "checkSet": {"testRunModel": check_test_model, "shippedModel": check_final},
    }
    (OUT / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")
    joblib.dump({
        "version": version, "trainedAt": summary["trainedAt"], "threshold": threshold, "maxChars": MAX_CHARS,
        "labels": {k: HAZARDS[k]["label"] for k in HAZARD_KEYS}, "summary": summary,
        "vectorizer": final["vectorizer"], "hazard": final["hazard"], "severity": final["severity"],
    }, OUT / "hazard_model.joblib", compress=3)
    print(json.dumps(summary, indent=2))
    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
