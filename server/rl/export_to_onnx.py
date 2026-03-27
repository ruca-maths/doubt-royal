import torch
import torch.nn as nn
import os

# Define the model architecture based on colab_training.py
class DQN(nn.Module):
    def __init__(self, n_actions):
        super(DQN, self).__init__()
        self.fc = nn.Sequential(
            nn.Linear(62, 256), nn.ReLU(),
            nn.Linear(256, 256), nn.ReLU(),
            nn.Linear(256, n_actions)
        )
    def forward(self, x): return self.fc(x)

def export():
    n_actions = 29
    model = DQN(n_actions)
    
    pth_path = "policy_net_latest.pth"
    if not os.path.exists(pth_path):
        print(f"Error: {pth_path} not found.")
        return

    # Load weights
    try:
        state_dict = torch.load(pth_path, map_location=torch.device('cpu'))
        model.load_state_dict(state_dict)
        print(f"Successfully loaded {pth_path}")
    except Exception as e:
        print(f"Error loading state dict: {e}")
        print("Attempting to load with different architecture (rl/model.py style)...")
        # Fallback to rl/model.py style if necessary
        # (Though colab_training.py style is expected)
        return

    model.eval()

    # Export to ONNX
    dummy_input = torch.randn(1, 62)
    output_path = "../doubt_royale_model_latest.onnx"
    
    torch.onnx.export(
        model, 
        dummy_input, 
        output_path, 
        input_names=['input'], 
        output_names=['output'],
        dynamic_axes={'input': {0: 'batch_size'}, 'output': {0: 'batch_size'}}
    )
    
    print(f"Successfully exported to {output_path}")

if __name__ == "__main__":
    export()
