"""Golden fixtures for the Node PQ-VAE sidecar (main/pqvae/): requests plus the responses the REAL Python sidecar gives.

    python -P scripts/pqvae-golden.py [--src <vendor pqvae dir>] [--out tests/fixtures/pqvae]

It imports vendor/whiq-agent/.../server/pqvae/sidecar.py and calls its handlers (the same function the HTTP route calls),
on CPU, with the decide seat switched off (LLM_ROUTER_URL points at a closed port, so the keyword -> MiniLM -> position
chain runs alone). Needs torch, numpy and sentence-transformers and the MiniLM weights in the Hugging Face cache.
Writes one JSON file per case ({endpoint, request, response}), names.json (the texts the exporter measures the compressed
MiniLM on) and tokenizer.json (texts with the token ids the Python tokenizer gives). Nothing under vendor/ is changed.
"""
import argparse
import copy
import glob
import json
import os
import random
import sys
import unicodedata
from datetime import datetime
from pathlib import Path

# CPU only, offline, no decide seat: set before torch / sidecar are imported.
os.environ["CUDA_VISIBLE_DEVICES"] = ""
os.environ["LLM_ROUTER_URL"] = "http://127.0.0.1:1"
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
DEFAULT_SRC = REPO / "vendor" / "whiq-agent" / "03 Shared Platform Agents" / "app" / "server" / "pqvae"


# ── programmes ────────────────────────────────────────────────────────────────
def _xer_tables(path):
    tables, cur, fields = {}, None, None
    with open(path, encoding="cp1252", errors="replace") as f:
        for line in f:
            r = line.rstrip("\r\n").split("\t")
            if r[0] == "%T":
                cur, fields = r[1], None
                tables[cur] = []
            elif r[0] == "%F":
                fields = r[1:]
            elif r[0] == "%R" and cur and fields:
                tables[cur].append(dict(zip(fields, r[1:])))
    return tables


def _ts(s):
    return datetime.strptime(s[:16], "%Y-%m-%d %H:%M").timestamp()


def xer_records(path, ptype, limit=None):
    """ActivityRecords the way tools/pqvae.ts scheduleToRecords builds them from a computed schedule: milestones are dropped,
    position_frac is the start's share of the span, predecessor counts come from the links, the phase is the WBS name."""
    t = _xer_tables(path)
    wbs = {w["wbs_id"]: w["wbs_name"] for w in t.get("PROJWBS", [])}
    tasks = [x for x in t["TASK"] if x.get("early_start_date") and x.get("early_end_date")]
    ids = {x["task_id"] for x in tasks}
    succ, npred, fs = {}, {}, {}
    for p in t.get("TASKPRED", []):
        if p["task_id"] not in ids:
            continue
        npred[p["task_id"]] = npred.get(p["task_id"], 0) + 1
        succ[p["pred_task_id"]] = succ.get(p["pred_task_id"], 0) + 1
        fs[p["task_id"]] = fs.get(p["task_id"], 0) + (1 if p["pred_type"] == "PR_FS" else 0)
    t0 = min(_ts(x["early_start_date"]) for x in tasks)
    t1 = max(_ts(x["early_end_date"]) for x in tasks)
    span = max(1.0, (t1 - t0) / 86400)
    recs = []
    for i, x in enumerate(tasks):
        dur = float(x["target_drtn_hr_cnt"] or 0) / 8.0
        if dur <= 0:
            continue
        n = npred.get(x["task_id"], 0)
        recs.append({
            "project_id": "P", "activity_id": str(x["task_id"]), "name": x["task_name"],
            "phase": wbs.get(x["wbs_id"]),
            "duration_days": max(0.5, dur), "crew_size": 6,
            "position_frac": min(1.0, max(0.0, (_ts(x["early_start_date"]) - t0) / 86400 / span)),
            "n_predecessors": n, "n_successors": succ.get(x["task_id"], 0),
            "rel_fs_frac": (fs.get(x["task_id"], 0) / n) if n else 1.0,
            "zone": 0, "project_zones": 1, "project_size_eur": 20e6, "ptype": ptype,
        })
        if limit and len(recs) >= limit:
            break
    return recs


