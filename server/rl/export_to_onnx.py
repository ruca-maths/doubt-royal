import torch
import torch.nn as nn
import torch.nn.functional as F
import os

# New ActorCriticNet architecture (v2.1 - 512 units + LayerNorm)
class ActorCriticNet(nn.Module):
    def __init__(self, obs_dim=114, action_dim=176):
        super().__init__()
        self.fc1 = nn.Linear(obs_dim, 512)
        self.ln1 = nn.LayerNorm(512)
        self.fc2 = nn.Linear(512, 512)
        self.ln2 = nn.LayerNorm(512)
        self.fc3 = nn.Linear(512, 256)
        self.ln3 = nn.LayerNorm(256)
        self.actor = nn.Linear(256, action_dim)
        self.critic = nn.Linear(256, 1)
        nn.init.orthogonal_(self.critic.weight, gain=1.0)
        nn.init.constant_(self.critic.bias, 0.0)

    def forward(self, x):
        x = F.relu(self.ln1(self.fc1(x)))
        x = F.relu(self.ln2(self.fc2(x)))
        x = F.relu(self.ln3(self.fc3(x)))
        return F.softmax(self.actor(x), dim=-1), self.critic(x)


def export():
    model = ActorCriticNet(114, 176)
    
    pth_path = "deepnash_policy_latest.pth"
    if not os.path.exists(pth_path):
        print(f"Error: {pth_path} not found.")
        return

    try:
        checkpoint = torch.load(pth_path, map_location=torch.device('cpu'))
        if 'model_state_dict' in checkpoint:
            model.load_state_dict(checkpoint['model_state_dict'])
            ep = checkpoint.get('episode', '?')
            print(f"Successfully loaded {pth_path} (episode {ep})")
        else:
            model.load_state_dict(checkpoint)
            print(f"Successfully loaded {pth_path}")
    except Exception as e:
        print(f"Error loading state dict: {e}")
        return

    model.eval()

    dummy_input = torch.randn(1, 114)
    output_path = "doubt_royale_latest.onnx"
    
    torch.onnx.export(
        model, 
        dummy_input, 
        output_path, 
        input_names=['input'], 
        output_names=['action_probs', 'state_value'],
        dynamic_axes={
            'input': {0: 'batch_size'}, 
            'action_probs': {0: 'batch_size'}, 
            'state_value': {0: 'batch_size'}
        },
        opset_version=11
    )
    
    print(f"Successfully exported to {output_path}")

if __name__ == "__main__":
    export()
