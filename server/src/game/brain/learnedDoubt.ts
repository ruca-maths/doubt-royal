/**
 * 学習済みモデル (多層パーセプトロン) を読み込んで推論する。
 *
 *  - 嘘判定モデル (kind: "doubt")  : 相手の宣言が嘘である確率          → models/doubt-model.json
 *  - ダウト予測モデル (kind: "risk") : 自分の宣言が誰かにダウトされる確率 → models/risk-model.json
 *
 * モデルは server/learn/train_doubt.py が書き出す JSON。依存ライブラリなしの
 * 純粋な TypeScript で計算するので、サーバーでもシミュレータでも同期的に使える。
 *
 * 読み込み先 (最初に見つかったもの):
 *   1. 環境変数 DOUBT_ROYALE_DOUBT_MODEL / DOUBT_ROYALE_RISK_MODEL (ファイルパス。"off" で無効化)
 *   2. server/models/<doubt|risk>-model.json
 * 見つからない / 特徴量の版が合わない場合は null になり、Brain は手作りの見積もりを使う。
 */
import * as fs from 'fs';
import * as path from 'path';
import { DOUBT_FEATURE_DIM, DOUBT_FEATURE_VERSION } from './doubtFeatures';
import { RISK_FEATURE_DIM, RISK_FEATURE_VERSION } from './riskFeatures';

export type ModelKind = 'doubt' | 'risk';

interface LayerFile {
  /** 出力 × 入力 */
  w: number[][];
  b: number[];
}

export interface MlpModelFile {
  format: 'doubt-mlp';
  /** 省略時は "doubt" (最初の版のファイル) */
  kind?: ModelKind;
  featureVersion: number;
  featureNames: string[];
  mean: number[];
  std: number[];
  layers: LayerFile[];
  meta?: Record<string, unknown>;
}

/** 互換用の別名 */
export type DoubtModelFile = MlpModelFile;

interface Layer {
  w: Float32Array;
  b: Float32Array;
  inputs: number;
  outputs: number;
}

const SPECS: Record<ModelKind, { version: number; dim: number; env: string; file: string }> = {
  doubt: { version: DOUBT_FEATURE_VERSION, dim: DOUBT_FEATURE_DIM, env: 'DOUBT_ROYALE_DOUBT_MODEL', file: 'doubt-model.json' },
  risk: { version: RISK_FEATURE_VERSION, dim: RISK_FEATURE_DIM, env: 'DOUBT_ROYALE_RISK_MODEL', file: 'risk-model.json' },
};

export class MlpModel {
  private readonly layers: Layer[];
  private readonly mean: Float32Array;
  private readonly invStd: Float32Array;
  readonly kind: ModelKind;
  readonly meta: Record<string, unknown>;

  constructor(file: MlpModelFile, expectedKind: ModelKind = file.kind ?? 'doubt') {
    if (file.format !== 'doubt-mlp') throw new Error(`unknown model format: ${file.format}`);
    const kind = file.kind ?? 'doubt';
    if (kind !== expectedKind) throw new Error(`model kind mismatch: file is "${kind}", expected "${expectedKind}"`);
    const spec = SPECS[kind];
    if (file.featureVersion !== spec.version) {
      throw new Error(`feature version mismatch: model ${file.featureVersion}, code ${spec.version}`);
    }
    if (file.mean.length !== spec.dim) {
      throw new Error(`feature size mismatch: model ${file.mean.length}, code ${spec.dim}`);
    }
    this.kind = kind;
    this.mean = Float32Array.from(file.mean);
    this.invStd = Float32Array.from(file.std.map(s => 1 / (s > 1e-6 ? s : 1)));
    let inputs = spec.dim;
    this.layers = file.layers.map(layer => {
      const outputs = layer.b.length;
      if (layer.w.length !== outputs || layer.w.some(row => row.length !== inputs)) {
        throw new Error('model layer shape mismatch');
      }
      const w = new Float32Array(outputs * inputs);
      layer.w.forEach((row, o) => w.set(row, o * inputs));
      const built = { w, b: Float32Array.from(layer.b), inputs, outputs };
      inputs = outputs;
      return built;
    });
    if (inputs !== 1) throw new Error('model must output a single logit');
    this.meta = file.meta ?? {};
  }

  /** 確率 (嘘である確率 / ダウトされる確率) */
  predict(features: Float32Array): number {
    let h = new Float32Array(features.length);
    for (let i = 0; i < features.length; i++) h[i] = (features[i] - this.mean[i]) * this.invStd[i];
    for (let l = 0; l < this.layers.length; l++) {
      const { w, b, inputs, outputs } = this.layers[l];
      const out = new Float32Array(outputs);
      for (let o = 0; o < outputs; o++) {
        let acc = b[o];
        const base = o * inputs;
        for (let k = 0; k < inputs; k++) acc += w[base + k] * h[k];
        out[o] = l < this.layers.length - 1 && acc < 0 ? 0 : acc; // ReLU (最終層以外)
      }
      h = out;
    }
    const z = h[0];
    return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
  }
}

/** 互換用の別名 */
export const DoubtModel = MlpModel;
export type DoubtModel = MlpModel;

/** 種類ごとに 1 つのモデルを保持する入れ物 */
class ModelSlot {
  private model: MlpModel | null = null;
  private loaded = false;

  constructor(private readonly kind: ModelKind) {}

  candidatePaths(): string[] {
    const file = SPECS[this.kind].file;
    return [
      path.resolve(__dirname, '..', '..', '..', 'models', file),        // src/ と dist/ から
      path.resolve(__dirname, '..', '..', '..', '..', 'models', file),  // dist-sim/src/ から
      path.resolve(process.cwd(), 'models', file),
      path.resolve(process.cwd(), 'server', 'models', file),
    ];
  }

  /** 使えるモデル (無ければ null)。最初の呼び出しで読み込む */
  current(): MlpModel | null {
    if (!this.loaded) {
      this.loaded = true;
      this.model = this.loadDefault();
    }
    return this.model;
  }

  /** 明示的に差し替える (null で無効化)。テストやシミュレータ用 */
  set(model: MlpModel | null): void {
    this.model = model;
    this.loaded = true;
  }

  loadFile(filePath: string): MlpModel {
    const file = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as MlpModelFile;
    return new MlpModel(file, this.kind);
  }

  private loadDefault(): MlpModel | null {
    const configured = process.env[SPECS[this.kind].env];
    if (configured === 'off') return null;
    const paths = configured ? [path.resolve(configured)] : this.candidatePaths();
    for (const candidate of paths) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const model = this.loadFile(candidate);
        console.log(`[LearnedModel] loaded ${this.kind} model ${candidate}`);
        return model;
      } catch (err) {
        console.warn(`[LearnedModel] ignored ${candidate}: ${(err as Error).message}`);
      }
    }
    return null;
  }
}

/** 嘘判定モデル */
export const LearnedDoubt = new ModelSlot('doubt');
/** ダウト予測モデル */
export const LearnedRisk = new ModelSlot('risk');
