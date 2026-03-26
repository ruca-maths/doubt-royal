# Google Colab で実行するための Doubt Royale 強化学習統合スクリプト

import gymnasium as gym
from gymnasium import spaces
import numpy as np
import random
import torch
import torch.nn as nn
import torch.nn.functional as F
import torch.optim as optim
from collections import deque
import time

# --- 1. 環境の定義 (env.py 相当) ---
class DoubtRoyaleEnv(gym.Env):
    def __init__(self, num_players=4):
        super(DoubtRoyaleEnv, self).__init__()
        self.num_players = num_players
        self.observation_space = spaces.Dict({
            "hand": spaces.Box(low=0, high=1, shape=(54,), dtype=np.int32),
            "field": spaces.Box(low=0, high=13, shape=(3,), dtype=np.int32),
            "others_count": spaces.Box(low=0, high=54, shape=(num_players - 1,), dtype=np.int32),
            "status": spaces.MultiBinary(2)
        })
        self.action_space = spaces.Discrete(29)

    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        self.deck = self._create_deck()
        random.shuffle(self.deck)
        self.hands = [[] for _ in range(self.num_players)]
        for i in range(54):
            self.hands[i % self.num_players].append(self.deck[i])
        self.current_player = 0
        self.field = {"number": 0, "count": 0, "last_player": -1, "cards": []}
        self.is_revolution = False
        self.is_eleven_back = False
        self.player_lives = [3] * self.num_players
        self.player_out = [False] * self.num_players
        return self._get_obs(), {}

    def _create_deck(self):
        deck = []
        for suit in range(4):
            for num in range(1, 14):
                deck.append({"suit": suit, "number": num, "id": f"{suit}_{num}", "is_joker": False})
        deck.append({"suit": -1, "number": 0, "id": "joker_1", "is_joker": True})
        deck.append({"suit": -1, "number": 0, "id": "joker_2", "is_joker": True})
        return deck

    def _get_obs(self):
        hand_vec = np.zeros(54, dtype=np.int32)
        for card in self.hands[0]:
            if card["is_joker"]:
                idx = 52 + (0 if card["id"] == "joker_1" else 1)
            else:
                idx = card["suit"] * 13 + (card["number"] - 1)
            hand_vec[idx] = 1
        others_count = np.array([len(self.hands[i]) for i in range(1, self.num_players)], dtype=np.int32)
        last_player_rel = (self.field["last_player"] - self.current_player) % self.num_players if self.field["last_player"] != -1 else -1
        return {
            "hand": hand_vec,
            "field": np.array([self.field["number"], self.field["count"], last_player_rel], dtype=np.int32),
            "others_count": others_count,
            "status": np.array([int(self.is_revolution), int(self.is_eleven_back)], dtype=np.int32)
        }

    def step(self, action):
        terminated = False
        reward = 0
        if action == 0: self._handle_pass(0)
        elif 1 <= action <= 13: self._handle_play(0, action, lie=False)
        elif action == 14: self._handle_doubt(0)
        elif 15 == action: pass # Counter (not fully implemented)
        elif 16 <= action <= 28: self._handle_play(0, action - 15, lie=True)

        self._simulate_others()
        if len(self.hands[0]) == 0 and not self.player_out[0]:
            reward += 10.0
            terminated = True
        elif self.player_out[0]:
            reward -= 5.0
            terminated = True
        return self._get_obs(), reward, terminated, False, {}

    def _handle_play(self, player_idx, declared_num, lie=False):
        hand = self.hands[player_idx]
        cards_to_play = []
        if not lie:
            cards_to_play = [c for c in hand if c["number"] == declared_num]
            if not cards_to_play and hand: cards_to_play = [hand[0]]
        else:
            others = [c for c in hand if c["number"] != declared_num]
            cards_to_play = [others[0]] if others else ([hand[0]] if hand else [])
        if not cards_to_play: return False
        self.hands[player_idx] = [c for c in hand if c["id"] not in [cp["id"] for cp in cards_to_play]]
        self.field.update({"number": declared_num, "count": len(cards_to_play), "last_player": player_idx, "cards": cards_to_play})
        self.current_player = (self.current_player + 1) % self.num_players
        return True

    def _handle_pass(self, player_idx):
        self.current_player = (self.current_player + 1) % self.num_players
        if self.field["last_player"] == self.current_player:
            self.field = {"number": 0, "count": 0, "last_player": -1, "cards": []}

    def _handle_doubt(self, player_idx):
        if self.field["last_player"] in [-1, player_idx]: return
        liar_idx = self.field["last_player"]
        is_lie = any(c["number"] != self.field["number"] and not c["is_joker"] for c in self.field["cards"])
        if is_lie:
            self.hands[liar_idx].extend(self.field["cards"])
            self.player_lives[liar_idx] -= 1
        else:
            self.hands[player_idx].extend(self.field["cards"])
            self.player_lives[player_idx] -= 1
        self.field = {"number": 0, "count": 0, "last_player": -1, "cards": []}

    def _simulate_others(self):
        steps = 0
        while self.current_player != 0 and not all(self.player_out) and steps < 100:
            steps += 1
            p_idx = self.current_player
            if not self.hands[p_idx]:
                self.player_out[p_idx] = True
                self.current_player = (self.current_player + 1) % self.num_players
                continue
            r = random.random()
            if r < 0.8:
                possible_nums = list(set([c["number"] for c in self.hands[p_idx]]))
                if possible_nums: self._handle_play(p_idx, random.choice(possible_nums), lie=False)
                else: self._handle_pass(p_idx)
            elif r < 0.9: self._handle_play(p_idx, random.randint(1, 13), lie=True)
            else: self._handle_pass(p_idx)