def synthetic(names, ptype, seed, durations=None):
    """A small hand-made programme: names in start order, evenly spread, a chain of FS links."""
    rnd = random.Random(seed)
    n = len(names)
    out = []
    for i, nm in enumerate(names):
        out.append({
            "project_id": "P", "activity_id": str(i + 1), "name": nm,
            "duration_days": (durations[i] if durations else float(rnd.choice([3, 5, 8, 10, 15, 20, 30]))),
            "crew_size": rnd.choice([4, 6, 8, 12]), "position_frac": round(i / max(n - 1, 1), 4),
            "n_predecessors": 0 if i == 0 else 1, "n_successors": 0 if i == n - 1 else 1, "rel_fs_frac": 1.0,
            "zone": 0, "project_zones": 1, "project_size_eur": 12e6, "ptype": ptype,
        })
    return out


FINNISH = ["Työmaan perustaminen", "Kaivu ja täytöt", "Paalutus", "Perustukset ja pohjalaatta", "Betonirunko kerros 1", "Betonirunko kerros 2",
           "Teräsrunko asennus", "Julkisivun elementtiasennus", "Vesikatto ja vesieristys", "Ikkunoiden asennus", "IV-kanavien asennus",
           "Sähkökaapelointi", "LVI-putkistot", "Sisäpuolinen maalaus", "Lattiapinnoitus", "Kalusteasennus", "Järjestelmien käyttöönotto", "Luovutus ja jälkitöt"]
GERMAN = ["Baustelleneinrichtung", "Aushub Baugrube", "Bodenplatte betonieren", "Rohbau Decke 1", "Rohbau Decke 2", "Fassade Montage",
          "Dachabdichtung", "Fenster einbauen", "Lüftungskanäle Installation", "Elektroinstallation Kabel", "Sanitärinstallation Rohre",
          "Trockenbau Ausbau", "Estrich und Bodenbelag", "Malerarbeiten", "Inbetriebnahme Haustechnik", "Abnahme und Übergabe"]
ARABIC = ["تجهيز الموقع", "أعمال الحفر", "الخوازيق والأساسات", "صب الخرسانة للأساسات", "الهيكل الخرساني للدور الأول", "الهيكل الخرساني للدور الثاني",
          "تركيب الواجهات الزجاجية", "العزل المائي للسطح", "تركيب النوافذ والأبواب", "أعمال التكييف والتهوية", "تمديدات الكابلات الكهربائية",
          "أنابيب السباكة والصرف", "أعمال البلاط والأرضيات", "الدهانات الداخلية", "اختبار وتشغيل الأنظمة", "التسليم النهائي"]
SWEDISH = ["Etablering", "Schaktning och sprängning", "Pålning", "Grundläggning", "Stomme betong", "Stålstomme", "Fasad", "Tak", "Fönster",
           "Ventilation", "Elinstallation", "VVS rör", "Målning", "Golv", "Besiktning och driftsättning"]
ENGLISH = ["Site mobilisation", "Bulk excavation", "Piling works", "Foundations and ground slab", "Concrete frame level 1", "Concrete frame level 2",
           "Facade cladding", "Roofing and waterproofing", "Window installation", "HVAC ductwork first fix", "Electrical containment",
           "Plumbing pipework", "Interior finishes", "Painting", "Testing and commissioning", "Handover and snagging"]
MIXED = FINNISH[:8] + GERMAN[2:8] + ARABIC[:6] + SWEDISH[:5] + ENGLISH[10:]


def trajectory_periods(n, planned, seed, with_counts=True, with_spi=True, slip=0.85):
    """Monthly states: planned follows an S-curve, actual lags it by `slip`."""
    rnd = random.Random(seed)
    out = []
    for k in range(1, n + 1):
        x = k / planned
        pp = min(1.0, 3 * x * x - 2 * x * x * x)
        ap = max(0.0, min(1.0, pp * slip + rnd.uniform(-0.01, 0.01)))
        p = {"period": k, "planned_pct": round(pp, 4), "actual_pct": round(ap, 4)}
        if with_spi:
            p["spi"] = round(ap / pp, 3) if pp else 1.0
        if with_counts:
            p["rfi_count"] = rnd.randint(0, 25)
            p["variation_count"] = rnd.randint(0, 6)
        out.append(p)
    return out


