"""Export the PQ-VAE models and data the Node sidecar (main/pqvae/) needs, so no Python or torch runs on the user's PC.

    python -P scripts/pqvae-export.py [<pqvae dir>] [<out dir>] [--minilm <id or folder>] [--variant auto|fp32|fp16|int8-emb|int8]

<pqvae dir>  vendor/whiq-agent/03 Shared Platform Agents/app/server/pqvae   (read only)
<out dir>    vendor/whiq-agent/pqvae-onnx/

Run it on the BUILD machine (torch, numpy, onnx, onnxruntime, sentence-transformers; the MiniLM weights in the Hugging Face
cache). `-P` keeps the working folder off sys.path; `-I` is not used because torch here needs the user site (typing_extensions).
Same inputs give the same files: nothing in the output depends on the time or the machine, and the manifest says which tool
versions wrote it. Writes:

  vocab_a_codes.onnx   420 features -> 3 residual-quantised codes (encoder + the nearest-code search, in the graph)
  vocab_b_codes.onnx   17 period features -> 3 codes
  ar_nll.onnx          CodeTransformer: codes (B,L,3) + project type (B) -> NLL per activity (B,L)
  trajectory_head.onnx TrajectoryHead: codes (B,L,3) + project type (B) -> (log overrun, log1p delay)
  minilm.onnx          paraphrase-multilingual-MiniLM-L12-v2 transformer (hidden states; pooling is done by the caller)
  tokenizer.json       its tokenizer
  ar_calibration.json duration_bands.json growth_params.json horrormap.json ted_winratios.json
  LICENSE-MiniLM.txt   the Apache-2.0 text the MiniLM model is under (scripts/licenses/LICENSE-Apache-2.0.txt)
  NOTICE.txt           the source model and its revision, and where each data file comes from
  manifest.json        files + sha256, source commit, calibration label, MiniLM variants measured and the one chosen

MiniLM variants (all measured against the fp32 sentence-transformers output on the same texts):
  fp32      the model as trained (~470 MB)
  fp16      every weight stored as fp16, computed as fp32
  int8-emb  word-embedding table as int8 with one scale per token, the other weights fp16
  int8      onnxruntime dynamic int8 quantisation of every MatMul and of the embedding table
The smallest variant that keeps the outputs (KEEP, below) is written; --variant forces one.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
import shutil
import sys
import tempfile
from pathlib import Path

os.environ["CUDA_VISIBLE_DEVICES"] = ""
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ["LLM_ROUTER_URL"] = "http://127.0.0.1:1"

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
DEFAULT_SRC = REPO / "vendor" / "whiq-agent" / "03 Shared Platform Agents" / "app" / "server" / "pqvae"
DEFAULT_OUT = REPO / "vendor" / "whiq-agent" / "pqvae-onnx"
DEFAULT_NAMES = REPO / "tests" / "fixtures" / "pqvae" / "names.json"
MINILM_ID = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
LICENSE_APACHE = REPO / "scripts" / "licenses" / "LICENSE-Apache-2.0.txt"   # the full text with its appendix (node_modules/typescript/LICENSE stops at the terms)
OPSET = 17

# A compressed MiniLM keeps the outputs when, on the measured texts: the sentence embeddings stay within cosine 0.9999 of fp32's, the
# zero-shot trade / phase pick (best prototype phrase) agrees on 99.9% of them, and the three residual codes the activity tokenizer gives
# agree on 99.9% (a code flips when an embedding sits near a boundary, and a flipped code moves that activity's sequencing score: the golden
# fixtures of tests/pqvae-parity.test.ts compare codes and levels exactly, and int8 per-token embeddings at 99.75% already break 8 of them).
KEEP = {"min_cos": 0.9999, "proto_agree": 0.999, "code_agree": 0.999}


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def log(*a):
    print("[pqvae-export]", *a, flush=True)


# ── torch modules written with plain ops so the exported graph keeps dynamic lengths ─────────────────
def enc_layer(layer, x, mask, heads):
    """nn.TransformerEncoderLayer(norm_first=True, relu) by hand: nn.MultiheadAttention bakes the traced length into reshapes."""
    a = layer.self_attn
    h = layer.norm1(x)
    q, k, v = F.linear(h, a.in_proj_weight, a.in_proj_bias).chunk(3, dim=-1)
    b, n, d = h.shape[0], h.shape[1], h.shape[2]
    dh = d // heads
    q, k, v = (t.reshape(b, n, heads, dh).transpose(1, 2) for t in (q, k, v))
    s = torch.matmul(q, k.transpose(-1, -2)) / math.sqrt(dh)
    if mask is not None:
        s = s + mask
    c = torch.matmul(torch.softmax(s, dim=-1), v).transpose(1, 2).reshape(b, n, d)
    x = x + F.linear(c, a.out_proj.weight, a.out_proj.bias)
    return x + layer.linear2(F.relu(layer.linear1(layer.norm2(x))))


class RQCodes(nn.Module):
    """RQVAE.encode_codes: encoder, then per level the nearest code of the residual (torch.cdist's matrix form), residual -= code."""

    def __init__(self, m):
        super().__init__()
        self.enc = m.encoder
        self.books = [m.quantizer.codebook(l).detach().clone() for l in range(m.quantizer.levels)]
        for l, b in enumerate(self.books):
            self.register_buffer(f"cb{l}", b)
            self.register_buffer(f"cn{l}", (b * b).sum(1))

    def forward(self, x):
        r = self.enc(x)
        out = []
        for l in range(len(self.books)):
            cb, cn = getattr(self, f"cb{l}"), getattr(self, f"cn{l}")
            d = (r * r).sum(1, keepdim=True) + cn[None, :] - 2.0 * torch.matmul(r, cb.t())
            i = d.clamp_min(0.0).argmin(dim=1)
            out.append(i)
            r = r - cb[i]
        return torch.stack(out, dim=1)


class ArNll(nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, codes, ptype):
        m = self.m
        b, n = codes.shape[0], codes.shape[1]
        x = sum(m.code_emb[l](codes[:, :, l]) for l in range(3)) + m.pos_emb(torch.arange(n))[None]
        x = torch.cat([m.bos.expand(b, 1, -1) + m.type_emb(ptype)[:, None, :], x[:, :-1]], dim=1)
        r = torch.arange(n)
        mask = torch.where(r[None, :] > r[:, None], torch.tensor(float("-inf")), torch.tensor(0.0))
        for layer in m.tf.layers:
            x = enc_layer(layer, x, mask, 4)
        ls = [F.cross_entropy(m.heads[l](x).transpose(1, 2), codes[:, :, l], reduction="none") for l in range(3)]
        return torch.stack(ls).mean(0)


class TrajHead(nn.Module):
    """TrajectoryHead for one project with no padding: mean of the encoder output over the periods."""

    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, codes, ptype):
        m = self.m
        n = codes.shape[1]
        x = sum(m.code_emb[l](codes[:, :, l]) for l in range(3)) + m.pos(torch.arange(n))[None] + m.type_emb(ptype)[:, None, :]
        for layer in m.tf.layers:
            x = enc_layer(layer, x, None, 4)
        return m.out(x.mean(1))


