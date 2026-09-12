# Exhaustive per-field test: for every held-out product, apply EVERY possible
# single misread of each field (not a random sample), and classify the outcome.
import runpy, io, contextlib
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    g = runpy.run_path("label_channel.py")      # reuse the exact same checks + data split
FULL, test, with_dv, corruptions, fmt, parse = (g["CHECKS"]["+ hierarchy (sub-totals <= totals)"],
    g["test"], g["with_dv"], g["corruptions"], g["fmt"], g["parse"])
fields_of = lambda p: [k for k in p if not k.startswith("_")]

stats = {}
for p in test:
    truth = with_dv(p); keys = fields_of(truth)
    for k in keys:
        for bad in corruptions(fmt(truth[k])):
            v = parse(bad)
            if v is None or v == truth[k]:
                continue
            read = dict(truth); read[k] = v
            s = stats.setdefault(k, {"n": 0, "caught": 0, "fixed": 0, "wrongfix": 0})
            s["n"] += 1
            if FULL(read):
                continue
            s["caught"] += 1
            fits = []
            for kk in keys:
                for cand in [fmt(read[kk])] + corruptions(fmt(read[kk])):
                    vv = parse(cand)
                    if vv is None or vv == read[kk]:
                        continue
                    t = dict(read); t[kk] = vv
                    if FULL(t):
                        fits.append((kk, vv))
            fits = list(dict.fromkeys(fits))
            if len(fits) == 1:
                if truth[fits[0][0]] == fits[0][1]: s["fixed"] += 1
                else: s["wrongfix"] += 1

order = ["kcal","fat","fat%","sat","sat%","trans","chol","chol%","sodium","sodium%","carb","carb%","fiber","fiber%","sugar","added","added%","prot"]
print(f"{'field':9} {'misreads':>8} {'caught':>8} {'SILENT':>8} {'auto-fix':>9} {'WRONG fix':>10}   verdict")
tot = {"n":0,"caught":0}
for k in order:
    if k not in stats: continue
    s = stats[k]; n = s["n"]; tot["n"] += n; tot["caught"] += s["caught"]
    silent = 1 - s["caught"]/n
    verdict = "self-checking" if silent < 0.02 else ("mostly" if silent < 0.15 else "NEEDS EYES")
    print(f"{k:9} {n:>8} {s['caught']/n:>8.1%} {silent:>8.1%} {s['fixed']/n:>9.1%} {s['wrongfix']/n:>10.1%}   {verdict}")
print(f"\nall fields, every single misread: caught {tot['caught']}/{tot['n']} = {tot['caught']/tot['n']:.1%}")