def calib_outcomes():
    return [
        {"project_id": "a", "ptype": "Office", "planned_months": 18, "actual_months": 21, "delay_months": 3.0, "overrun_ratio": 1.12, "source": "t"},
        {"project_id": "b", "ptype": "Office", "planned_months": 24, "actual_months": 24, "delay_months": 0.0, "overrun_ratio": 1.03, "source": "t"},
        {"project_id": "c", "ptype": "Hospital", "planned_months": 30, "actual_months": 38, "delay_months": 8.0, "overrun_ratio": 1.4, "source": "t"},
        {"project_id": "d", "ptype": "Road", "planned_months": 14, "actual_months": 15, "delay_months": 1.0, "overrun_ratio": None, "source": "t"},
        {"project_id": "e", "ptype": "Road", "planned_months": 20, "actual_months": 20, "delay_months": None, "overrun_ratio": 1.08, "source": "t"},
    ]


# ── tokenizer / name corpora ──────────────────────────────────────────────────
def all_task_names():
    names = set()
    for f in sorted(glob.glob(str(REPO / "Sample XERs" / "*.xer"))):
        try:
            for x in _xer_tables(f).get("TASK", []):
                n = (x.get("task_name") or "").strip()
                if n:
                    names.add(n)
        except Exception:
            continue
    return sorted(names)


def token_cases(names):
    """Texts for the tokenizer check: real activity names, the multilingual lists, odd spacing, and every code point of a few
    blocks on its own and in the composed / decomposed forms."""
    cases = list(names)
    cases += FINNISH + GERMAN + ARABIC + SWEDISH + ENGLISH
    cases += ["", " ", "  two  spaces  ", "\ttab\tseparated\n", "a b", "Café crème brûlée", "café cremè", "ﬁnish ﬂoor", "ＦＵＬＬＷＩＤＴＨ ｔｅｘｔ", "①②③ 1/2 ½", "x²+y³", "é́", "ǅ ǈ ǋ",
              "<s>mask</s> <mask> <pad>", "emoji 🚧 crane 🏗️", "日本語のテキスト", "한국어 텍스트", "Ελληνικά κείμενα", "Русский текст", "ไทย", "हिन्दी", "עברית", "ß ẞ İ ı", "word▁with▁marks", "▁", "a▁", "​zero​width", "﻿bom text", "tab\u0000nul", "ab" * 200,
              "Pouring  For  Tank slab", "Rebar for R.C raft", "M&E conduits For basement Slab & stairs (by others) Area 3"]
    for lo, hi in ((0x20, 0x250), (0x370, 0x400), (0x400, 0x4ff), (0x590, 0x600), (0x600, 0x700), (0x900, 0x980), (0x1e00, 0x1f00), (0x2000, 0x2200), (0x2460, 0x2500), (0x3040, 0x3100), (0xfb00, 0xfb50), (0xfe70, 0xff00), (0xff00, 0xfff0)):
        for cp in range(lo, hi):
            ch = chr(cp)
            if unicodedata.category(ch) in ("Cs", "Co", "Cn"):
                continue
            cases.append("a" + ch + "b")
    for s in ("Bodenplatte", "Käyttöönotto", "färdigställande", "Übergabe", "Fassade", "señalización", "électricité", "çatı", "ångström", "naïve façade"):
        cases.append(unicodedata.normalize("NFD", s))
        cases.append(unicodedata.normalize("NFKD", s))
    seen, out = set(), []
    for c in cases:
        if c not in seen:
            seen.add(c)
            out.append(c)
    return out


