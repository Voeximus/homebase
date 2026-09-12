"""
Does a US Nutrition Facts panel carry enough redundancy to CHECK and CORRECT
its own OCR errors deterministically?

Ground truth: 200 real branded products from USDA FoodData Central. FDC stores
per-100 g values that USDA computed FROM the label, so multiplying back by the
serving size recovers the declared (printed) value.

Pipeline:
  1. Recover each product's printed panel; verify it sits on the legal rounding
     lattice from 21 CFR 101.9(c) (a check that the recovery is faithful).
  2. Measure the REAL spread of the energy identity  kcal vs 4P + 4C + 9F.
     Calibrate the band on half the products, test on the other half.
  3. Render each panel as the tokens a reader would see, including the %DV
     column, and push it through a simulated OCR channel (digit confusions,
     dropped decimal, the "8g" -> "89" unit misread).
  4. For each constraint set (ablation), measure:
       detected   - at least one constraint fails on the corrupted read
       SILENT     - corrupted read passes every constraint  <- the one that matters
       corrected  - exactly one single-token repair satisfies everything, and it is the truth
       ambiguous  - more than one repair fits (abstain: ask the user for that field)

What this does NOT test, stated up front: real OCR on real photos. The channel
is an assumed error model. This measures whether the REGULATION provides
enough redundancy — not how often a camera misreads.
"""
import json, math, random, itertools, statistics as st
from pathlib import Path

HERE = Path(__file__).parent
random.seed(20260912)

# ── 21 CFR 101.9 — DRVs, verified against the eCFR text (adults & children >= 4) ──
DV = {"fat": 78, "sat": 20, "chol": 300, "sodium": 2300, "carb": 275, "fiber": 28, "added": 50}

NUTR = {  # FDC nutrient number -> field
    "208": "kcal", "204": "fat", "606": "sat", "605": "trans", "601": "chol",
    "307": "sodium", "205": "carb", "291": "fiber", "269": "sugar", "539": "added", "203": "prot",
}

# ── the legal lattice, per 101.9(c) ──────────────────────────────────────────
def on_lattice(field, v, tol=1e-6):
    def near(x, step):
        return abs(x - round(x / step) * step) <= tol
    if v < 0:
        return False
    if field == "kcal":
        return near(v, 5) if v <= 50 else near(v, 10)
    if field in ("fat", "sat", "trans"):
        return near(v, 0.5) if v < 5 else near(v, 1)
    if field == "chol":
        return near(v, 5)
    if field == "sodium":
        return v == 0 or (near(v, 5) if v <= 140 else near(v, 10))
    return near(v, 1)  # carb, fiber, sugar, added, prot

def snap(field, x):
    """Nearest legal declared value to an unrounded amount."""
    if field == "kcal":
        return 0 if x < 5 else (5 * round(x / 5) if x <= 50 else 10 * round(x / 10))
    if field in ("fat", "sat", "trans"):
        return 0 if x < 0.5 else (0.5 * round(x / 0.5) if x < 5 else float(round(x)))
    if field == "chol":
        return 0 if x < 2 else 5 * round(x / 5)
    if field == "sodium":
        return 0 if x < 5 else (5 * round(x / 5) if x <= 140 else 10 * round(x / 10))
    return 0 if x < 0.5 else float(round(x))

def interval(field, d):
    """The range of ACTUAL amounts that round to declared value d."""
    if field == "kcal":
        if d == 0:
            return (0, 5)
        s = 5 if d <= 50 else 10
        return (d - s / 2, d + s / 2)
    if field in ("fat", "sat", "trans"):
        if d == 0:
            return (0, 0.5)
        s = 0.5 if d < 5 else 1
        return (d - s / 2, d + s / 2)
    if field == "chol":
        return (0, 2) if d == 0 else (d - 2.5, d + 2.5)
    if field == "sodium":
        if d == 0:
            return (0, 5)
        s = 5 if d <= 140 else 10
        return (d - s / 2, d + s / 2)
    return (0, 0.5) if d == 0 else (d - 0.5, d + 0.5)