class MiniLM(nn.Module):
    """BertModel.forward by hand (transformers' mask helpers do not trace). mode: f32 | f16 (word-embedding table in fp16, the gathered rows cast to
    float32, so the 250,000-row table stays half size in memory too) | i8 (table int8, one scale per token)."""

    def __init__(self, bert, mode):
        super().__init__()
        self.m, self.mode = bert, mode
        if mode == "f16":
            self.register_buffer("tq", bert.embeddings.word_embeddings.weight.detach().half())
        if mode == "i8":
            w = bert.embeddings.word_embeddings.weight.detach()
            sc = (w.abs().amax(1, keepdim=True) / 127.0).clamp_min(1e-12)
            self.register_buffer("tq", torch.round(w / sc).to(torch.int8))
            self.register_buffer("sc", sc)

    def forward(self, input_ids, attention_mask):
        m, cfg = self.m, self.m.config
        b, n = input_ids.shape[0], input_ids.shape[1]
        e = m.embeddings
        we = {"i8": lambda: self.tq[input_ids].float() * self.sc[input_ids], "f16": lambda: self.tq[input_ids].float(), "f32": lambda: e.word_embeddings(input_ids)}[self.mode]()
        x = e.LayerNorm(we + e.position_embeddings(torch.arange(n)[None]) + e.token_type_embeddings(torch.zeros_like(input_ids)))
        bias = (1.0 - attention_mask.to(x.dtype))[:, None, None, :] * -1e9
        h = cfg.num_attention_heads
        dh = cfg.hidden_size // h
        for l in m.encoder.layer:
            a = l.attention
            q, k, v = (t.reshape(b, n, h, dh).transpose(1, 2) for t in (a.self.query(x), a.self.key(x), a.self.value(x)))
            s = torch.matmul(q, k.transpose(-1, -2)) / math.sqrt(dh) + bias
            c = torch.matmul(torch.softmax(s, -1), v).transpose(1, 2).reshape(b, n, h * dh)
            x = a.output.LayerNorm(a.output.dense(c) + x)
            x = l.output.LayerNorm(l.output.dense(F.gelu(l.intermediate.dense(x))) + x)
        return x


