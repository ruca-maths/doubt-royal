"""
Google Colab で実行するための Doubt Royale 強化学習スクリプト
【Phase 3: DeepNash (R-NaD) 応用版】
Actor-Critic (PPOベース) アーキテクチャに KL ダイバージェンス正則化を組み合わせ、自己対戦でナッシュ均衡への収束を目指す手法。
Colab にコピペして実行できます。
"""

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

# ==========================================
# 1. 環境の定義 (Doubt Royale)
# ==========================================
class DoubtRoyaleEnv(gym.Env):
    def __init__(self, num_players=4):
        super(DoubtRoyaleEnv, self).__init__()
        self.num_players = num_players
        # 自己対戦用
        self.opponent_policies = None 
        
        # 状態空間: 62次元
        # 手札(54) + フィールド(3) + 他人数(3) + ステータス(2)
        self.observation_space = spaces.Dict({
            "hand": spaces.Box(low=0, high=1, shape=(54,), dtype=np.int32),
            "field": spaces.Box(low=0, high=13, shape=(3,), dtype=np.int32),
            "others_count": spaces.Box(low=0, high=54, shape=(num_players - 1,), dtype=np.int32),
            "status": spaces.MultiBinary(2)
        })
        # 0: Pass, 1-13: Honest Play, 14: Doubt, 15: Counter, 16-28: Lie Play
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
        self.pass_count = 0
        return self._get_obs(0), {}

    def _create_deck(self):
        deck = []
        for suit in range(4):
            for num in range(1, 14):
                deck.append({"suit": suit, "number": num, "id": f"card-{len(deck)}", "is_joker": False})
        # Jokers
        deck.append({"suit": -1, "number": 0, "id": "card-52", "is_joker": True})
        deck.append({"suit": -1, "number": 0, "id": "card-53", "is_joker": True})
        return deck

    def _get_obs(self, player_idx):
        hand_vec = np.zeros(54, dtype=np.float32)
        for card in self.hands[player_idx]:
            idx = int(card["id"].split("-")[1])
            if 0 <= idx < 54: hand_vec[idx] = 1.0
        
        others_count = []
        for i in range(self.num_players):
            if i != player_idx:
                others_count.append(len(self.hands[i]))
        others_count = np.array(others_count, dtype=np.float32)
        
        last_player_rel = (self.field["last_player"] - player_idx + self.num_players) % self.num_players if self.field["last_player"] != -1 else -1
        
        field_vec = np.array([self.field["number"], self.field["count"], last_player_rel], dtype=np.float32)
        status_vec = np.array([int(self.is_revolution), int(self.is_eleven_back)], dtype=np.float32)
        if len(self.hands[player_idx]) == 0:
            hand_vec = np.zeros(54, dtype=np.float32) # Already out
            
        return {
            "hand": hand_vec,
            "field": field_vec,
            "others_count": others_count,
            "status": status_vec
        }
        
    def _get_flat_obs(self, player_idx):
        obs = self._get_obs(player_idx)
        return np.concatenate([obs["hand"], obs["field"], obs["others_count"], obs["status"]]).astype(np.float32)

    def step(self, action):
        terminated = False
        reward = 0.0
        
        if self.player_out[0]:
            return self._get_obs(0), 0.0, True, False, {}

        # 0: Pass, 1-13: Honest Play, 14: Doubt, 15: Counter, 16-28: Lie
        if action == 0:
            self._handle_pass(0)
        elif 1 <= action <= 13:
            played = self._handle_play(0, action, lie=False)
            if played: reward += 0.1 # 有効なプレイのステップ報酬
            else: reward -= 0.1      # 無効なアクション（出せないカードなど）
        elif action == 14:
            success = self._handle_doubt(0)
            if success: reward += 1.0
            else: reward -= 1.0
        elif 16 <= action <= 28:
            played = self._handle_play(0, action - 15, lie=True)
            if played: reward += 0.2 # ブラフ成立

        # 他プレイヤーの思考シミュレーション (自己対戦)
        self._simulate_others()

        # 勝敗・終了判定
        if len(self.hands[0]) == 0 and not self.player_out[0]:
            reward += 10.0 # 勝利報酬
            self.player_out[0] = True
            terminated = True
        elif sum(self.player_out) >= self.num_players - 1:
            if not self.player_out[0]:
                reward -= 5.0 # 敗北報酬（最後まで残った）
                self.player_out[0] = True
            terminated = True
        elif self.player_out[0]:
            terminated = True
            
        return self._get_obs(0), reward, terminated, False, {}

    def _handle_play(self, player_idx, declared_num, lie=False):
        hand = self.hands[player_idx]
        if not hand: return False
        
        cards_to_play = []
        if not lie:
            cards_to_play = [c for c in hand if (0 if c["is_joker"] else c["number"]) == declared_num]
            if not cards_to_play: cards_to_play = [hand[0]] # 持ってないのに正直に出そうとしたら強制先頭1枚
        else:
            others = [c for c in hand if (0 if c["is_joker"] else c["number"]) != declared_num]
            cards_to_play = [others[0]] if others else [hand[0]]
            
        if len(cards_to_play) > 0:
            # フィールドに出す
            self.hands[player_idx] = [c for c in hand if c["id"] not in [cp["id"] for cp in cards_to_play]]
            self.field.update({"number": declared_num, "count": len(cards_to_play), "last_player": player_idx, "cards": cards_to_play})
            
            if len(self.hands[player_idx]) == 0:
                self.player_out[player_idx] = True
                
            self.current_player = (self.current_player + 1) % self.num_players
            return True
        return False

    def _handle_pass(self, player_idx):
        self.current_player = (self.current_player + 1) % self.num_players
        # 一周回ったか
        if self.field["last_player"] == self.current_player:
            self.field = {"number": 0, "count": 0, "last_player": -1, "cards": []}

    def _handle_doubt(self, player_idx):
        if self.field["last_player"] in [-1, player_idx]: 
            self.current_player = (self.current_player + 1) % self.num_players
            return False

        liar_idx = self.field["last_player"]
        is_lie = any((0 if c["is_joker"] else c["number"]) != self.field["number"] for c in self.field["cards"])
        
        if is_lie:
            self.hands[liar_idx].extend(self.field["cards"])
            self.player_lives[liar_idx] -= 1
            res = (player_idx == 0) # エージェントがダウト成功
        else:
            self.hands[player_idx].extend(self.field["cards"])
            self.player_lives[player_idx] -= 1
            res = (player_idx != 0) # エージェントがダウト失敗
            
        self.field = {"number": 0, "count": 0, "last_player": -1, "cards": []}
        return res

    def _simulate_others(self):
        steps = 0
        while self.current_player != 0 and sum(self.player_out) < self.num_players - 1 and steps < 100:
            p_idx = self.current_player
            if self.player_out[p_idx] or not self.hands[p_idx]:
                self.player_out[p_idx] = True
                self.current_player = (self.current_player + 1) % self.num_players
                continue

            # 自己対戦モデルが設定されていれば
            if self.opponent_policies and len(self.opponent_policies) > p_idx:
                policy_net = self.opponent_policies[p_idx]
                with torch.no_grad():
                    obs = self._get_flat_obs(p_idx)
                    obs_t = torch.FloatTensor(obs).unsqueeze(0)
                    action_probs, _ = policy_net(obs_t)
                    dist = Categorical(action_probs)
                    action = dist.sample().item()
            else:
                # デフォルトのランダムヒューリスティック(初期学習用)
                action = random.choice([0, 14, random.randint(1, 13)])

            # Do action
            if action == 0: self._handle_pass(p_idx)
            elif 1 <= action <= 13: self._handle_play(p_idx, action, lie=False)
            elif action == 14: self._handle_doubt(p_idx)
            elif 16 <= action <= 28: self._handle_play(p_idx, action-15, lie=True)
            else: self._handle_pass(p_idx) # safely fallback
            
            steps += 1