def dv_allowed(field, d):
    """%DV may be computed from the declared OR the actual amount (101.9(d)(7)(ii)).
    So a printed %DV is valid if it is round(declared/DRV) or round(any actual/DRV)."""
    lo, hi = interval(field, d)
    a = math.floor(lo / DV[field] * 100 + 0.5)
    b = math.floor(hi / DV[field] * 100 + 0.5)
    return set(range(a, b + 1)) | {math.floor(d / DV[field] * 100 + 0.5)}

# ── 1. recover real printed panels ──────────────────────────────────────────
foods = json.load(open(HERE / "fdc_search.json", encoding="utf-8"))["foods"]
panels, lattice_hits, lattice_total = [], 0, 0
for f in foods:
    unit = (f.get("servingSizeUnit") or "").upper()
    s = f.get("servingSize")
    if unit not in ("GRM", "G", "MLT", "ML") or not s:
        continue
    per100 = {}
    for n in f.get("foodNutrients", []):
        k = NUTR.get(str(n.get("nutrientNumber")))
        if k and n.get("value") is not None and (k != "kcal" or n.get("unitName") == "KCAL"):
            per100[k] = n["value"]
    if not all(k in per100 for k in ("kcal", "fat", "carb", "prot")):
        continue
    panel = {k: snap(k, v * s / 100) for k, v in per100.items()}
    raw = {k: v * s / 100 for k, v in per100.items()}
    # faithfulness: how close was the back-multiplied value to its lattice point?
    for k, v in raw.items():
        lattice_total += 1
        # per-100 g is stored to ~0.1 g / 1 kcal / 1 mg, so allow that much, scaled by serving
        prec = (0.51 if k in ("kcal", "sodium", "chol") else 0.051) * s / 100
        if abs(v - panel[k]) <= max(prec, 0.02):
            lattice_hits += 1
    panel["_serving"] = s
    panel["_name"] = f.get("description", "")[:40]
    panels.append(panel)

print(f"products usable: {len(panels)} of {len(foods)}")
print(f"recovered values within storage precision of a legal lattice point: "
      f"{lattice_hits}/{lattice_total} = {lattice_hits/lattice_total:.1%}")

# ── 2. the energy identity on REAL labels ───────────────────────────────────
def resid(p):
    return p["kcal"] - (4 * p["prot"] + 4 * p["carb"] + 9 * p["fat"])

random.shuffle(panels)
half = len(panels) // 2
train, test = panels[:half], panels[half:]
r_train = sorted(resid(p) for p in train)
def q(xs, a):
    i = (len(xs) - 1) * a
    lo, hi = math.floor(i), math.ceil(i)
    return xs[lo] + (xs[hi] - xs[lo]) * (i - lo)
# The energy check, derived rather than fitted. Every declared number stands
# for an INTERVAL of actual amounts (its rounding step). FDA applies the 4/4/9
# factors to the actual amounts, so the declared calories must be reachable from
# SOME choice of actual protein, carbs and fat inside their intervals — widened
# only by a "method allowance" for fiber subtraction and specific Atwater
# factors, which is the one thing calibrated on data (train half).
def energy_gap(p):
    klo, khi = interval("kcal", p["kcal"])
    plo, phi = interval("prot", p["prot"]); clo, chi = interval("carb", p["carb"])
    flo, fhi = interval("fat", p["fat"])
    elo, ehi = 4 * plo + 4 * clo + 9 * flo, 4 * phi + 4 * chi + 9 * fhi
    if khi < elo:  return khi - elo      # calories too LOW for these macros
    if klo > ehi:  return klo - ehi      # calories too HIGH
    return 0.0
gaps = sorted(energy_gap(p) / max(p["kcal"], 1) for p in train)
M_LO = min(0.0, q(gaps, 0.01)); M_HI = max(0.0, q(gaps, 0.99))
def atwater_ok(p):
    g = energy_gap(p) / max(p["kcal"], 1)
    return M_LO - 0.01 <= g <= M_HI + 0.01