def to_onnx(module, args, path, inputs, outputs, dyn):
    module.eval()
    with torch.no_grad():
        torch.onnx.export(module, args, str(path), input_names=inputs, output_names=outputs, dynamic_axes=dyn, opset_version=OPSET, dynamo=False)


def pack_fp16(src, dst, min_elems=1024):
    """Store every float32 initializer of at least min_elems values as fp16 followed by a Cast to float32 (halves the file; the math stays fp32)."""
    import onnx
    from onnx import TensorProto, helper, numpy_helper
    m = onnx.load(str(src))
    keep, casts = [], []
    for t in m.graph.initializer:
        if t.data_type == TensorProto.FLOAT and int(np.prod(t.dims)) >= min_elems:
            keep.append(numpy_helper.from_array(numpy_helper.to_array(t).astype(np.float16), name=t.name + "__f16"))
            casts.append(helper.make_node("Cast", [t.name + "__f16"], [t.name], to=TensorProto.FLOAT, name="cast_" + t.name))
        else:
            keep.append(t)
    nodes = list(m.graph.node)
    del m.graph.initializer[:]
    m.graph.initializer.extend(keep)
    del m.graph.node[:]
    m.graph.node.extend(casts + nodes)
    onnx.save(m, str(dst))


# ── measuring a MiniLM variant ────────────────────────────────────────────────
def embed(sess, tok, texts, bs=32):
    order = np.argsort([len(t) for t in texts], kind="stable")
    out = np.zeros((len(texts), 384), np.float32)
    for i in range(0, len(texts), bs):
        idx = order[i:i + bs]
        enc = tok([texts[j] for j in idx], padding=True, truncation=True, max_length=128, return_tensors="np")
        h = sess.run(None, {"input_ids": enc["input_ids"].astype(np.int64), "attention_mask": enc["attention_mask"].astype(np.int64)})[0]
        m = enc["attention_mask"][:, :, None].astype(np.float32)
        p = (h * m).sum(1) / m.sum(1)
        out[idx] = p / np.maximum(np.linalg.norm(p, axis=1, keepdims=True), 1e-12)
    return out


