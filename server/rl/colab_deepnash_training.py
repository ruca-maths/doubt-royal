"""
Google Colab で実行するための Doubt Royale 強化学習スクリプト
【Phase 4: 全特殊効果(Q/7/10等) ＋ カウンター(4/スペ3) 実装版】
"""

import os
import gymnasium as gym
from gymnasium import spaces
import numpy as np
import random
import torch
import torch.nn as nn
import torch.nn.functional as F
import torch.optim as optim
from torch.distributions import Categorical
import copy
import time

try:
    import sympy
    if not hasattr(sympy, 'core'):
        raise ImportError("Sympy install is broken")
except (ImportError, AttributeError):
    print("Sympy attribute error detected. Fixing environment...")
    import subprocess
    import sys
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--upgrade", "sympy"])
    import sympy

try:
    from google.colab import drive
    drive.mount('/content/drive')
    SAVE_DIR = '/content/drive/MyDrive/doubt_royale_ai_v15'
    os.makedirs(SAVE_DIR, exist_ok=True)
except Exception:
    SAVE_DIR = '.'

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")

class DynamicRewardSystem:
    def __init__(self):
        self.weights = {
            'honest_play': 0.1,
            'bluff_success': 0.2,
            'bluff_caught': -2.0,
            'doubt_success': 0.3,
            'doubt_failure': -1.0,
            'win': 100.0,
            'lose': -30.0,
            'step': -0.05,
            'pass': -0.02,
            'invalid_action': -0.1,
            'forbidden_finish': -50.0,
            'multi_play_bonus': 0.1
        }
        self.recent_wins = []
        self.last_adj_ep = 0

    def get_reward(self, event): return self.weights.get(event, 0.0)
    
    def record_win(self, won):
        self.recent_wins.append(1 if won else 0)
        if len(self.recent_wins) > 100: self.recent_wins.pop(0)

    def adjust(self, ep):
        if ep - self.last_adj_ep < 500 or len(self.recent_wins) < 100: return
        self.last_adj_ep = ep
        win_rate = sum(self.recent_wins) / len(self.recent_wins)
        diff = win_rate - 0.25
        agg = max(0.8, min(1.2, 1.0 + diff * 0.5))
        con = max(0.8, min(1.2, 1.0 - diff * 0.5))
        
        self.weights['bluff_success'] *= agg
        self.weights['doubt_success'] *= agg
        self.weights['doubt_failure'] *= con
        self.weights['invalid_action'] *= con
        self.weights['pass'] *= con
        self.weights['bluff_caught'] *= con
        self.weights['honest_play'] *= con
        self.weights['multi_play_bonus'] *= con

        for k in ['bluff_success', 'doubt_success']:
            self.weights[k] = min(max(self.weights[k], 0.05), 1.0)
        self.weights['honest_play'] = min(max(self.weights['honest_play'], 0.01), 0.5)
        self.weights['multi_play_bonus'] = min(max(self.weights['multi_play_bonus'], 0.01), 0.5)
        for k in ['doubt_failure', 'pass', 'invalid_action', 'bluff_caught']:
            self.weights[k] = min(max(self.weights[k], -10.0), -0.01)