# ==========================================
# 2. モデルの定義 (Actor-Critic)
# ==========================================
class ActorCriticNet(nn.Module):
    def __init__(self, obs_dim=62, action_dim=29):
        super(ActorCriticNet, self).__init__()
        # 共有のバックボーン
        self.fc1 = nn.Linear(obs_dim, 256)
        self.fc2 = nn.Linear(256, 256)
        
        # Actor: 方策・確率 (Policy)
        self.actor_head = nn.Linear(256, action_dim)
        # Critic: 状態価値 (Value)
        self.critic_head = nn.Linear(256, 1)

    def forward(self, x):
        x = F.relu(self.fc1(x))
        x = F.relu(self.fc2(x))
        
        # アクション確率
        logits = self.actor_head(x)
        action_probs = F.softmax(logits, dim=-1)
        
        # 状態価値
        state_value = self.critic_head(x)
        
        return action_probs, state_value

# ==========================================
# 3. Rollout Buffer (データ収集用)
# ==========================================
class RolloutBuffer:
    def __init__(self):
        self.states = []
        self.actions = []
        self.logprobs = []
        self.rewards = []
        self.is_terminals = []
        self.values = []
        
    def clear(self):
        del self.states[:]
        del self.actions[:]
        del self.logprobs[:]
        del self.rewards[:]
        del self.is_terminals[:]
        del self.values[:]