BAND_LO, BAND_HI = M_LO, M_HI

all_r = [resid(p) for p in panels]
print(f"\nenergy residual kcal - (4P+4C+9F) on real labels, n={len(all_r)}:")
print(f"  median {st.median(all_r):+.1f}   p5 {q(sorted(all_r),.05):+.1f}   p95 {q(sorted(all_r),.95):+.1f}"
      f"   min {min(all_r):+.0f}   max {max(all_r):+.0f}")
print(f"  gap left AFTER rounding intervals, calibrated on TRAIN: [{BAND_LO:+.3f}, {BAND_HI:+.3f}] of declared kcal")
print(f"  TRAIN products needing any allowance beyond pure rounding: {sum(1 for p in train if energy_gap(p)!=0)}/{len(train)}")
test_pass = sum(atwater_ok(p) for p in test) / len(test)
print(f"  held-out TEST half inside that band: {test_pass:.1%}  (false-alarm rate {1-test_pass:.1%})")

# ── 3. constraints on a read panel ──────────────────────────────────────────
def hierarchy_ok(p):
    t = 0.51
    ok = True
    if "sat" in p: ok &= p["sat"] + p.get("trans", 0) <= p["fat"] + t
    if "sugar" in p: ok &= p["sugar"] <= p["carb"] + t
    if "added" in p and "sugar" in p: ok &= p["added"] <= p["sugar"] + t
    if "fiber" in p: ok &= p["fiber"] <= p["carb"] + t
    ok &= p["prot"] + p["carb"] + p["fat"] <= p["_serving"] * 1.02 + 1.5
    return ok

def lattice_ok(p):
    return all(on_lattice(k, v) for k, v in p.items() if not k.startswith("_") and not k.endswith("%"))

def dv_ok(p):
    for k in DV:
        if k in p and (k + "%") in p:
            if p[k + "%"] not in dv_allowed(k, p[k]):
                return False
    return True

CHECKS = {
    "nothing (read it and trust it)": lambda p: True,
    "energy identity only": atwater_ok,
    "+ rounding lattice": lambda p: atwater_ok(p) and lattice_ok(p),
    "+ %DV column": lambda p: atwater_ok(p) and lattice_ok(p) and dv_ok(p),
    "+ hierarchy (sub-totals <= totals)": lambda p: atwater_ok(p) and lattice_ok(p) and dv_ok(p) and hierarchy_ok(p),
}

# ── the printed tokens, and an assumed OCR channel ──────────────────────────
def with_dv(p):
    q_ = dict(p)
    for k in DV:
        if k in p:
            q_[k + "%"] = math.floor(p[k] / DV[k] * 100 + 0.5)  # declared-based, the common practice
    return q_

def fmt(v):
    return str(int(v)) if float(v).is_integer() else f"{v:g}"

CONFUSE = {  # well-documented OCR digit confusions on printed labels
    "0": "689", "1": "74", "2": "7", "3": "8", "4": "1", "5": "68",
    "6": "508", "7": "12", "8": "3069", "9": "80",
}

def corruptions(s):
    """Every single-token misread the channel can produce from printed string s."""
    out = set()
    for i, ch in enumerate(s):
        for c in CONFUSE.get(ch, ""):
            out.add(s[:i] + c + s[i + 1:])
    if "." in s:
        out.add(s.replace(".", ""))            # dropped decimal: "2.5" -> "25"
    out.add(s + "9")                            # the unit 'g' read as a digit: "8g" -> "89"
    if len(s) > 1:
        out.add(s[1:]); out.add(s[:-1])         # a clipped leading/trailing digit
    out.discard(s)
    return [x for x in out if x and not x.startswith(".") and x.count(".") <= 1]

def parse(x):
    try:
        return float(x)
    except ValueError:
        return None

fields_of = lambda p: [k for k in p if not k.startswith("_")]