# --- 2. モデルの定義 (model.py 相当) ---
class DQN(nn.Module):
    def __init__(self, obs_shape, n_actions):
        super(DQN, self).__init__()
        self.fc = nn.Sequential(nn.Linear(62, 128), nn.ReLU(), nn.Linear(128, 128), nn.ReLU(), nn.Linear(128, n_actions))
    def forward(self, x): return self.fc(x)

# --- 3. 学習ループ (train.py 相当) ---
def train_colab():
    env = DoubtRoyaleEnv()
    n_actions = env.action_space.n
    policy_net = DQN(62, n_actions)
    target_net = DQN(62, n_actions)
    target_net.load_state_dict(policy_net.state_dict())
    optimizer = optim.Adam(policy_net.parameters(), lr=1e-3)
    memory = deque(maxlen=10000)
    epsilon = 1.0
    
    for episode in range(1000): # 1000エピソード学習
        state, _ = env.reset()
        total_reward = 0
        while True:
            # Action Selection
            if random.random() < epsilon: action = random.randint(0, n_actions - 1)
            else:
                with torch.no_grad():
                    flat_state = np.concatenate([state["hand"], state["field"], state["others_count"], state["status"]])
                    action = torch.argmax(policy_net(torch.FloatTensor(flat_state))).item()
            
            next_state, reward, done, _, _ = env.step(action)
            memory.append((state, action, reward, next_state, done))
            
            # Training Step
            if len(memory) > 64:
                batch = random.sample(memory, 64)
                s_batch = torch.FloatTensor([np.concatenate([s["hand"], s["field"], s["others_count"], s["status"]]) for s, a, r, ns, d in batch])
                ns_batch = torch.FloatTensor([np.concatenate([ns["hand"], ns["field"], ns["others_count"], ns["status"]]) for s, a, r, ns, d in batch])
                a_batch = torch.LongTensor([a for s, a, r, ns, d in batch]).unsqueeze(1)
                r_batch = torch.FloatTensor([r for s, a, r, ns, d in batch])
                d_batch = torch.BoolTensor([d for s, a, r, ns, d in batch])
                
                q_vals = policy_net(s_batch).gather(1, a_batch).squeeze()
                next_q = target_net(ns_batch).max(1)[0]
                next_q[d_batch] = 0.0
                expected_q = r_batch + 0.99 * next_q
                loss = F.mse_loss(q_vals, expected_q)
                optimizer.zero_grad()
                loss.backward(); optimizer.step()

            state = next_state
            total_reward += reward
            if done: break
            
        epsilon = max(0.05, epsilon * 0.995)
        if episode % 100 == 0:
            print(f"Episode {episode}, Reward: {total_reward:.2f}, Epsilon: {epsilon:.2f}")
            target_net.load_state_dict(policy_net.state_dict())

    # --- 4. ONNX への書き出し ---
    print("Exporting to ONNX...")
    dummy_input = torch.randn(1, 62)
    torch.onnx.export(policy_net, dummy_input, "doubt_royale_model.onnx", input_names=['input'], output_names=['output'])
    print("Done! doubt_royale_model.onnx をダウンロードしてください。")

if __name__ == "__main__":
    train_colab()