# ==========================================
# 4. R-NaD / PPO ハイブリッド学習ループ
# ==========================================
class DeepNashAgent:
    def __init__(self, obs_dim, action_dim, lr=3e-4, gamma=0.99, K_epochs=4, eps_clip=0.2, kl_coeff=0.01):
        self.gamma = gamma
        self.eps_clip = eps_clip
        self.K_epochs = K_epochs
        self.kl_coeff = kl_coeff # KL正則化の強さ (R-NaDの肝)
        
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        print(f"Device: {self.device}")
        
        # 現在の学習対象
        self.policy = ActorCriticNet(obs_dim, action_dim).to(self.device)
        self.optimizer = optim.Adam(self.policy.parameters(), lr=lr)
        
        # 過去の方策（参照方策）
        self.ref_policy = ActorCriticNet(obs_dim, action_dim).to(self.device)
        self.ref_policy.load_state_dict(self.policy.state_dict())
        
        # 古い方策（PPO用）
        self.policy_old = ActorCriticNet(obs_dim, action_dim).to(self.device)
        self.policy_old.load_state_dict(self.policy.state_dict())
        
        self.buffer = RolloutBuffer()
        # ロス記録用
        self.loss_history = []

    def select_action(self, state):
        with torch.no_grad():
            state = torch.FloatTensor(state).to(self.device)
            action_probs, state_value = self.policy_old(state)
            
            dist = Categorical(action_probs)
            action = dist.sample()
            logprob = dist.log_prob(action)
            
        self.buffer.states.append(state)
        self.buffer.actions.append(action)
        self.buffer.logprobs.append(logprob)
        self.buffer.values.append(state_value)
        
        return action.item()

    def update(self):
        if len(self.buffer.states) == 0:
            return

        # 報酬の割引計算 (GAEの代わりの単純なリターン計算)
        rewards = []
        discounted_reward = 0
        for reward, is_terminal in zip(reversed(self.buffer.rewards), reversed(self.buffer.is_terminals)):
            if is_terminal:
                discounted_reward = 0
            discounted_reward = reward + (self.gamma * discounted_reward)
            rewards.insert(0, discounted_reward)
            
        # テンソル化
        rewards = torch.tensor(rewards, dtype=torch.float32).to(self.device)
        # 報酬の正規化
        rewards = (rewards - rewards.mean()) / (rewards.std() + 1e-7)
        
        old_states = torch.stack(self.buffer.states).to(self.device).detach()
        old_actions = torch.stack(self.buffer.actions).to(self.device).detach()
        old_logprobs = torch.stack(self.buffer.logprobs).to(self.device).detach()

        # K回エポック最適化 (PPO + R-NaD KL Constraint)
        epoch_loss = 0
        for _ in range(self.K_epochs):
            action_probs, state_values = self.policy(old_states)
            dist = Categorical(action_probs)
            logprobs = dist.log_prob(old_actions)
            dist_entropy = dist.entropy()
            
            # アドバンテージ
            advantages = rewards - state_values.detach().squeeze()

            # PPO 比率
            ratios = torch.exp(logprobs - old_logprobs.detach())

            # ---------------------------------------------
            # R-NaD / DeepNash: KL正則化 (参照方策との距離)
            # ---------------------------------------------
            with torch.no_grad():
                ref_action_probs, _ = self.ref_policy(old_states)
            
            # KL(pi || pi_ref) の計算
            # pi * log(pi / pi_ref)
            kl_div = F.kl_div(ref_action_probs.log(), action_probs, reduction='none').sum(dim=-1)
            
            # 損失計算
            surr1 = ratios * advantages
            surr2 = torch.clamp(ratios, 1 - self.eps_clip, 1 + self.eps_clip) * advantages
            
            # Actor loss は Advantage を最大化し、KLを最小化する
            # (kl_coeffが大きいほど過去の戦略から離れないように制約が働く)
            actor_loss = -torch.min(surr1, surr2).mean() + self.kl_coeff * kl_div.mean()
            # Critic loss は MSE
            critic_loss = F.mse_loss(state_values.squeeze(), rewards)
            
            loss = actor_loss + 0.5 * critic_loss - 0.01 * dist_entropy.mean()
            epoch_loss += loss.item()

            self.optimizer.zero_grad()
            loss.backward()
            self.optimizer.step()
            
        self.loss_history.append(epoch_loss / self.K_epochs)

        # ネットワークの同期 (`policy_old`に反映)
        self.policy_old.load_state_dict(self.policy.state_dict())
        self.buffer.clear()

    def update_reference_policy(self):
        """ R-NaD 用の定期的な参照方策 (Target) の更新 """
        self.ref_policy.load_state_dict(self.policy.state_dict())
        print("--- Updated Reference Policy (KL Target) ---")

