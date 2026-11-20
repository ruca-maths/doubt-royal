"""
学習済みモデルの学習 (2 種類)。

    python train_doubt.py --kind doubt --data data/gen0 --out runs/gen0/doubt-model.json
    python train_doubt.py --kind risk  --data data/gen0 --out runs/gen0/risk-model.json

  doubt : 相手の宣言が嘘である確率 (ダウトするかの判断に使う)
  risk  : 自分の宣言が誰かにダウトされる確率 (どう出すか・嘘をつくかの判断に使う)

入力: server/sim/gen-doubt-data.ts が書き出した .npy (X: 特徴量, y: 嘘なら 1, aux: 分析用の補助列)
出力: server/src/game/brain/learnedDoubt.ts が読む JSON (多層パーセプトロンの重み + 入力の正規化値)

やること
  1. 対局単位で学習用 / 検証用に分ける (同じ宣言を複数人が見た行が両方に入らないように)
  2. 多層パーセプトロンを二値交差エントロピーで学習し、検証損失が最小の重みを残す
  3. 検証データで温度スケーリングをして確率を較正し、最終層に畳み込む
  4. 手作りモデル (aux の heuristic_lie) と同じ検証データで比べたレポートを出す
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os
import time
from datetime import datetime, timezone

import numpy as np

try:  # Colab には PyTorch が入っている。無い環境では numpy 版の学習 (遅い) に切り替える
    import torch
    from torch import nn
except ImportError:  # pragma: no cover
    torch = None


# ----------------------------------------------------------------------------- データ

def load_dataset(dirs: list[str], max_rows: int | None, kind: str = "doubt"):
    xs, ys, auxs, groups, claimant_names = [], [], [], [], []
    feature_names = None
    aux_names = None
    version = None
    def dir_kind(shard_dir):
        with open(os.path.join(shard_dir, "meta.json"), encoding="utf-8") as f:
            return json.load(f).get("kind", "doubt")  # 最初の版のデータは kind を持たない (= doubt)

    candidates = {os.path.dirname(p) for d in dirs for p in glob.glob(os.path.join(d, "**", "shard*_X.npy"), recursive=True)}
    shard_dirs = sorted(d for d in candidates if dir_kind(d) == kind)
    if not shard_dirs:
        raise SystemExit(f"no {kind} shards found under {dirs}")

    for dir_index, shard_dir in enumerate(shard_dirs):
        with open(os.path.join(shard_dir, "meta.json"), encoding="utf-8") as f:
            meta = json.load(f)
        if feature_names is None:
            feature_names, aux_names, version = meta["featureNames"], meta["auxNames"], meta["featureVersion"]
        elif meta["featureNames"] != feature_names or meta["featureVersion"] != version:
            raise SystemExit(f"feature schema differs in {shard_dir} (regenerate the data)")
        policies = meta["policies"]
        for x_path in sorted(glob.glob(os.path.join(shard_dir, "shard*_X.npy"))):
            prefix = x_path[: -len("_X.npy")]
            x = np.load(x_path)
            y = np.load(prefix + "_y.npy")
            aux = np.load(prefix + "_aux.npy")
            xs.append(x)
            ys.append(y)
            auxs.append(aux)
            # 対局番号はワーカーごとに重なりうるのでディレクトリ番号と組にする
            groups.append(aux[:, aux_names.index("game")].astype(np.int64) * 1000 + dir_index)
            claimant_ids = aux[:, aux_names.index("claimant_policy")].astype(np.int64)
            claimant_names.append(np.array([policies[i] if 0 <= i < len(policies) else "?" for i in claimant_ids]))

    x = np.concatenate(xs).astype(np.float32)
    y = np.concatenate(ys).astype(np.float32)
    aux = np.concatenate(auxs).astype(np.float32)
    group = np.concatenate(groups)
    claimant = np.concatenate(claimant_names)
    if max_rows and len(y) > max_rows:
        keep = np.random.default_rng(0).choice(len(y), size=max_rows, replace=False)
        x, y, aux, group, claimant = x[keep], y[keep], aux[keep], group[keep], claimant[keep]
    return x, y, aux, group, claimant, feature_names, aux_names, version, shard_dirs


def split_by_game(group: np.ndarray, val_fraction: float):
    # 対局番号のハッシュで決める (データを足しても同じ対局は同じ側に入る)
    # (乗算ハッシュの上位ビットを使う。下位の桁は対局番号の並びに引きずられて偏るため)
    x = (group.astype(np.uint64) * np.uint64(2654435761)) & np.uint64(0xFFFFFFFF)
    h = (x * np.uint64(1000)) >> np.uint64(32)
    val = h < int(val_fraction * 1000)
    if val.all() or not val.any():
        raise SystemExit("対局数が少なすぎて学習用と検証用に分けられません (--games を増やしてください)")
    return ~val, val


# ----------------------------------------------------------------------------- モデル

class _Missing:
    Module = object


if torch is None:
    nn = _Missing()  # type: ignore


class DoubtMLP(nn.Module):
    def __init__(self, dim: int, hidden: list[int], dropout: float):
        super().__init__()
        layers: list[nn.Module] = []
        prev = dim
        for h in hidden:
            layers += [nn.Linear(prev, h), nn.ReLU(), nn.Dropout(dropout)]
            prev = h
        layers.append(nn.Linear(prev, 1))
        self.net = nn.Sequential(*layers)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x).squeeze(-1)

    def linears(self) -> list[nn.Linear]:
        return [m for m in self.net if isinstance(m, nn.Linear)]


def predict_logits(model: nn.Module, x: torch.Tensor, batch: int = 65536) -> torch.Tensor:
    model.eval()
    out = []
    with torch.no_grad():
        for i in range(0, len(x), batch):
            out.append(model(x[i : i + batch]))
    return torch.cat(out)


def fit_temperature(logits: torch.Tensor, y: torch.Tensor) -> float:
    log_t = torch.zeros(1, requires_grad=True, device=logits.device)
    opt = torch.optim.LBFGS([log_t], lr=0.1, max_iter=100)
    loss_fn = nn.BCEWithLogitsLoss()

    def closure():
        opt.zero_grad()
        loss = loss_fn(logits / log_t.exp(), y)
        loss.backward()
        return loss

    opt.step(closure)
    return float(log_t.exp().item())


# ----------------------------------------------------------------------------- numpy 版 (PyTorch が無い環境用)

class NumpyMLP:
    """PyTorch が無い環境用の最小限の多層パーセプトロン (ReLU, Adam)。export_json と同じ形で書き出せる。"""

    def __init__(self, dim: int, hidden: list[int], seed: int):
        rng = np.random.default_rng(seed)
        sizes = [dim, *hidden, 1]
        self.w = [rng.normal(0, math.sqrt(2 / a), size=(b, a)).astype(np.float32) for a, b in zip(sizes, sizes[1:])]
        self.b = [np.zeros(b, dtype=np.float32) for b in sizes[1:]]
        self.m = [np.zeros_like(p) for p in self.w + self.b]
        self.v = [np.zeros_like(p) for p in self.w + self.b]
        self.t = 0

    def logits(self, x: np.ndarray) -> np.ndarray:
        h = x
        for i, (w, b) in enumerate(zip(self.w, self.b)):
            h = h @ w.T + b
            if i < len(self.w) - 1:
                h = np.maximum(h, 0)
        return h[:, 0]

    def step(self, x: np.ndarray, y: np.ndarray, lr: float, weight_decay: float) -> float:
        acts = [x]
        h = x
        for i, (w, b) in enumerate(zip(self.w, self.b)):
            h = h @ w.T + b
            if i < len(self.w) - 1:
                h = np.maximum(h, 0)
            acts.append(h)
        z = acts[-1][:, 0]
        p = 1 / (1 + np.exp(-np.clip(z, -30, 30)))
        loss = float(np.mean(np.logaddexp(0, z) - y * z))
        grad = ((p - y) / len(y))[:, None].astype(np.float32)
        gw, gb = [None] * len(self.w), [None] * len(self.b)
        for i in range(len(self.w) - 1, -1, -1):
            gw[i] = grad.T @ acts[i]
            gb[i] = grad.sum(axis=0)
            if i > 0:
                grad = (grad @ self.w[i]) * (acts[i] > 0)
        self.t += 1
        params = self.w + self.b
        grads = gw + gb
        for k, (param, g) in enumerate(zip(params, grads)):
            if k < len(self.w):
                g = g + weight_decay * param
            self.m[k] = 0.9 * self.m[k] + 0.1 * g
            self.v[k] = 0.999 * self.v[k] + 0.001 * g * g
            mh = self.m[k] / (1 - 0.9 ** self.t)
            vh = self.v[k] / (1 - 0.999 ** self.t)
            param -= lr * mh / (np.sqrt(vh) + 1e-8)
        return loss


def train_numpy(xt, yt, xv, yv, args):
    model = NumpyMLP(xt.shape[1], args.hidden, args.seed)
    rng = np.random.default_rng(args.seed)
    best_loss, best = float("inf"), None
    for epoch in range(1, args.epochs + 1):
        lr = args.lr * 0.5 * (1 + math.cos(math.pi * (epoch - 1) / args.epochs))
        perm = rng.permutation(len(yt))
        total = 0.0
        for i in range(0, len(yt), args.batch):
            idx = perm[i : i + args.batch]
            total += model.step(xt[idx], yt[idx], lr, args.weight_decay) * len(idx)
        z = model.logits(xv)
        val_loss = float(np.mean(np.logaddexp(0, z) - yv * z))
        marker = ""
        if val_loss < best_loss:
            best_loss, best, marker = val_loss, ([w.copy() for w in model.w], [b.copy() for b in model.b]), " *"
        print(f"epoch {epoch:2d}: train {total / len(yt):.4f}  val {val_loss:.4f}{marker}")
    model.w, model.b = best
    z = model.logits(xv)
    # 温度スケーリング (1 変数なので格子探索で十分)
    temps = np.exp(np.linspace(-1, 1, 81))
    losses = [float(np.mean(np.logaddexp(0, z / t) - yv * z / t)) for t in temps]
    temperature = float(temps[int(np.argmin(losses))])
    layers = list(zip(model.w, model.b))
    return layers, temperature, 1 / (1 + np.exp(-np.clip(z / temperature, -30, 30)))


# ----------------------------------------------------------------------------- 評価

def logloss(p: np.ndarray, y: np.ndarray) -> float:
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def auc(p: np.ndarray, y: np.ndarray) -> float:
    order = np.argsort(p)
    ranks = np.empty(len(p))
    ranks[order] = np.arange(1, len(p) + 1)
    pos = y == 1
    n_pos, n_neg = pos.sum(), (~pos).sum()
    if n_pos == 0 or n_neg == 0:
        return float("nan")
    return float((ranks[pos].sum() - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg))


def decision_edge(p: np.ndarray, y: np.ndarray, tau: np.ndarray) -> float:
    """p > tau のときダウトした場合の損得 (当たり: 1 - tau, 外れ: -tau) の平均。大きいほど良い"""
    doubt = p > tau
    return float(np.mean(np.where(doubt, y - tau, 0.0)))


def report_risk(p_model, p_heur, y, actor, honest):
    lines = []
    lines.append(f"{'':16}{'logloss':>9}{'AUC':>8}{'brier':>8}")
    for name, p in (("model", p_model), ("heuristic", p_heur)):
        lines.append(f"{name:16}{logloss(p, y):9.4f}{auc(p, y):8.4f}{float(np.mean((p - y) ** 2)):8.4f}")
    lines.append("")
    lines.append("較正 (予測したダウトされる確率の帯 → 実際にダウトされた割合):")
    bins = np.linspace(0, 1, 11)
    for name, p in (("model", p_model), ("heuristic", p_heur)):
        idx = np.clip(np.digitize(p, bins) - 1, 0, 9)
        parts = []
        for b in range(10):
            m = idx == b
            if m.sum() >= 50:
                parts.append(f"{p[m].mean():.2f}→{y[m].mean():.2f}")
        lines.append(f"  {name:10} " + " ".join(parts))
    lines.append("")
    lines.append("宣言した打ち手ごと (実際にダウトされた割合 / 予測の平均。正直な宣言と嘘の宣言に分けて):")
    lines.append(f"  {'actor':16}{'n':>8}{'honest:real':>13}{'model':>8}{'heur':>8}{'lie:real':>11}{'model':>8}{'heur':>8}")
    for name in sorted(set(actor.tolist())):
        m = actor == name
        h = m & (honest == 1)
        l = m & (honest == 0)
        def mean(a, mask):
            return float(a[mask].mean()) if mask.sum() else float("nan")
        lines.append(
            f"  {name:16}{m.sum():8d}{mean(y, h):13.3f}{mean(p_model, h):8.3f}{mean(p_heur, h):8.3f}"
            f"{mean(y, l):11.3f}{mean(p_model, l):8.3f}{mean(p_heur, l):8.3f}"
        )
    return "\n".join(lines)


def report(p_model, p_heur, y, tau, claimant, possibility):
    lines = []
    lines.append(f"{'':16}{'logloss':>9}{'AUC':>8}{'edge':>9}")
    for name, p in (("model", p_model), ("heuristic", p_heur)):
        lines.append(f"{name:16}{logloss(p, y):9.4f}{auc(p, y):8.4f}{1000 * decision_edge(p, y, tau):9.2f}")
    lines.append("  (edge = ダウトの損得の平均 ×1000。手作りモデルより大きければ改善)")

    lines.append("")
    lines.append("較正 (予測した嘘確率の帯 → 実際の嘘の割合):")
    bins = np.linspace(0, 1, 11)
    idx = np.clip(np.digitize(p_model, bins) - 1, 0, 9)
    for b in range(10):
        m = idx == b
        if m.sum() >= 50:
            lines.append(f"  {bins[b]:.1f}-{bins[b + 1]:.1f}: 予測 {p_model[m].mean():.3f} / 実測 {y[m].mean():.3f}  (n={m.sum()})")

    lines.append("")
    lines.append("宣言した打ち手ごと (嘘を見抜けた割合 = 嘘の行のうち p > tau / 本当なのに疑った割合):")
    lines.append(f"  {'claimant':12}{'n':>9}{'lie%':>7}{'catch(model)':>14}{'catch(heur)':>13}{'false(model)':>14}{'false(heur)':>13}")
    for name in sorted(set(claimant.tolist())):
        m = claimant == name
        lie = m & (y == 1) & (possibility > 0)
        truth = m & (y == 0)
        def rate(p, mask):
            return 100 * float((p[mask] > tau[mask]).mean()) if mask.sum() else float("nan")
        lines.append(
            f"  {name:12}{m.sum():9d}{100 * y[m].mean():7.1f}"
            f"{rate(p_model, lie):14.1f}{rate(p_heur, lie):13.1f}{rate(p_model, truth):14.1f}{rate(p_heur, truth):13.1f}"
        )
    return "\n".join(lines)


# ----------------------------------------------------------------------------- 書き出し

def export_json(path, weights, mean, std, temperature, feature_names, version, meta, kind="doubt"):
    """weights: [(W[出力×入力], b), ...]"""
    layers = []
    for i, (w, b) in enumerate(weights):
        w = np.asarray(w, dtype=np.float64)
        b = np.asarray(b, dtype=np.float64)
        if i == len(weights) - 1:  # 温度スケーリングを最終層に畳み込む
            w, b = w / temperature, b / temperature
        layers.append({"w": np.round(w, 6).tolist(), "b": np.round(b, 6).tolist()})
    data = {
        "format": "doubt-mlp",
        "kind": kind,
        "featureVersion": version,
        "featureNames": feature_names,
        "mean": np.round(mean.astype(np.float64), 6).tolist(),
        "std": np.round(std.astype(np.float64), 6).tolist(),
        "layers": layers,
        "meta": meta,
    }
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))


# ----------------------------------------------------------------------------- 本体

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--kind", choices=["doubt", "risk"], default="doubt", help="学習するモデルの種類")
    ap.add_argument("--data", nargs="+", required=True, help="学習データのディレクトリ (複数可。下の階層も探す)")
    ap.add_argument("--out", required=True, help="書き出すモデル JSON")
    ap.add_argument("--hidden", nargs="+", type=int, default=[256, 128])
    ap.add_argument("--dropout", type=float, default=0.1)
    ap.add_argument("--epochs", type=int, default=12)
    ap.add_argument("--batch", type=int, default=4096)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--weight-decay", type=float, default=1e-4)
    ap.add_argument("--val", type=float, default=0.1, help="検証に回す対局の割合")
    ap.add_argument("--max-rows", type=int, default=None)
    ap.add_argument("--name", default=None, help="モデルの名前 (meta.name)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--numpy", action="store_true", help="PyTorch があっても numpy 版で学習する")
    args = ap.parse_args()

    np.random.seed(args.seed)
    use_torch = torch is not None and not args.numpy
    if use_torch:
        torch.manual_seed(args.seed)
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    else:
        device = "numpy"

    t0 = time.time()
    x, y, aux, group, claimant, feature_names, aux_names, version, shard_dirs = load_dataset(args.data, args.max_rows, args.kind)
    print(f"loaded {len(y):,} rows x {x.shape[1]} features from {len(shard_dirs)} dir(s) in {time.time() - t0:.1f}s; lie rate {y.mean():.3f}; device {device}")

    train, val = split_by_game(group, args.val)
    mean = x[train].mean(axis=0)
    std = x[train].std(axis=0)
    std = np.where(std < 1e-3, 1.0, std)

    if use_torch:
        weights, temperature, p_model = train_torch(x, y, train, val, mean, std, device, args)
    else:
        weights, temperature, p_model = train_numpy(
            ((x[train] - mean) / std).astype(np.float32), y[train],
            ((x[val] - mean) / std).astype(np.float32), y[val], args)
    print(f"temperature {temperature:.3f}")

    col = {name: i for i, name in enumerate(aux_names)}
    aux_v = aux[val]
    if args.kind == "risk":
        text = report_risk(p_model, aux_v[:, col["heuristic"]], y[val], claimant[val], aux_v[:, col["honest"]])
    else:
        text = report(
            p_model,
            aux_v[:, col["heuristic_lie"]],
            y[val],
            aux_v[:, col["threshold"]],
            claimant[val],
            aux_v[:, col["possibility"]],
        )
    print()
    print(text)

    name = args.name or os.path.splitext(os.path.basename(args.out))[0]
    meta = {
        "name": name,
        "kind": args.kind,
        "trainedAt": datetime.now(timezone.utc).isoformat(),
        "rows": int(len(y)),
        "valRows": int(val.sum()),
        "valLogloss": logloss(p_model, y[val]),
        "valAuc": auc(p_model, y[val]),
        "temperature": temperature,
        "hidden": args.hidden,
        "data": [os.path.relpath(d) for d in shard_dirs],
    }
    export_json(args.out, weights, mean, std, temperature, feature_names, version, meta, args.kind)
    with open(os.path.splitext(args.out)[0] + "-report.txt", "w", encoding="utf-8") as f:
        f.write(json.dumps(meta, ensure_ascii=False, indent=2) + "\n\n" + text + "\n")
    print(f"\nwrote {args.out}")


def train_torch(x, y, train, val, mean, std, device, args):
    def to_tensor(a):
        return torch.from_numpy(a).to(device)

    xt = to_tensor(((x[train] - mean) / std).astype(np.float32))
    yt = to_tensor(y[train])
    xv = to_tensor(((x[val] - mean) / std).astype(np.float32))
    yv = to_tensor(y[val])

    model = DoubtMLP(x.shape[1], args.hidden, args.dropout).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    steps_per_epoch = math.ceil(len(yt) / args.batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=args.epochs * steps_per_epoch)
    loss_fn = nn.BCEWithLogitsLoss()

    best_loss, best_state = float("inf"), None
    for epoch in range(1, args.epochs + 1):
        model.train()
        perm = torch.randperm(len(yt), device=device)
        total = 0.0
        for i in range(0, len(yt), args.batch):
            idx = perm[i : i + args.batch]
            loss = loss_fn(model(xt[idx]), yt[idx])
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            sched.step()
            total += loss.item() * len(idx)
        val_loss = float(loss_fn(predict_logits(model, xv), yv))
        marker = ""
        if val_loss < best_loss:
            best_loss, best_state, marker = val_loss, {k: v.detach().clone() for k, v in model.state_dict().items()}, " *"
        print(f"epoch {epoch:2d}: train {total / len(yt):.4f}  val {val_loss:.4f}{marker}")

    model.load_state_dict(best_state)
    logits_v = predict_logits(model, xv)
    temperature = fit_temperature(logits_v, yv)
    p_model = torch.sigmoid(logits_v / temperature).cpu().numpy()
    weights = [(lin.weight.detach().cpu().numpy(), lin.bias.detach().cpu().numpy()) for lin in model.linears()]
    return weights, temperature, p_model


if __name__ == "__main__":
    main()
