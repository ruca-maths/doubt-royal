/**
 * 学習済みの嘘判定モデル (多層パーセプトロン) を読み込んで推論する。
 *
 * モデルは server/learn/train_doubt.py が書き出す JSON。依存ライブラリなしの
 * 純粋な TypeScript で計算するので、サーバーでもシミュレータでも同期的に使える。
 *
 * 読み込み先 (最初に見つかったもの):
 *   1. 環境変数 DOUBT_ROYALE_DOUBT_MODEL (ファイルパス。"off" で無効化)
 *   2. server/models/doubt-model.json
 * 見つからない / 特徴量の版が合わない場合は null になり、Brain は手作りの判定を使う。
 */
import * as fs from 'fs';
import * as path from 'path';
import { DOUBT_FEATURE_DIM, DOUBT_FEATURE_VERSION } from './doubtFeatures';

interface LayerFile {
  /** 出力 × 入力 */
  w: number[][];
  b: number[];
}

export interface DoubtModelFile {
  format: 'doubt-mlp';
  featureVersion: number;
  featureNames: string[];
  mean: number[];
  std: number[];
  layers: LayerFile[];
  meta?: Record<string, unknown>;
}

interface Layer {
  w: Float32Array;
  b: Float32Array;
  inputs: number;
  outputs: number;
}

export class DoubtModel {
  private readonly layers: Layer[];
  private readonly mean: Float32Array;
  private readonly invStd: Float32Array;
  readonly meta: Record<string, unknown>;

  constructor(file: DoubtModelFile) {
    if (file.format !== 'doubt-mlp') throw new Error(`unknown model format: ${file.format}`);
    if (file.featureVersion !== DOUBT_FEATURE_VERSION) {
      throw new Error(`feature version mismatch: model ${file.featureVersion}, code ${DOUBT_FEATURE_VERSION}`);
    }
    if (file.mean.length !== DOUBT_FEATURE_DIM) {
      throw new Error(`feature size mismatch: model ${file.mean.length}, code ${DOUBT_FEATURE_DIM}`);
    }
    this.mean = Float32Array.from(file.mean);
    this.invStd = Float32Array.from(file.std.map(s => 1 / (s > 1e-6 ? s : 1)));
    let inputs = DOUBT_FEATURE_DIM;
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

  /** 嘘である確率 */
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

export class LearnedDoubt {
  private static model: DoubtModel | null = null;
  private static loaded = false;

  static candidatePaths(): string[] {
    return [
      path.resolve(__dirname, '..', '..', '..', 'models', 'doubt-model.json'),        // src/ と dist/ から
      path.resolve(__dirname, '..', '..', '..', '..', 'models', 'doubt-model.json'),  // dist-sim/src/ から
      path.resolve(process.cwd(), 'models', 'doubt-model.json'),
      path.resolve(process.cwd(), 'server', 'models', 'doubt-model.json'),
    ];
  }

  /** 使えるモデル (無ければ null)。最初の呼び出しで読み込む */
  static current(): DoubtModel | null {
    if (!LearnedDoubt.loaded) {
      LearnedDoubt.loaded = true;
      LearnedDoubt.model = LearnedDoubt.loadDefault();
    }
    return LearnedDoubt.model;
  }

  /** 明示的に差し替える (null で無効化)。テストやシミュレータ用 */
  static set(model: DoubtModel | null): void {
    LearnedDoubt.model = model;
    LearnedDoubt.loaded = true;
  }

  static loadFile(filePath: string): DoubtModel {
    const file = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DoubtModelFile;
    return new DoubtModel(file);
  }

  private static loadDefault(): DoubtModel | null {
    const configured = process.env.DOUBT_ROYALE_DOUBT_MODEL;
    if (configured === 'off') return null;
    const paths = configured ? [path.resolve(configured)] : LearnedDoubt.candidatePaths();
    for (const candidate of paths) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const model = LearnedDoubt.loadFile(candidate);
        console.log(`[LearnedDoubt] loaded ${candidate}`);
        return model;
      } catch (err) {
        console.warn(`[LearnedDoubt] ignored ${candidate}: ${(err as Error).message}`);
      }
    }
    return null;
  }
}