def train_self_play_deepnash():
    max_episodes = 20000 
    max_timesteps = 300   # 1手ごとの最大長
    update_timestep = 1000 # Bufferがこれだけ溜まったら更新
    ref_policy_update_eps = 500 # 参照方策の更新頻度
    
    env = DoubtRoyaleEnv(num_players=4)
    obs_dim = 62
    action_dim = env.action_space.n
    
    agent = DeepNashAgent(obs_dim, action_dim)
    
    # 対戦相手のプール (自己対戦)
    opponent_pool = []
    
    time_step = 0
    t_start = time.time()
    
    for ep in range(1, max_episodes + 1):
        # 相手をプールから選ぶ（いなければ初期方策）
        current_opponents = []
        for _ in range(env.num_players): # 自分含め4プレイスロット（0番はagentが入る）
            if len(opponent_pool) > 0:
                opp_policy = random.choice(opponent_pool)
                current_opponents.append(opp_policy)
            else:
                current_opponents.append(agent.policy_old) 
        
        env.opponent_policies = current_opponents
        
        obs, _ = env.reset()
        flat_obs = np.concatenate([obs["hand"], obs["field"], obs["others_count"], obs["status"]]).astype(np.float32)
        
        ep_reward = 0
        for t in range(1, max_timesteps + 1):
            time_step += 1
            
            # Action selection (Actor)
            action = agent.select_action(flat_obs)
            
            # Step env
            next_obs, reward, done, _, _ = env.step(action)
            agent.buffer.rewards.append(reward)
            agent.buffer.is_terminals.append(done)
            
            flat_obs = np.concatenate([next_obs["hand"], next_obs["field"], next_obs["others_count"], next_obs["status"]]).astype(np.float32)
            ep_reward += reward
            
            if time_step % update_timestep == 0:
                agent.update()
                
            if done:
                break
                
        # 定期的な画面出力
        if ep % 100 == 0:
            avg_loss = agent.loss_history[-1] if len(agent.loss_history) > 0 else 0
            print(f"Episode {ep} \t Avg Reward: {ep_reward:.2f} \t Loss: {avg_loss:.4f} \t Pool: {len(opponent_pool)}")
            
        # 参照方策の更新 (KLペナルティのゼロ設定)
        if ep % ref_policy_update_eps == 0:
            agent.update_reference_policy()
            
        # 定期的に相手プールに記録（多様な自己対戦相手の構築）
        if ep % 1000 == 0:
            new_opp = ActorCriticNet(obs_dim, action_dim).to(agent.device)
            new_opp.load_state_dict(agent.policy.state_dict())
            new_opp.eval()
            opponent_pool.append(new_opp)
            # プールが大きくなりすぎないように維持
            if len(opponent_pool) > 10:
                opponent_pool.pop(0)

    # ==========================
    # 5. モデル出力 (ONNX変換)
    # ==========================
    print("Exporting trained model to ONNX...")
    agent.policy.eval()
    dummy_input = torch.randn(1, obs_dim).to(agent.device)
    torch.onnx.export(
        agent.policy, 
        dummy_input, 
        "doubt_royale_deepnash_latest.onnx", 
        input_names=['input'], 
        output_names=['action_probs', 'state_value'],
        opset_version=11
    )
    
    # サーバー用には Actor 部のみ（確率）が必要かも、現状は両方出力される
    torch.save(agent.policy.state_dict(), "deepnash_policy.pth")
    print(f"Training finished in {(time.time() - t_start)/60:.2f} minutes.")
    print("Files 'deepnash_policy.pth' and 'doubt_royale_deepnash_latest.onnx' are generated.")

if __name__ == '__main__':
    train_self_play_deepnash()