def activity_features(text_vecs, seed=3):
    """420-d activity features: plausible numbers and one-hots (seeded) around the given text vectors."""
    n = len(text_vecs)
    r = np.random.default_rng(seed)
    num = np.stack([r.uniform(0.3, 1.2, n), r.uniform(0.3, 1.0, n), r.uniform(0, 1, n), r.integers(0, 5, n) / 4, r.integers(0, 5, n) / 4,
                    r.uniform(0.5, 1, n), r.uniform(0, 1, n), np.full(n, 0.6), np.full(n, 0.07)], 1).astype(np.float32)
    oh = np.zeros((n, 27), np.float32)
    for i in range(n):
        oh[i, r.integers(0, 9)] = 1
        oh[i, 9 + r.integers(0, 7)] = 1
        oh[i, 16 + r.integers(0, 11)] = 1
    return np.concatenate([num, oh, text_vecs], 1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", nargs="?", default=str(DEFAULT_SRC))
    ap.add_argument("out", nargs="?", default=str(DEFAULT_OUT))
    ap.add_argument("--minilm", default=MINILM_ID, help="sentence-transformers model id (from the cache) or a folder")
    ap.add_argument("--variant", default="auto", choices=["auto", "fp32", "fp16", "int8-emb", "int8"])
    ap.add_argument("--names", default=str(DEFAULT_NAMES), help="JSON list of activity names the MiniLM variants are measured on (scripts/pqvae-golden.py writes it)")
    ap.add_argument("--commit-file", default=None, help="the vendored agent's .whiq-agent-commit (default: found above <pqvae dir>)")
    a = ap.parse_args()
    src, out = Path(a.src).resolve(), Path(a.out).resolve()
    if not (src / "sidecar.py").exists():
        sys.exit(f"{src} is not the pqvae folder (no sidecar.py)")
    out.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(0)
    torch.set_num_threads(1)
    sys.path.insert(0, str(src))
    import onnxruntime as ort
    from whiqcodes.ar_model import CodeTransformer
    from whiqcodes.model import RQVAE
    from whiqcodes.train_traj import TrajectoryHead
    from whiqcodes.schemas import PROJECT_TYPES
    from whiqcodes.features import FEATURE_DIM
    from whiqcodes.vocab_b import FEATURE_DIM_B
    spec = importlib.util.spec_from_file_location("pqvae_sidecar", src / "sidecar.py")
    sc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sc)
    assert FEATURE_DIM == 420, FEATURE_DIM
    art = src / "artifacts"
    rs = np.random.RandomState(0)
    tmp = Path(tempfile.mkdtemp(prefix="pqvae-export-"))
    report = {}

    def load(path, model):
        model.load_state_dict(torch.load(path, weights_only=True, map_location="cpu"))
        return model.eval()

    def session(p):
        return ort.InferenceSession(str(p), providers=["CPUExecutionProvider"])

    # ── activity tokenizer (vocab A) and period tokenizer (vocab B) ───────────
    rqa = load(art / "vocab_a" / "model.pt", RQVAE(FEATURE_DIM))
    rqb = load(art / "vocab_b" / "model.pt", RQVAE(FEATURE_DIM_B, latent_dim=32, hidden=128))
    old = art / "vocab_a" / "encoder.onnx"
    if old.exists():
        x = rs.randn(64, FEATURE_DIM).astype(np.float32)
        d = float(np.abs(session(old).run(None, {"features": x})[0] - rqa.encoder(torch.from_numpy(x)).detach().numpy()).max())
        report["vocab_a_encoder_onnx_vs_model_pt_max_diff"] = d
        log(f"artifacts/vocab_a/encoder.onnx (encoder only, features -> 64-d latent) vs model.pt: max diff {d:.2e} -> {'current' if d < 1e-4 else 'STALE, not used'}; the exported graph below also does the code search")

    def export_rq(model, dim, name, fe):
        w = RQCodes(model)
        p = out / name
        to_onnx(w, (torch.zeros(2, dim),), p, ["features"], ["codes"], {"features": {0: "b"}, "codes": {0: "b"}})
        x = torch.from_numpy(fe)
        with torch.no_grad():
            ref = model.encode_codes(x).numpy()
        got = session(p).run(None, {"features": fe})[0]
        agree = float((ref == got).all(1).mean())
        report[name] = {"codes_agree_with_torch": agree, "samples": len(fe)}
        log(f"{name}: codes agree with torch on {agree * 100:.2f}% of {len(fe)} vectors")
        assert agree > 0.995, f"{name} disagrees with the torch tokenizer"

    # ── MiniLM and its variants ───────────────────────────────────────────────
    from sentence_transformers import SentenceTransformer
    st = SentenceTransformer(a.minilm, device="cpu")
    bert = st[0].auto_model.eval()
    tok = st.tokenizer
    names = []
    if Path(a.names).exists():
        names = json.loads(Path(a.names).read_text(encoding="utf-8"))
    else:
        log(f"{a.names} not found: measuring on the prototype phrases only (run scripts/pqvae-golden.py first for a real corpus)")
    protos = list(dict.fromkeys(p for t in (sc._TRADE_PROTO, sc._PHASE_PROTO) for ps in t.values() for p in ps))
    texts = list(dict.fromkeys(names + protos))
    log(f"measuring MiniLM variants on {len(texts)} texts")
    ref = st.encode(texts, batch_size=64, normalize_embeddings=True)
    fe_ref = activity_features(ref)
    with torch.no_grad():
        codes_ref = rqa.encode_codes(torch.from_numpy(fe_ref)).numpy()
    tables = []   # the resolver's two tables: label per prototype phrase, embeddings (sidecar.infer_semantic: best phrase, None below 0.35)
    for t in (sc._TRADE_PROTO, sc._PHASE_PROTO):
        labs = [lab for lab, ps in t.items() for _ in ps]
        tables.append((labs, np.stack([ref[texts.index(p)] for ps in t.values() for p in ps])))

    def picks(e):
        out = []
        for labs, pe in tables:
            s = e @ pe.T
            out.append([labs[i] if s[r, i] >= 0.35 else None for r, i in enumerate(s.argmax(1))])
        return out

    pick_ref = picks(ref)

    ids = torch.tensor([[0, 5, 6, 7, 2], [0, 8, 2, 1, 1]])
    am = torch.tensor([[1, 1, 1, 1, 1], [1, 1, 1, 0, 0]])
    dyn = {"input_ids": {0: "b", 1: "s"}, "attention_mask": {0: "b", 1: "s"}, "hidden": {0: "b", 1: "s"}}
    f32, f16, i8 = tmp / "f32.onnx", tmp / "f16.onnx", tmp / "i8.onnx"
    for mode, path in (("f32", f32), ("f16", f16), ("i8", i8)):
        to_onnx(MiniLM(bert, mode), (ids, am), path, ["input_ids", "attention_mask"], ["hidden"], dyn)
    files = {"fp32": f32}
    files["fp16"] = tmp / "f16p.onnx"
    pack_fp16(f16, files["fp16"])
    files["int8-emb"] = tmp / "i8h.onnx"
    pack_fp16(i8, files["int8-emb"])
    files["int8"] = tmp / "dyn.onnx"
    from onnxruntime.quantization import QuantType, quantize_dynamic
    quantize_dynamic(str(f32), str(files["int8"]), weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul", "Gather"])
    measured = {}
    for v, p in files.items():
        e = embed(session(p), tok, texts)
        cos = (e * ref).sum(1)
        with torch.no_grad():
            codes = rqa.encode_codes(torch.from_numpy(activity_features(e))).numpy()
        m = {"mb": round(os.path.getsize(p) / 1e6, 1), "cos_mean": float(cos.mean()), "cos_min": float(cos.min()),
             "code_agree": float((codes == codes_ref).all(1).mean()), "code_agree_level0": float((codes[:, 0] == codes_ref[:, 0]).mean()),
             "proto_agree": float(np.mean([a == b for x, y in zip(picks(e), pick_ref) for a, b in zip(x, y)])), "texts": len(texts)}
        m["keeps_outputs"] = m["cos_min"] >= KEEP["min_cos"] and m["proto_agree"] >= KEEP["proto_agree"] and m["code_agree"] >= KEEP["code_agree"]
        measured[v] = m
        log(f"minilm {v:9s} {m['mb']:6.1f} MB  cos mean {m['cos_mean']:.6f} min {m['cos_min']:.5f}  codes {m['code_agree'] * 100:.2f}% (level 0 {m['code_agree_level0'] * 100:.2f}%)  trade/phase pick {m['proto_agree'] * 100:.2f}%  keeps outputs: {m['keeps_outputs']}")
    if a.variant == "auto":
        ok = [v for v in measured if measured[v]["keeps_outputs"]]
        chosen = min(ok, key=lambda v: measured[v]["mb"]) if ok else "fp32"
    else:
        chosen = a.variant
    shutil.copyfile(files[chosen], out / "minilm.onnx")
    log(f"minilm: {chosen} ({measured[chosen]['mb']} MB) -> minilm.onnx")
    shutil.copyfile(_tokenizer_json(a.minilm), out / "tokenizer.json")

    # ── tokenizers' codes ─────────────────────────────────────────────────────
    export_rq(rqa, FEATURE_DIM, "vocab_a_codes.onnx", fe_ref[:2000])
    pr = rs.rand(2000, FEATURE_DIM_B).astype(np.float32)
    pr[:, 6:] = 0
    pr[np.arange(2000), 6 + rs.randint(0, len(PROJECT_TYPES), 2000)] = 1
    export_rq(rqb, FEATURE_DIM_B, "vocab_b_codes.onnx", pr)

    # ── AR scorer and trajectory head ─────────────────────────────────────────
    ar = load(art / "ar_scorer" / "model.pt", CodeTransformer())
    p = out / "ar_nll.onnx"
    to_onnx(ArNll(ar), (torch.randint(0, 256, (1, 17, 3)), torch.tensor([1])), p, ["codes", "ptype"], ["nll"],
            {"codes": {0: "b", 1: "l"}, "ptype": {0: "b"}, "nll": {0: "b", 1: "l"}})
    s, worst = session(p), 0.0
    for n in (1, 3, 17, 60, 256):
        c = torch.randint(0, 256, (1, n, 3))
        pt = torch.randint(0, len(PROJECT_TYPES), (1,))
        with torch.no_grad():
            r = ar.nll(c, pt).numpy()
        worst = max(worst, float(np.abs(r - s.run(None, {"codes": c.numpy(), "ptype": pt.numpy()})[0]).max()))
    report["ar_nll.onnx"] = {"max_abs_diff_vs_torch": worst}
    log(f"ar_nll.onnx: max |diff| vs torch {worst:.2e}")
    assert worst < 1e-4

    head = load(art / "trajectory" / "model.pt", TrajectoryHead())
    p = out / "trajectory_head.onnx"
    to_onnx(TrajHead(head), (torch.randint(0, 256, (1, 9, 3)), torch.tensor([1])), p, ["codes", "ptype"], ["pred"],
            {"codes": {0: "b", 1: "l"}, "ptype": {0: "b"}, "pred": {0: "b"}})
    s, worst = session(p), 0.0
    for n in (2, 3, 9, 40, 120):
        c = torch.randint(0, 256, (1, n, 3))
        pt = torch.randint(0, len(PROJECT_TYPES), (1,))
        with torch.no_grad():
            r = head(c, torch.ones(1, n, dtype=torch.bool), pt).numpy()
        worst = max(worst, float(np.abs(r - s.run(None, {"codes": c.numpy(), "ptype": pt.numpy()})[0]).max()))
    report["trajectory_head.onnx"] = {"max_abs_diff_vs_torch": worst}
    log(f"trajectory_head.onnx: max |diff| vs torch {worst:.2e}")
    assert worst < 1e-4

    # ── data the handlers read ────────────────────────────────────────────────
    import csv
    shutil.copyfile(art / "ar_scorer" / "calibration.json", out / "ar_calibration.json")
    shutil.copyfile(art / "duration_bands" / "bands.json", out / "duration_bands.json")
    shutil.copyfile(art / "growth_params.json", out / "growth_params.json")
    shutil.copyfile(src / "data" / "anchors" / "horrormap.json", out / "horrormap.json")
    ted = []
    with open(src / "data" / "raw" / "ted_winratios.csv", encoding="utf-8") as f:   # whiqcodes.reference_class.load_ted
        for r in csv.DictReader(f):
            try:
                ratio = float(r["winning_ratio"])
                if 0.3 < ratio < 3.0:
                    ted.append({"country": r["country"] or "?", "cpv_div": r["cpv_div"], "estimated": float(r["estimated"]), "ratio": ratio})
            except (ValueError, KeyError):
                continue
    (out / "ted_winratios.json").write_text(json.dumps(ted, separators=(",", ":")), encoding="utf-8", newline="\n")

    # ── manifest ──────────────────────────────────────────────────────────────
    cf = Path(a.commit_file) if a.commit_file else None
    if cf is None:
        for d in src.parents:
            if (d / ".whiq-agent-commit").exists():
                cf = d / ".whiq-agent-commit"
                break
    commit = cf.read_text(encoding="utf-8").strip() if cf and cf.exists() else None
    revision = _hf_revision(a.minilm)
    shutil.copyfile(LICENSE_APACHE, out / "LICENSE-MiniLM.txt")
    (out / "NOTICE.txt").write_text(_notice(a.minilm, revision, chosen, commit), encoding="utf-8", newline="\n")
    import onnx
    import onnxruntime
    import sentence_transformers
    man = {
        "format": 1,
        "calibration": sc.CALIBRATION,
        "sourceCommit": commit,
        "minilm": {"model": a.minilm, "revision": revision, "license": "Apache-2.0", "variant": chosen, "variants": measured, "keep": KEEP, "maxSeqLength": 128},
        "sources": {str(p.relative_to(src)).replace("\\", "/"): sha256(p) for p in (art / "vocab_a" / "model.pt", art / "vocab_b" / "model.pt", art / "ar_scorer" / "model.pt", art / "trajectory" / "model.pt")},
        "checks": report,
        "exporter": {"torch": torch.__version__, "onnx": onnx.__version__, "onnxruntime": onnxruntime.__version__, "sentence_transformers": sentence_transformers.__version__, "opset": OPSET},
        "files": {},
    }
    for f in sorted(out.iterdir()):
        if f.is_file() and f.name != "manifest.json":
            man["files"][f.name] = {"bytes": f.stat().st_size, "sha256": sha256(f)}
    (out / "manifest.json").write_text(json.dumps(man, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    shutil.rmtree(tmp, ignore_errors=True)
    total = sum(v["bytes"] for v in man["files"].values())
    log(f"done: {len(man['files'])} files, {total / 1e6:.1f} MB -> {out}")


def _hf_revision(model):
    """The commit of the model in the Hugging Face cache (the snapshot folder's name); a local folder has none."""
    if Path(model).is_dir():
        return "local folder " + Path(model).name
    snap = _tokenizer_json(model).resolve().parent
    return snap.name if snap.parent.name == "snapshots" else "unknown"


def _notice(model, revision, variant, commit):
    return f"""PQ-VAE models for the desktop app's embedded platform agent. Written by scripts/pqvae-export.py.

minilm.onnx, tokenizer.json
  Converted from the model {model}
  (https://huggingface.co/{model}), revision {revision}.
  Licence: Apache License 2.0, the full text is LICENSE-MiniLM.txt in this folder.
  Changes: the transformer is exported to ONNX (hidden states; the mean pooling and the L2 normalisation are done by the caller);
  weights stored as {variant}. The tokenizer is the model's own tokenizer.json.

vocab_a_codes.onnx, vocab_b_codes.onnx, ar_nll.onnx, trajectory_head.onnx, ar_calibration.json, duration_bands.json, growth_params.json
  Exported from the platform's trained PQ-VAE artifacts (pqvae/artifacts/) at the platform commit pinned in
  vendor/whiq-agent/.whiq-agent-commit: {commit}.

horrormap.json
  A copy of the platform's pqvae/data/anchors/horrormap.json at that pinned commit.

ted_winratios.json
  Converted from the platform's pqvae/data/raw/ted_winratios.csv at that pinned commit (rows with a winning ratio between 0.3 and 3.0).

manifest.json lists every file here with its size and sha256.
"""


def _tokenizer_json(model):
    """tokenizer.json of the model: its folder, else the Hugging Face cache."""
    if Path(model).is_dir():
        return Path(model) / "tokenizer.json"
    from huggingface_hub import hf_hub_download
    return Path(hf_hub_download(model, "tokenizer.json"))


if __name__ == "__main__":
    main()
