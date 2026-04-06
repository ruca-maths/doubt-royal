import torch
import numpy as np
import os
import sys

def inspect_checkpoint(filepath, output_path):
    with open(output_path, 'w', encoding='utf-8') as f:
        sys.stdout = f
        if not os.path.exists(filepath):
            print(f"Error: File {filepath} not found.")
            return

        print(f"--- Inspecting Checkpoint: {filepath} ---")
        try:
            ckpt = torch.load(filepath, map_location='cpu')
        except Exception as e:
            print(f"Error loading checkpoint: {e}")
            return

        print(f"Keys in checkpoint: {list(ckpt.keys())}")
        episode = ckpt.get('episode', 'Unknown')
        print(f"Last trained episode: {episode}")

        if 'model_state_dict' in ckpt:
            state_dict = ckpt['model_state_dict']
            print("\n--- Network Layer Statistics ---")
            for name, param in state_dict.items():
                if 'weight' in name:
                    mean = param.mean().item()
                    std = param.std().item()
                    zeros = (param == 0).sum().item()
                    total = param.numel()
                    zero_pct = (zeros / total) * 100
                    print(f"{name:25} | Shape: {str(param.shape):15} | Mean: {mean:8.4f} | Std: {std:8.4f} | Zero%: {zero_pct:5.1f}%")
                
                if 'bias' in name:
                    mean = param.mean().item()
                    print(f"{name:25} | Mean: {mean:8.4f}")

        if 'bluff_tracker_state' in ckpt:
            tracker = ckpt['bluff_tracker_state']
            print("\n--- Bluff Tracker Overview ---")
            total_bluffs = tracker.get('global_bluff_attempts', 0)
            caught_bluffs = tracker.get('global_bluff_caught', 0)
            doubts = tracker.get('total_doubts', 0)
            doubt_success = tracker.get('total_doubts_success', 0)
            
            print(f"Global Bluff Attempts: {total_bluffs}")
            print(f"Global Bluff Caught:   {caught_bluffs} ({caught_bluffs/max(1, total_bluffs)*100:.1f}%)")
            print(f"Total Doubts Made:     {doubts}")
            print(f"Doubt Success Rate:    {doubt_success/max(1, doubts)*100:.1f}%")

        sys.stdout = sys.__stdout__

if __name__ == "__main__":
    target = r'C:\Users\nakan\.gemini\antigravity\scratch\card-game\server\rl\deepnash_policy_latest.pth'
    out = r'C:\Users\nakan\.gemini\antigravity\scratch\card-game\server\rl\inspect_result.txt'
    inspect_checkpoint(target, out)
    print(f"Done. Result saved to {out}")
