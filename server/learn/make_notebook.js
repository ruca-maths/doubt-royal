// doubt_royale_colab.ipynb を生成する (ノートブックを手で編集するとセルの JSON が壊れやすいので、ここを直して再生成する)
//   node learn/make_notebook.js
const fs = require('fs');
const path = require('path');

const md = text => ({ cell_type: 'markdown', metadata: {}, source: lines(text) });
const code = text => ({ cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: lines(text) });
function lines(text) {
  const all = text.replace(/^\n/, '').replace(/\n$/, '').split('\n');
  return all.map((line, i) => (i < all.length - 1 ? line + '\n' : line));
}

const cells = [
  md(`
# DOUBT ROYALE — 嘘判定 (ダウト) モデルの学習

このノートブックは、CPU が「相手の宣言が嘘かどうか」を見積もるモデルを自己対戦で学習します。
設計の全体像は \`server/learn/README.md\` を参照してください。

流れ (1 世代 = 下の 3 ステップ):
1. **データ生成** — リポジトリのゲームエンジン (TypeScript) で自己対戦し、ダウトできる場面ごとに
   「観察者から見た特徴量」と「本当に嘘だったか」を記録する (Node.js を CPU で並列実行)
2. **学習** — PyTorch で多層パーセプトロンを学習し、\`doubt-model.json\` を書き出す (GPU があれば使う)
3. **評価** — 学習したモデルを CPU に持たせて、搾取型ボット (8切り連打など) と対戦させる

2 世代目以降は、前の世代のモデルを使う CPU 同士で対戦したデータも混ぜて学習し直します
(相手が強くなると嘘のつき方も変わるため)。

**ランタイム**: GPU は必須ではありません (CPU でも数分で学習できます)。
データ生成は CPU のコア数ぶん並列に走るので、ハイメモリ / コア数の多いランタイムほど速くなります。
`),
  md(`## 0. 設定`),
  code(`
# --- ここを書き換える ---
REPO_URL = "https://github.com/ruca-maths/doubt-royal.git"
BRANCH = "main"
GENERATIONS = 3            # 何世代くり返すか
GAMES_PER_WORKER = 6000    # 1 プロセスあたりの対局数 (1 対局 ≈ 55 行)
EVAL_GAMES = 2000          # 評価の対局数
SAVE_TO_DRIVE = False      # True にすると Google ドライブにも保存する
DRIVE_DIR = "/content/drive/MyDrive/doubt-royal-models"

# リポジトリが非公開なら、Colab の「シークレット」に GITHUB_TOKEN を登録しておく
`),
  md(`## 1. 準備 (Node.js とリポジトリ)`),
  code(`
import os, subprocess, shutil, json, glob, time

def sh(cmd, cwd=None, check=True):
    print(f"$ {cmd}")
    r = subprocess.run(cmd, shell=True, cwd=cwd, text=True, capture_output=True)
    if r.stdout: print(r.stdout[-4000:])
    if r.returncode != 0:
        print(r.stderr[-4000:])
        if check: raise RuntimeError(f"failed: {cmd}")
    return r

# Node.js 20 以上を用意する
node = subprocess.run("node -v", shell=True, text=True, capture_output=True).stdout.strip()
if not node.startswith(("v20", "v21", "v22", "v23", "v24")):
    sh("curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null")
    sh("apt-get install -y nodejs > /dev/null")
sh("node -v")

url = REPO_URL
try:
    from google.colab import userdata
    token = userdata.get("GITHUB_TOKEN")
    if token:
        url = REPO_URL.replace("https://", f"https://{token}@")
except Exception:
    pass

if not os.path.exists("/content/doubt-royal"):
    sh(f"git clone --depth 1 --branch {BRANCH} {url} /content/doubt-royal")
SERVER = "/content/doubt-royal/server"
LEARN = f"{SERVER}/learn"
sh(f"git fetch --depth 1 origin {BRANCH} && git checkout -q FETCH_HEAD", cwd="/content/doubt-royal")  # 再実行時も最新にする
if not os.path.exists(f"{SERVER}/sim/tsconfig.json"):
    raise RuntimeError(f"{BRANCH} ブランチに学習用のファイル (server/sim, server/learn) がありません。"
                       "ローカルの変更を GitHub にプッシュしたか、BRANCH の指定を確認してください。")
sh("npm ci --no-audit --no-fund", cwd=SERVER)
sh("npx tsc -p sim/tsconfig.json", cwd=SERVER)   # シミュレータを JavaScript にコンパイル (dist-sim/)
print("CPU cores:", os.cpu_count())
`),
  code(`
if SAVE_TO_DRIVE:
    from google.colab import drive
    drive.mount("/content/drive")
    os.makedirs(DRIVE_DIR, exist_ok=True)
`),
  md(`
## 2. 道具

- \`generate(gen, league)\` — データ生成を CPU コア数ぶん並列に走らせる
- \`train(gen)\` — それまでの世代のデータで学習する
- \`evaluate()\` — 搾取型ボットとの対戦で強さを確かめる
`),
  code(`
WORKERS = max(1, os.cpu_count() or 1)
MODEL_PATH = f"{SERVER}/models/doubt-model.json"   # ここに置いたモデルを CPU (brain) が使う

def generate(gen, league="default", games=GAMES_PER_WORKER, use_model=True):
    out = f"{LEARN}/data/gen{gen}"
    procs = []
    for w in range(WORKERS):
        args = ["node", "dist-sim/sim/gen-doubt-data.js",
                "--games", str(games), "--out", f"{out}/{league}-w{w}",
                "--league", league, "--game-offset", str((gen * 100 + w) * 1_000_000)]
        if not use_model:
            args.append("--no-model")
        procs.append(subprocess.Popen(args, cwd=SERVER, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True))
    t0 = time.time()
    for p in procs:
        out_text, _ = p.communicate()
        print(out_text.strip().splitlines()[-1] if out_text.strip() else "(no output)")
    print(f"generation {gen} ({league}): {time.time() - t0:.0f}s")

def train(gen, extra_args=""):
    # 直近 2 世代ぶんのデータで学習する (古すぎる相手の癖に引きずられないように)
    dirs = " ".join(f"{LEARN}/data/gen{g}" for g in range(max(0, gen - 1), gen + 1))
    out = f"{LEARN}/runs/gen{gen}/doubt-model.json"
    r = subprocess.run(f"python train_doubt.py --data {dirs} --out {out} --name doubt-gen{gen} {extra_args}",
                       shell=True, cwd=LEARN, text=True)
    if r.returncode != 0:
        raise RuntimeError("training failed")
    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    shutil.copy(out, MODEL_PATH)
    if SAVE_TO_DRIVE:
        shutil.copy(out, f"{DRIVE_DIR}/doubt-model-gen{gen}.json")
    return out

def arena(seats, games=EVAL_GAMES):
    r = sh(f"node dist-sim/sim/arena.js --games {games} --seats {seats}", cwd=SERVER, check=False)
    return r.stdout

def evaluate():
    # brain = 学習モデルあり / brain:heuristic = 手作りの判定 (比較用)
    for seats in ["brain,brain,brain,pro8", "brain:heuristic,brain:heuristic,brain:heuristic,pro8",
                  "brain,pro8", "brain,brain,brain,pro10", "brain,brain,brain,liar",
                  "brain,brain:heuristic,brain,brain:heuristic"]:
        arena(seats)
`),
  md(`
## 3. 第 0 世代: 学習済みモデルなしでデータを作る

まだモデルが無いので、CPU は手作りの判定で打ちます。卓には搾取型ボット (8 切り連打など) も混ぜます。
`),
  code(`
if os.path.exists(MODEL_PATH):
    os.remove(MODEL_PATH)   # 第 0 世代は手作りの判定だけで打たせる
generate(0, "default", use_model=False)
generate(0, "exploit", games=GAMES_PER_WORKER // 2, use_model=False)
train(0)
evaluate()
`),
  md(`
## 4. 第 1 世代以降: 学習済みモデルを使う CPU 同士でデータを作り直す

モデルを持った CPU は嘘を見抜くようになるので、相手 (brain) の嘘のつき方も変わります。
その新しい分布でデータを取り直して学習し直す、を繰り返します。
`),
  code(`
for gen in range(1, GENERATIONS):
    generate(gen, "default")
    generate(gen, "exploit", games=GAMES_PER_WORKER // 2)
    generate(gen, "self", games=GAMES_PER_WORKER // 2)
    train(gen)
    evaluate()
`),
  md(`
## 5. モデルを持ち帰る

\`doubt-model.json\` をダウンロードして、リポジトリの \`server/models/doubt-model.json\` に置いてコミットしてください。
サーバーは起動時にこのファイルを読み込み、CPU のダウト判断に使います (無ければ従来の判定のまま)。
`),
  code(`
from google.colab import files
report = sorted(glob.glob(f"{LEARN}/runs/gen*/doubt-model-report.txt"))[-1]
print(open(report, encoding="utf-8").read())
files.download(MODEL_PATH)
`),
];

const notebook = {
  cells,
  metadata: {
    colab: { provenance: [] },
    kernelspec: { display_name: 'Python 3', name: 'python3' },
    language_info: { name: 'python' },
  },
  nbformat: 4,
  nbformat_minor: 0,
};

const out = path.join(__dirname, 'doubt_royale_colab.ipynb');
fs.writeFileSync(out, JSON.stringify(notebook, null, 1) + '\n');
console.log(`wrote ${out}`);