# ── main ──────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=str(DEFAULT_SRC))
    ap.add_argument("--out", default=str(REPO / "tests" / "fixtures" / "pqvae"))
    a = ap.parse_args()
    src, out = Path(a.src).resolve(), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(src))
    import importlib.util
    spec = importlib.util.spec_from_file_location("pqvae_sidecar", src / "sidecar.py")
    sc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sc)
    sc._dev = lambda: "cpu"
    import torch
    torch.set_num_threads(1)

    def run(route, body):
        req = copy.deepcopy(body)
        res = sc.ROUTES[route](copy.deepcopy(body))
        if isinstance(res, dict):
            res.setdefault("calibration", sc.CALIBRATION)
        return {"endpoint": route, "request": req, "response": json.loads(json.dumps(sc._jsonable(res)))}

    cases = {}

    # (a) the cairo programme as the tool builds it, (b) 5 activities, (c) non-English programmes
    cairo = xer_records(REPO / "Sample XERs" / "cairo festival city.xer", "Office")
    cases["review-cairo"] = run("/review_schedule", {"records": cairo, "shuffles": 12})
    three = xer_records(REPO / "Sample XERs" / "3-Storey_Residential_Block_Compressed_Baseline.xer", "Residential")
    cases["review-3storey"] = run("/review_schedule", {"records": three, "shuffles": 12})
    aurora = xer_records(REPO / "Sample XERs" / "Aurora_Tower_Baseline.xer", "Office")
    cases["review-aurora"] = run("/review_schedule", {"records": aurora, "shuffles": 12})
    cases["review-cairo-5shuffles"] = run("/review_schedule", {"records": cairo, "shuffles": 5})
    cases["review-small5"] = run("/review_schedule", {"records": synthetic(ENGLISH[:5], "Residential", 5), "shuffles": 12})
    cases["review-finnish"] = run("/review_schedule", {"records": synthetic(FINNISH, "Office", 11), "shuffles": 12})
    cases["review-arabic"] = run("/review_schedule", {"records": synthetic(ARABIC, "Hospital", 12), "shuffles": 12})
    cases["review-german-swedish"] = run("/review_schedule", {"records": synthetic(GERMAN + SWEDISH, "Industrial", 13), "shuffles": 12})
    cases["review-mixed"] = run("/review_schedule", {"records": synthetic(MIXED, "School", 14), "shuffles": 12})
    cases["review-three"] = run("/review_schedule", {"records": synthetic(ENGLISH[:3], "Road", 3), "shuffles": 12})
    cases["review-too-few"] = run("/review_schedule", {"records": synthetic(ENGLISH[:2], "Road", 2)})
    # out-of-order and odd inputs: given trade / phase, position_frac missing, a duration of 0, free-text ptype
    odd = synthetic(ENGLISH, "logistics warehouse", 21)
    odd[0].update({"trade": "civil", "phase": "substructure"})
    odd[3].pop("position_frac")
    odd[5]["duration_days"] = 0
    odd[7]["trade"] = "Mechanical"
    odd[9]["phase"] = "Rough in"
    odd[10]["duration_days"] = 900
    odd[11]["duration_days"] = 0.2
    cases["review-odd-inputs"] = run("/review_schedule", {"records": odd, "shuffles": 12})
    # the company's own programmes and durations blended into the bands
    calib = {"orgId": "golden", "builtAt": "2026-01-01T00:00:00Z", "counts": {"schedules": 2},
             "duration": {"civil|substructure": [10, 12, 14, 9, 11, 13, 8, 16], "structure|superstructure": [20, 25, 22, 30, 28, 24, 26]},
             "programmes": [{"project_id": "org1", "ptype": "Office", "records": synthetic(ENGLISH, "Office", 31)},
                            {"project_id": "org2", "ptype": "Office", "records": synthetic(GERMAN, "Office", 32)}]}
    cases["review-cairo-calib"] = run("/review_schedule", {"records": cairo, "shuffles": 12, "calib": calib})

    names_for_encode = synthetic(ENGLISH + FINNISH[:6] + ARABIC[:6], "Office", 41)
    cases["encode-mixed"] = run("/encode", {"records": names_for_encode})
    cases["encode-cairo"] = run("/encode", {"records": cairo})

    # (d) trajectory
    for n, planned, pt, seed in ((3, 12, "Residential", 1), (8, 12, "Office", 2), (20, 24, "Road", 3), (8, 6, "Hospital", 4), (20, 18, "Metro", 5), (3, 30, "Bridge", 6)):
        cases[f"traj-{n}-{pt.lower()}-p{planned}"] = run("/trajectory", {"periods": trajectory_periods(n, planned, seed), "ptype": pt, "planned_months": planned})
    cases["traj-8-nocounts-nospi"] = run("/trajectory", {"periods": trajectory_periods(8, 12, 7, with_counts=False, with_spi=False, slip=0.7), "ptype": "School"})
    cases["traj-8-freetext-ptype"] = run("/trajectory", {"periods": trajectory_periods(8, 12, 8), "ptype": "data centre"})
    cases["traj-20-unordered"] = run("/trajectory", {"periods": list(reversed(trajectory_periods(20, 20, 9, slip=1.1))), "ptype": "Airport", "planned_months": 20})
    cases["traj-1-period"] = run("/trajectory", {"periods": trajectory_periods(1, 12, 1), "ptype": "Office"})
    fit = {"n": 6, "a": 0.4, "b": 1.15, "mae_raw": 2.5, "mae_fit": 1.9}
    for n, pt in ((3, "Office"), (8, "Hospital"), (20, "Road")):
        cases[f"traj-{n}-{pt.lower()}-fit"] = run("/trajectory", {"periods": trajectory_periods(n, 24, 20 + n), "ptype": pt, "planned_months": 24,
                                                                  "calib": {"orgId": "golden", "builtAt": "2026-01-01T00:00:00Z", "counts": {"outcomes": 6}, "outcome_fit": fit}})
    cases["traj-8-fit-by-ptype"] = run("/trajectory", {"periods": trajectory_periods(8, 12, 30), "ptype": "Hospital", "planned_months": 12,
                                                       "calib": {"orgId": "golden", "builtAt": "x", "outcome_fit": fit, "outcome_fit_by_ptype": {"Hospital": {"n": 12, "a": -0.3, "b": 0.8, "mae_raw": 3, "mae_fit": 2}}}})
    cases["traj-8-fit-too-few"] = run("/trajectory", {"periods": trajectory_periods(8, 12, 31), "ptype": "Office", "calib": {"orgId": "golden", "outcome_fit": {"n": 2, "a": 1, "b": 1}}})
    cases["traj-8-calib-no-fit"] = run("/trajectory", {"periods": trajectory_periods(8, 12, 32), "ptype": "Office", "calib": {"orgId": "golden", "builtAt": "x", "counts": {"schedules": 3}}})

    # (e) reference class
    from whiqcodes.schemas import PROJECT_TYPES
    oc = calib_outcomes()
    for pt in PROJECT_TYPES:
        cases[f"refclass-{pt.lower()}"] = run("/refclass", {"ptype": pt, "budget_eur": 50_000_000})
        cases[f"refclass-{pt.lower()}-outcomes"] = run("/refclass", {"ptype": pt, "budget_eur": 0, "calib": {"orgId": "golden", "builtAt": "x", "counts": {"outcomes": len(oc)}, "outcomes": oc}})
    cases["refclass-freetext"] = run("/refclass", {"ptype": "metro line", "budget_eur": 1_000_000_000})
    cases["refclass-one-outcome"] = run("/refclass", {"ptype": "Office", "calib": {"orgId": "golden", "outcomes": oc[:1]}})

    for pt in ("Office", "Metro", "Nuclear plant", "Road"):
        for cf in ("lump_sum", "remeasured", "cost_plus"):
            cases[f"growth-{pt.split()[0].lower()}-{cf}"] = run("/growth", {"ptype": pt, "contract_form": cf})
    cases["growth-default"] = run("/growth", {"ptype": "Hospital"})

    for name, c in cases.items():
        (out / f"{name}.json").write_text(json.dumps(c, ensure_ascii=False, indent=None, separators=(",", ":")) + "\n", encoding="utf-8")

    # the keyword tables and prototype phrases (main/pqvae/tables.ts is checked against them) and numpy's shuffle stream (main/pqvae/rng.ts)
    (out / "tables.json").write_text(json.dumps({"trade_kw": sc._TRADE_KW, "phase_kw": sc._PHASE_KW, "trade_proto": sc._TRADE_PROTO, "phase_proto": sc._PHASE_PROTO},
                                                ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    import numpy as np
    rngs = []
    for seed in (7, 0, 123456789):
        g = np.random.default_rng(seed)
        rngs.append({"seed": seed, "perms": [{"n": n, "perm": g.permutation(n).tolist()} for n in (1, 2, 3, 5, 12, 49, 60, 300, 1000, 5, 49, 257) for _ in range(2)]})
    (out / "rng.json").write_text(json.dumps(rngs, separators=(",", ":")) + "\n", encoding="utf-8")

    # texts for the exporter's measurement of the compressed MiniLM, and tokenizer cases
    task_names = all_task_names()
    rnd = random.Random(7)
    sample = sorted(rnd.sample(task_names, min(1500, len(task_names)))) if task_names else []
    names = sample + FINNISH + GERMAN + ARABIC + SWEDISH + ENGLISH
    (out / "names.json").write_text(json.dumps(names, ensure_ascii=False) + "\n", encoding="utf-8")

    from sentence_transformers import SentenceTransformer
    tk = SentenceTransformer("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2", device="cpu").tokenizer
    texts = token_cases(rnd.sample(task_names, min(400, len(task_names))))
    tc = [{"text": t, "ids": tk(t)["input_ids"]} for t in texts]
    (out / "tokenizer.json").write_text(json.dumps(tc, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{len(cases)} cases, {len(names)} names, {len(tc)} tokenizer cases -> {out}")


if __name__ == "__main__":
    main()
