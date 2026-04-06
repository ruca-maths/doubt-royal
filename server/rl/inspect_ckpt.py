import torch
import torch.nn as nn
import torch.nn.functional as F
import numpy as np
import os
import sys

# モデル定義のミラー（ロード用）
class ActorCriticNet(nn.Module):
    def __init__(self, obs_dim=114, action_dim=176):
        super().__init__()
        self.shared = nn.Sequential(
            nn.Linear(obs_dim, 512),
            nn.LayerNorm(512),
            nn.ReLU(),
            nn.Linear(512, 512),
            nn.LayerNorm(512),
            nn.ReLU(),
            nn.Linear(512, 256),
            nn.LayerNorm(256),
            nn.ReLU()
        )
        self.actor = nn.Linear(256, action_dim)
        self.critic = nn.Linear(256, 1)

    def forward(self, x):
        features = self.shared(x)
        probs = F.softmax(self.actor(features), dim=-1)
        value = self.critic(features)
        return probs, value

def inspect_checkpoint(filepath, output_path=None):
    log_file = None
    if output_path:
        log_file = open(output_path, 'w', encoding='utf-8')
        sys.stdout = log_file

    try:
        if not os.path.exists(filepath):
            print(f"❌ Error: File {filepath} not found.")
            return

        print(f"🔍 --- Inspecting Checkpoint: {os.path.basename(filepath)} ---")
        
        # CPUでロード
        ckpt = torch.load(filepath, map_location='cpu')
        
        print(f"📊 Keys in checkpoint: {list(ckpt.keys())}")
        
        episode = ckpt.get('episode', 'Unknown')
        print(f"⭐ Last trained episode: {episode}")

        # モデルのロード試行
        state_dict = None
        if 'model_state_dict' in ckpt:
            state_dict = ckpt['model_state_dict']
            print("✅ Detected 'model_state_dict' in checkpoint.")
        elif any('weight' in k for k in ckpt.keys()):
            state_dict = ckpt
            print("✅ Detected raw state_dict.")

        if state_dict:
            print("\n--- Network Layer Statistics ---")
            for name, param in state_dict.items():
                if 'weight' in name:
                    mean = param.mean().item()
                    std = param.std().item()
                    max_v = param.max().item()
                    min_v = param.min().item()
                    print(f"{name:30} | Mean: {mean:8.4f} | Std: {std:8.4f} | Range: [{min_v:6.2f}, {max_v:6.2f}]")
            
            # モデルの矛盾チェック
            try:
                model = ActorCriticNet()
                model.load_state_dict(state_dict)
                print("\n✅ Model structure matches current ActorCriticNet definition.")
            except Exception as e:
                print(f"\n⚠️ Model structure mismatch: {e}")

        # ブラフトラッカーの統計
        if 'bluff_tracker_state' in ckpt:
            tracker = ckpt['bluff_tracker_state']
            stats = tracker.get('stats', {})
            print("\n--- Bluff Statistics (by card number) ---")
            print(f"{'Num':>4} | {'Attempts':>10} | {'Caught':>10} | {'CaughtRate':>12}")
            print("-" * 45)
            
            for i in range(14):
                s = stats.get(i, {}) or stats.get(str(i), {})
                if not s: continue
                att = s.get('attempts', 0)
                ct = s.get('caught', 0)
                rate = (ct / att * 100) if att > 0 else 0
                label = f"Joker" if i == 0 else str(i)
                print(f"{label:>4} | {att:>10} | {ct:>10} | {rate:11.1f}%")
            
            total_att = tracker.get('global_bluff_attempts', 0)
            total_ct = tracker.get('global_bluff_caught', 0)
            g_rate = (total_ct / total_att * 100) if total_att > 0 else 0
            print("-" * 45)
            print(f"{'TOTAL':>4} | {total_att:>10} | {total_ct:>10} | {g_rate:11.1f}%")

            doubts = tracker.get('total_doubts', 0)
            ds = tracker.get('total_doubts_success', 0)
            ds_rate = (ds / doubts * 100) if doubts > 0 else 0
            print(f"\nTotal Doubts Made: {doubts}, Success: {ds} ({ds_rate:.1f}%)")

    except Exception as e:
        print(f"❌ Error during inspection: {e}")
        import traceback
        traceback.print_exc()
    finally:
        if log_file:
            sys.stdout = sys.__stdout__
            log_file.close()

if __name__ == "__main__":
    # パスは適宜調整
    target_path = 'deepnash_policy_latest.pth'
    if not os.path.exists(target_path):
        target_path = os.path.join(os.path.dirname(__file__), 'deepnash_policy_latest.pth')
    
    inspect_checkpoint(target_path)