class DoubtRoyaleEnv(gym.Env):
    def __init__(self, reward_sys, num_players=4):
        super().__init__()
        self.num_players = num_players
        self.reward_sys = reward_sys
        self.opponent_policies = None
        self.device = DEVICE
        
        # Action Space Dimension: 176
        # 0: Pass/Decline
        # 1-52: Honest Play (13 nums * 4 counts)
        # 53-104: Bluff Play (13 nums * 4 counts)
        # 105: Doubt
        # 106: Counter 4
        # 107: Counter Spade 3
        # 108-120: Q Bomb Num (1-13)
        # 121: Q Bomb Joker
        # 122-175: Select Card Index (0-53)
        self.action_space = spaces.Discrete(176)
        
    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        deck = [{"suit": s, "number": n, "id": f"{s}-{n}", "is_joker": False} for s in range(4) for n in range(1, 14)]
        deck += [{"suit": -1, "number": 0, "id": f"joker-{i}", "is_joker": True} for i in [1, 2]]
        random.shuffle(deck)
        
        self.hands = [[] for _ in range(self.num_players)]
        for i in range(54): self.hands[i % self.num_players].append(deck[i])
        
        self.turn_player = random.randint(0, self.num_players - 1)
        self.active_player = self.turn_player
        self.phase = 'playing'
        self.ask_idx = 0
        self.pending_effect = None
        
        self.field = {"number": 0, "count": 0, "last_player": -1, "cards": []}
        self.face_up_pool = []
        self.is_revolution = False
        self.is_eleven_back = False
        self.player_lives = [3] * self.num_players
        self.player_out = [False] * self.num_players
        return self._get_flat_obs(0), {}

    def _get_flat_obs(self, player_idx):
        hand_vec = np.zeros(54, dtype=np.float32)
        for card in self.hands[player_idx]:
            if card["is_joker"]: idx = 52 if "1" in card["id"] else 53
            else: idx = card["suit"] * 13 + (card["number"] - 1)
            hand_vec[idx] = 1.0
            
        others = np.array([len(self.hands[i]) / 54.0 for i in range(self.num_players) if i != player_idx], dtype=np.float32)
        field_vec = np.array([self.field["number"] / 13.0, self.field["count"] / 4.0, (self.field["last_player"] + 1) / 4.0], dtype=np.float32)
        
        phase_map = {'playing':0, 'doubting':1, 'countering':2, 'q_bomb':3, 'card_sel':4}
        status_vec = np.array([self.is_revolution, self.is_eleven_back, phase_map[self.phase] / 4.0], dtype=np.float32)
        
        face_up_counts = np.zeros(14, dtype=np.float32)
        for card in self.face_up_pool:
            cidx = 0 if card["is_joker"] else card["number"]
            face_up_counts[cidx] += 1.0
        face_up_counts = face_up_counts / 4.0
            
        obs = np.concatenate([hand_vec, field_vec, others, status_vec, face_up_counts])
        return np.pad(obs, (0, 114 - len(obs)))

    def _add_reward(self, event):
        self.reward_buffer += self.reward_sys.get_reward(event)

    def step(self, action):
        self.reward_buffer = 0.0
        if self.player_out[0]: return self._get_flat_obs(0), 0.0, True, False, {}

        # プレイヤー0のターンでない場合
        if self.active_player != 0:
            self._simulate_others()
            done, is_win = self._check_done()
            if done: self._add_reward('win' if is_win else 'lose')
            return self._get_flat_obs(0), self.reward_buffer, done, False, {}

        # プレイヤー0のターン
        valid = False
        self._add_reward('step')
        if self.phase == 'playing':
            if action == 0: 
                if self.field["count"] == 0: valid = False
                else: valid = self._handle_pass(0); self._add_reward('pass')
            elif 1 <= action <= 52: 
                num = ((action - 1) % 13) + 1
                cnt = ((action - 1) // 13) + 1
                valid = self._handle_play(0, num, cnt, False)
                if valid: 
                    self._add_reward('honest_play')
                    if cnt > 1: self.reward_buffer += self.reward_sys.get_reward('multi_play_bonus') * cnt
            elif 53 <= action <= 104: 
                num = ((action - 53) % 13) + 1
                cnt = ((action - 53) // 13) + 1
                valid = self._handle_play(0, num, cnt, True)
                if valid and cnt > 1:
                    self.reward_buffer += self.reward_sys.get_reward('multi_play_bonus') * cnt
        elif self.phase == 'doubting':
            if action == 0: self._resolve_doubt(0, False); valid = True
            elif action == 105: 
                suc = self._resolve_doubt(0, True); valid = True
                self._add_reward('doubt_success' if suc else 'doubt_failure')
        elif self.phase == 'countering':
            if action == 0: self._resolve_counter(0, 0); valid = True
            elif action == 106: valid = self._resolve_counter(0, 4)
            elif action == 107: valid = self._resolve_counter(0, 3)
        elif self.phase == 'q_bomb':
            if 108 <= action <= 121: self._apply_q_bomb(action - 107 if action <= 120 else 0); valid = True
        elif self.phase == 'card_sel':
            if 122 <= action <= 175: valid = self._apply_card_select(0, action - 122)
            
        if not valid:
            self._add_reward('invalid_action')
            if self.phase == 'q_bomb': self._apply_q_bomb(1)
            elif self.phase == 'card_sel': self._apply_card_select(0, -1)
            elif self.phase == 'playing': 
                if self.field["count"] == 0: self._force_play(0)
                else: self._handle_pass(0)
            else: self.active_player = self._next_player(self.active_player)
            
        self._simulate_others()
        done, is_win = self._check_done()
        if done: self._add_reward('win' if is_win else 'lose')
        
        return self._get_flat_obs(0), self.reward_buffer, done, False, {}

    def _check_done(self):
        ai_won = len(self.hands[0]) == 0 and self.player_lives[0] > 0
        ai_dead = self.player_out[0]
        any_opp_won = any(len(self.hands[i]) == 0 and self.player_lives[i] > 0 for i in range(1, self.num_players))
        if ai_won: return True, True
        if ai_dead or any_opp_won or sum(self.player_out) >= self.num_players - 1: return True, False
        return False, False

    def _next_player(self, p):
        for _ in range(self.num_players):
            p = (p + 1) % self.num_players
            if not self.player_out[p]: return p
        return p

    def _handle_pass(self, p_idx):
        if self.field["last_player"] in [-1, p_idx]: self.field = {"number": 0, "count": 0, "last_player": -1, "cards": []}
        self.turn_player = self._next_player(p_idx)
        self.active_player = self.turn_player
        return True

    def _handle_play(self, p_idx, num, cnt, lie):
        if not self.hands[p_idx]: return False
        
        # 既に出ている場合は枚数を合わせる必要がある
        if self.field["count"] > 0 and cnt != self.field["count"]:
            return False
            
        if not lie:
            matching = [c for c in self.hands[p_idx] if (0 if c["is_joker"] else c["number"]) == num]
            if len(matching) < cnt: return False
            cards = matching[:cnt]
        else:
            other_cards = [c for c in self.hands[p_idx] if (0 if c["is_joker"] else c["number"]) != num]
            if len(other_cards) < cnt:
                if len(self.hands[p_idx]) < cnt: return False
                cards = self.hands[p_idx][:cnt]
            else:
                cards = other_cards[:cnt]
                
        self.hands[p_idx] = [c for c in self.hands[p_idx] if c["id"] not in [cp["id"] for cp in cards]]
        self.field.update({"number": num, "count": len(cards), "last_player": p_idx, "cards": cards})
        if len(cards) >= 4: self.is_revolution = not self.is_revolution
        self.phase = 'doubting'; self.ask_idx = 1; self._set_ask_player()
        return True

    def _set_ask_player(self):
        while self.ask_idx < self.num_players:
            p = (self.turn_player + self.ask_idx) % self.num_players
            if not self.player_out[p]: self.active_player = p; return
            self.ask_idx += 1
            
        if self.phase == 'doubting':
            # 全員スルー（嘘が通った場合）
            if self.field["last_player"] == 0: self._add_reward('bluff_success') # Player 0の嘘成功
            
            if self.field["number"] == 8 or (self.field["number"] == 0 and self.field["count"] == 1):
                self.phase = 'countering'; self.ask_idx = 1; self._set_ask_player()
            else: self._apply_effects()
        elif self.phase == 'countering': self._apply_effects()

    def _give_worst_cards(self, giver, receiver, max_count):
        count = min(max_count, len(self.hands[giver]))
        if count == 0: return
        rev = self.is_revolution != self.is_eleven_back
        def str_fn(c):
             if c["is_joker"]: return 100
             v = c["number"] - 3 + 13 if c["number"] < 3 else c["number"] - 3
             return 12 - v if rev else v
        cards = sorted(self.hands[giver], key=str_fn)
        to_give = cards[:count]
        self.hands[giver] = [c for c in self.hands[giver] if c["id"] not in [tg["id"] for tg in to_give]]
        self.hands[receiver].extend(to_give)

    def _resolve_doubt(self, p_idx, is_doubt):
        if not is_doubt:
            self.ask_idx += 1; self._set_ask_player(); return False
            
        liar = self.field["last_player"]
        cards = self.field["cards"]
        n_cards = len(cards)
        is_lie = any((0 if c["is_joker"] else c["number"]) != self.field["number"] for c in cards)
        
        if is_lie:
            self.field = {"number": 0, "count": 0, "last_player": -1, "cards": []}
            if liar == 0: self._add_reward('bluff_caught') # Player 0がバレた
            elif p_idx == 0: pass # step側で成功報酬処理済み
            
            self.player_lives[liar] -= 1
            if self.player_lives[liar] <= 0: self.player_out[liar] = True
            
            self._give_worst_cards(p_idx, liar, n_cards)
            
            self.turn_player = self._next_player(self.turn_player); self.active_player = self.turn_player; self.phase = 'playing'
            return True
        else:
            if liar == 0 and p_idx != 0: self._add_reward('bluff_success') # 相手の自爆
            self.player_lives[p_idx] -= 1
            if self.player_lives[p_idx] <= 0: self.player_out[p_idx] = True
            
            self._give_worst_cards(liar, p_idx, n_cards)
            
            # Honest cards stay on the field
            self.turn_player = self._next_player(self.turn_player); self.active_player = self.turn_player; self.phase = 'playing'
            return False

    def _resolve_counter(self, p_idx, counter_num):
        if counter_num == 0:
            self.ask_idx += 1; self._set_ask_player()
            return True
            
        has_card = any(c["number"] == counter_num for c in self.hands[p_idx])
        if not has_card: return False
        
        c_card = next(c for c in self.hands[p_idx] if c["number"] == counter_num)
        self.hands[p_idx] = [c for c in self.hands[p_idx] if c["id"] != c_card["id"]]
        self.field["cards"].append(c_card)
        self.field["last_player"] = p_idx
        
        self.turn_player = p_idx
        self._apply_effects() # Counter resolves doubt phase directly
        return True

    def _apply_effects(self):
        # 手札が0枚になった場合の勝利判定とあがり禁止チェック
        num = self.field["number"]
        if len(self.hands[self.turn_player]) == 0:
            # あがり禁止カード判定
            forbidden = [8, 0, 2, 3 if self.is_revolution else -1]
            if num in forbidden:
                # あがり禁止により強制敗北
                self.player_out[self.turn_player] = True
                if self.turn_player == 0:
                    # 自身のペナルティ
                    pass 
            else:
                # 合法的な勝利
                self.player_out[self.turn_player] = True

        # 特殊効果の適用
        if num == 12 and not self.player_out[self.turn_player]:
            self.phase = 'q_bomb'; self.active_player = self.turn_player; return
        if num in [7, 10] and not self.player_out[self.turn_player]:
            self.phase = 'card_sel'; self.pending_effect = num; self.active_player = self.turn_player; return
        if num == 11:
            self.is_eleven_back = not self.is_eleven_back
        
        # 8切りまたはカウンター成功時は場を流す
        if num == 8 or getattr(self, "countered", False):
            self.field = {"number": 0, "count": 0, "last_player": -1, "cards": []}
            # 8切りの場合はターン交代なし
        elif num == 5:
            self.turn_player = self._next_player(self._next_player(self.turn_player))
        else:
            self.turn_player = self._next_player(self.turn_player)
            
        self.active_player = self.turn_player
        self.phase = 'playing'

    def _apply_q_bomb(self, num):
        for i in range(self.num_players):
            if i == self.turn_player or self.player_out[i]: continue
            drops = [c for c in self.hands[i] if (c["number"] == num or (num==0 and c["is_joker"]))]
            self.hands[i] = [c for c in self.hands[i] if c not in drops]
            self.face_up_pool.extend(drops)
        self.turn_player = self._next_player(self.turn_player)
        self.active_player = self.turn_player; self.phase = 'playing'

    def _apply_card_select(self, p_idx, c_idx):
        if c_idx < 0 or len(self.hands[p_idx]) == 0: c_idx = 0
        if c_idx >= len(self.hands[p_idx]): return False
        c = self.hands[p_idx].pop(c_idx)
        if self.pending_effect == 7:
            next_p = self._next_player(p_idx)
            self.hands[next_p].append(c)
        else:
            self.face_up_pool.append(c)
        self.turn_player = self._next_player(self.turn_player)
        self.active_player = self.turn_player; self.phase = 'playing'
        return True

    def _force_play(self, p_idx):
        if not self.hands[p_idx]: return
        rev = self.is_revolution != self.is_eleven_back
        def str_fn(c):
             if c["is_joker"]: return 100
             v = c["number"] - 3 + 13 if c["number"] < 3 else c["number"] - 3
             return 12 - v if rev else v
        cards = sorted(self.hands[p_idx], key=str_fn)
        weakest = cards[0]
        n = 0 if weakest["is_joker"] else weakest["number"]
        matching = [c for c in self.hands[p_idx] if (0 if c["is_joker"] else c["number"]) == n]
        self._handle_play(p_idx, n, len(matching), False)

    def _heuristic_play(self, p_idx):
        if self.field["count"] == 0:
            self._force_play(p_idx)
            return
        
        req_cnt = self.field["count"]
        req_n = self.field["number"]
        rev = self.is_revolution != self.is_eleven_back
        def str_fn(num):
            if num == 0: return 100
            v = num - 3 + 13 if num < 3 else num - 3
            return 12 - v if rev else v
            
        field_str = str_fn(req_n)
        
        from collections import defaultdict
        groups = defaultdict(list)
        for c in self.hands[p_idx]:
           n = 0 if c["is_joker"] else c["number"]
           groups[n].append(c)
           
        for n, cards in groups.items():
            if len(cards) >= req_cnt and str_fn(n) > field_str and not (req_n == 0 and n == 0):
                self._handle_play(p_idx, n, req_cnt, False)
                return
        
        self._handle_pass(p_idx)

    def _simulate_others(self):
        steps = 0
        while self.active_player != 0 and sum(self.player_out) < self.num_players - 1 and steps < 200:
            p = self.active_player
            if self.opponent_policies and len(self.opponent_policies) > p and self.opponent_policies[p] is not None:
                if random.random() < 0.2:
                    a = -1
                else:
                    with torch.no_grad():
                        obs_t = torch.FloatTensor(self._get_flat_obs(p)).unsqueeze(0).to(self.device)
                        probs, _ = self.opponent_policies[p](obs_t)
                        a = Categorical(probs).sample().item()
            else:
                if self.phase == 'playing': a = -1
                elif self.phase == 'doubting': a = random.choice([0, 0, 0, 105])
                elif self.phase == 'countering': a = 0
                elif self.phase == 'q_bomb': a = 108
                else: a = 122
                
            old_phase = self.phase
            
            if self.phase == 'playing':
                if a == -1: self._heuristic_play(p)
                elif a == 0: 
                    if self.field["count"] == 0: self._force_play(p)
                    else: self._handle_pass(p)
                elif 1 <= a <= 52: 
                    num = ((a - 1) % 13) + 1
                    cnt = ((a - 1) // 13) + 1
                    if not self._handle_play(p, num, cnt, False): 
                        if self.field["count"] == 0: self._force_play(p)
                        else: self._handle_pass(p)
                elif 53 <= a <= 104: 
                    num = ((a - 53) % 13) + 1
                    cnt = ((a - 53) // 13) + 1
                    if not self._handle_play(p, num, cnt, True): 
                        if self.field["count"] == 0: self._force_play(p)
                        else: self._handle_pass(p)
                else: 
                     if self.field["count"] == 0: self._force_play(p)
                     else: self._handle_pass(p)
            elif self.phase == 'doubting':
                if a == 105: self._resolve_doubt(p, True)
                else: self._resolve_doubt(p, False)
            elif self.phase == 'countering':
                if a == 106: self._resolve_counter(p, 4)
                elif a == 107: self._resolve_counter(p, 3)
                else: self._resolve_counter(p, 0)
            elif self.phase == 'q_bomb':
                self._apply_q_bomb(a - 107 if 108 <= a <= 120 else 0)
            elif self.phase == 'card_sel':
                self._apply_card_select(p, a - 122 if 122 <= a <= 175 else -1)
                
            steps += 1

class ActorCriticNet(nn.Module):
    def __init__(self, obs_dim=114, action_dim=176):
        super().__init__()
        self.fc1 = nn.Linear(obs_dim, 256)
        self.fc2 = nn.Linear(256, 256)
        self.actor = nn.Linear(256, action_dim)
        self.critic = nn.Linear(256, 1)

    def forward(self, x):
        x = F.relu(self.fc1(x)); x = F.relu(self.fc2(x))
        return F.softmax(self.actor(x), dim=-1), self.critic(x)

class DeepNashAgent:
    def __init__(self, obs_dim, action_dim, lr=3e-4):
        self.device = DEVICE
        self.policy = ActorCriticNet(obs_dim, action_dim).to(self.device)
        self.optimizer = optim.Adam(self.policy.parameters(), lr=lr)
        self.ref_policy = ActorCriticNet(obs_dim, action_dim).to(self.device)
        self.ref_policy.load_state_dict(self.policy.state_dict())
        self.kl_coeff = 0.01
        self.states, self.actions, self.logprobs, self.rewards, self.dones = [], [], [], [], []

    def select_action(self, state):
        state_t = torch.FloatTensor(state).unsqueeze(0).to(self.device)
        with torch.no_grad(): probs, val = self.policy(state_t)
        dist = Categorical(probs); action = dist.sample()
        self.states.append(state_t); self.actions.append(action); self.logprobs.append(dist.log_prob(action))
        return action.item()

    def update(self):
        if not self.states: return
        rewards, R = [], 0
        for r, d in zip(reversed(self.rewards), reversed(self.dones)):
            R = r + 0.99 * R * (1 - d); rewards.insert(0, R)
        rewards = torch.tensor(rewards, dtype=torch.float32).to(self.device)
        if len(rewards) > 1: rewards = (rewards - rewards.mean()) / (rewards.std() + 1e-8)
        
        states, actions = torch.cat(self.states), torch.cat(self.actions)
        for _ in range(4):
            probs, values = self.policy(states); dist = Categorical(probs); logprobs = dist.log_prob(actions)
            with torch.no_grad(): ref_probs, _ = self.ref_policy(states)
            kl = (probs * (torch.log(probs + 1e-10) - torch.log(ref_probs + 1e-10))).sum(-1)
            adv = rewards - values.detach().squeeze()
            loss = -(logprobs * adv).mean() + 0.5 * F.mse_loss(values.squeeze(), rewards) + self.kl_coeff * kl.mean()
            self.optimizer.zero_grad(); loss.backward()
            torch.nn.utils.clip_grad_norm_(self.policy.parameters(), 0.5)
            self.optimizer.step()
        self.states, self.actions, self.logprobs, self.rewards, self.dones = [], [], [], [], []

def train():
    reward_sys = DynamicRewardSystem()
    env = DoubtRoyaleEnv(reward_sys)
    agent = DeepNashAgent(114, 176)
    
    start_ep = 1
    ckpt = os.path.join(SAVE_DIR, "deepnash_policy_latest.pth")
    if os.path.exists(ckpt):
        try:
            checkpoint = torch.load(ckpt, map_location=DEVICE)
            if 'model_state_dict' in checkpoint:
                agent.policy.load_state_dict(checkpoint['model_state_dict'])
                agent.optimizer.load_state_dict(checkpoint['optimizer_state_dict'])
                start_ep = checkpoint['episode'] + 1
            else:
                # 過去バージョン互換
                agent.policy.load_state_dict(checkpoint)
            
            agent.ref_policy.load_state_dict(agent.policy.state_dict())
            print(f"✅ チェックポイント復元: {ckpt} (エピソード {start_ep} から再開)")
        except:
            print(f"⚠️ ネットワーク構成変更またはファイル破損のため、新規学習からスタートします。")

    opponent_pool = []
    
    start_time = time.time()
    for ep in range(start_ep, 50001):
        if opponent_pool: env.opponent_policies = [None] + [random.choice(opponent_pool) for _ in range(3)]
        else: env.opponent_policies = [None] + [agent.policy] * 3

        obs, _ = env.reset(); done = False; ep_reward = 0
        while not done:
            action = agent.select_action(obs)
            obs, reward, done, _, _ = env.step(action)
            agent.rewards.append(reward); agent.dones.append(done)
            ep_reward += reward

        agent.update()
        
        # 勝率には「1位になり生存しているか」のみを記録
        is_first = len(env.hands[0]) == 0 and env.player_lives[0] > 0
        reward_sys.record_win(is_first)
        reward_sys.adjust(ep)

        if ep % 100 == 0:
            wr = sum(reward_sys.recent_wins) / len(reward_sys.recent_wins) if reward_sys.recent_wins else 0
            print(f"EP {ep} | WinRate: {wr:.2%} | LastR: {ep_reward:.2f} | Time: {int(time.time()-start_time)}s")
            # 100エピソードごとに自動保存 (切断対策)
            torch.save({
                'episode': ep,
                'model_state_dict': agent.policy.state_dict(),
                'optimizer_state_dict': agent.optimizer.state_dict()
            }, ckpt)
            print(f"💾 チェックポイントを自動保存しました: {ckpt}")

        if ep % 1000 == 0:
            # 1000エピソードごとに最新のONNXを出力
            latest_onnx = os.path.join(SAVE_DIR, "doubt_royale_latest.onnx")
            torch.onnx.export(agent.policy, torch.randn(1, 114).to(DEVICE), latest_onnx)
            # 履歴用にも保存
            torch.onnx.export(agent.policy, torch.randn(1, 114).to(DEVICE), os.path.join(SAVE_DIR, f"doubt_royale_v15_ep{ep}.onnx"))
            
            agent.ref_policy.load_state_dict(agent.policy.state_dict())
            new_opp = ActorCriticNet(114, 176).to(DEVICE)
            new_opp.load_state_dict(agent.policy.state_dict()); new_opp.eval()
            opponent_pool.append(new_opp)
            if len(opponent_pool) > 10: opponent_pool.pop(0)
            print(f"🚀 ONNXモデルを書き出しました: {latest_onnx}")

if __name__ == "__main__":
    train()