# ── 4. single-error experiment ──────────────────────────────────────────────
def run(trials_panels, n_err):
    res = {name: {"detected": 0, "silent": 0, "corrected": 0, "ambiguous": 0, "miscorrected": 0, "n": 0, "silent_fields": {}} for name in CHECKS}
    for p in trials_panels:
        truth = with_dv(p)
        keys = fields_of(truth)
        for _ in range(6):
            read = dict(truth)
            chosen = random.sample(keys, n_err)
            ok = True
            for k in chosen:
                c = corruptions(fmt(truth[k]))
                v = parse(random.choice(c)) if c else None
                if v is None:
                    ok = False; break
                read[k] = v
            if not ok or all(read[k] == truth[k] for k in chosen):
                continue
            for name, chk in CHECKS.items():
                r = res[name]; r["n"] += 1
                if chk(read):
                    r["silent"] += 1
                    for k in chosen:
                        r["silent_fields"][k] = r["silent_fields"].get(k, 0) + 1
                    continue
                r["detected"] += 1
                if n_err != 1:
                    continue
                # decode: try every single-token repair; keep those that satisfy everything
                fits = []
                for k in keys:
                    for cand in [fmt(read[k])] + corruptions(fmt(read[k])):
                        v = parse(cand)
                        if v is None or v == read[k]:
                            continue
                        trial = dict(read); trial[k] = v
                        if chk(trial):
                            fits.append((k, v))
                fits = list(dict.fromkeys(fits))
                if len(fits) == 1 and truth[fits[0][0]] == fits[0][1]:
                    r["corrected"] += 1
                elif len(fits) == 1:
                    r["miscorrected"] += 1   # decoder "fixed" it to a WRONG value
                elif len(fits) > 1:
                    r["ambiguous"] += 1
    return res

def show(title, res, n_err):
    print(f"\n{title}")
    print(f"  {'constraints applied':38} {'detected':>9} {'SILENT':>8}" + ("" if n_err != 1 else f" {'corrected':>10} {'MIScorr':>8} {'ambiguous':>10}"))
    for name, r in res.items():
        n = r["n"] or 1
        line = f"  {name:38} {r['detected']/n:>9.1%} {r['silent']/n:>8.1%}"
        if n_err == 1:
            line += f" {r['corrected']/n:>10.1%} {r['miscorrected']/n:>8.1%} {r['ambiguous']/n:>10.1%}"
        print(line)
    print(f"  (trials: {next(iter(res.values()))['n']})")
    full = res["+ hierarchy (sub-totals <= totals)"]
    print("  silent misreads that survive ALL checks, by field:", dict(sorted(full["silent_fields"].items(), key=lambda kv: -kv[1])))

show("ONE misread token per panel — held-out TEST products", run(test, 1), 1)
show("TWO misread tokens per panel — held-out TEST products", run(test, 2), 2)

# ── 5. serving-level failures ───────────────────────────────────────────────
# Realistic version: the "Serving size" line is its own line and is read
# correctly; only the NUMBERS come from the wrong column. So serving does NOT
# scale with them — which gives the mass check (protein+carbs+fat <= serving
# grams) something to bite on.
FULL = CHECKS["+ hierarchy (sub-totals <= totals)"]
def container_read(p, k_):
    q_ = {kk: snap(kk, v * k_) for kk, v in p.items() if not kk.startswith("_")}
    q_["_serving"] = p["_serving"]          # the serving line is NOT scaled
    return with_dv(q_)
print()
for kf in (2.0, 3.0, 4.0):
    caught = sum(not FULL(container_read(p, kf)) for p in test)
    print(f"numbers read from a {kf:g}-serving container column: caught {caught}/{len(test)} ({caught/len(test):.0%})")
# the serving size itself misread (the numbers are right, the serving is not)
for label, fac in (("serving read 10x too big (e.g. '28g' as '280g')", 10), ("serving read as ~1/3 ('30g' as '10g')", 1/3)):
    caught = sum(not FULL(dict(with_dv(p), _serving=p["_serving"] * fac)) for p in test)
    print(f"{label}: caught {caught}/{len(test)} ({caught/len(test):.0%})")
