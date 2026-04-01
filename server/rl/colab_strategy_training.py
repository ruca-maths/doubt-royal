"""
Google Colab 用 Doubt Royale 統計学習スクリプト
【Phase 4: データ蓄積型戦略立案 AI + ONNX ハイブリッド】

■ 特徴:
  - 大量シミュレーションで統計データを蓄積 (strategy_data_v1.json)
  - 統計データで軽量ニューラルネットも同時学習 → ONNX出力
  - 1000エピソードごとに Google Drive へ自動保存
  - 1000エピソードごとに ONNX ファイルを生成
  - 100エピソードごとに進捗表示
  - 動的報酬系: 学習中に報酬重みを自動最適化

■ 使い方 (Google Colab):
  1. このセル全体をコピー&ペースト
  2. ランタイム → すべてのセルを実行
  3. Google Drive へのアクセスを許可
  4. 学習が完了するまで待機（中断しても1000ep毎に保存済み）
"""

# ==========================================
# 0. セットアップ
# ==========================================
import os
import sys
import json
import time
import copy
import random
import numpy as np
from collections import defaultdict
from typing import Dict, List, Tuple, Optional, Any

# --- Google Drive マウント ---
try:
    from google.colab import drive
    drive.mount('/content/drive')
    DRIVE_DIR = '/content/drive/MyDrive/doubt_royale_ai'
    os.makedirs(DRIVE_DIR, exist_ok=True)
    IN_COLAB = True
    print(f"✅ Google Drive マウント完了: {DRIVE_DIR}")
except Exception:
    DRIVE_DIR = '.'
    IN_COLAB = False
    print("⚠️ Google Colab 外で実行中。ローカル保存モード。")

# --- PyTorch ---
try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    import torch.optim as optim
    HAS_TORCH = True
    DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"✅ PyTorch 利用可能 (Device: {DEVICE})")
except ImportError:
    HAS_TORCH = False
    DEVICE = None
    print("⚠️ PyTorch 未インストール。統計データのみ収集します。")

# ==========================================
# 1. カード・デッキ定義
# ==========================================
class Card:
    __slots__ = ['suit', 'number', 'id', 'is_joker', 'is_face_up']

    def __init__(self, suit: int, number: int, card_id: str, is_joker: bool = False):
        self.suit = suit
        self.number = number
        self.id = card_id
        self.is_joker = is_joker
        self.is_face_up = False

    def __repr__(self):
        if self.is_joker:
            return f"Jo"
        suits = ['♠','♥','♦','♣']
        names = ['','A','2','3','4','5','6','7','8','9','10','J','Q','K']
        return f"{suits[self.suit]}{names[self.number]}"

    @property
    def effective_number(self) -> int:
        return 0 if self.is_joker else self.number


def create_deck() -> List[Card]:
    deck = []
    for suit in range(4):
        for num in range(1, 14):
            deck.append(Card(suit, num, f"card-{len(deck)}"))
    deck.append(Card(-1, 0, "card-52", is_joker=True))
    deck.append(Card(-1, 0, "card-53", is_joker=True))
    return deck


def get_card_strength(number: int, is_revolution: bool, is_eleven_back: bool) -> int:
    if number == 0:
        return 100
    is_reversed = is_revolution != is_eleven_back
    normal_strength = (number - 3 + 13) % 13
    return (12 - normal_strength) if is_reversed else normal_strength


def check_forbidden_finish(declared_number: int, is_revolution: bool) -> bool:
    if declared_number == 0: return True
    if declared_number == 8: return True
    if not is_revolution and declared_number == 2: return True
    if is_revolution and declared_number == 3: return True
    return False


# ==========================================
# 2. ゲームシミュレーション環境
# ==========================================
class DoubtRoyaleSimEnv:
    """高速シミュレーション環境"""

    def __init__(self, num_players: int = 4):
        self.num_players = num_players
        self.reset()

    def reset(self):
        deck = create_deck()
        random.shuffle(deck)
        self.hands: List[List[Card]] = [[] for _ in range(self.num_players)]
        for i, card in enumerate(deck):
            self.hands[i % self.num_players].append(card)

        self.current_player = 0
        self.field_number = 0
        self.field_count = 0
        self.field_cards: List[Card] = []
        self.field_last_player = -1
        self.is_revolution = False
        self.is_eleven_back = False
        self.player_lives = [3] * self.num_players
        self.player_out = [False] * self.num_players
        self.face_up_pool: List[Card] = []
        self.card_history: List[Card] = []
        self.pass_count = 0
        self.finish_order: List[int] = []
        self.turn_count = 0
        self.play_log: List[Dict] = []
        return self

    def get_state_vector(self, player_idx: int) -> np.ndarray:
        """62次元の状態ベクトル (サーバーのai.tsと互換)"""
        vec = np.zeros(62, dtype=np.float32)
        # 手札 (0-53)
        for c in self.hands[player_idx]:
            idx = int(c.id.split("-")[1])
            if 0 <= idx < 54:
                vec[idx] = 1.0
        # フィールド (54-56)
        vec[54] = self.field_number
        vec[55] = self.field_count
        if self.field_last_player != -1:
            vec[56] = (self.field_last_player - player_idx + self.num_players) % self.num_players
        else:
            vec[56] = -1
        # 他プレイヤーの枚数 (57-59)
        j = 0
        for i in range(self.num_players):
            if i != player_idx:
                vec[57 + j] = len(self.hands[i])
                j += 1
        # ステータス (60-61)
        vec[60] = 1.0 if self.is_revolution else 0.0
        vec[61] = 1.0 if self.is_eleven_back else 0.0
        return vec

    def get_playable_numbers(self, player_idx: int) -> List[int]:
        hand = self.hands[player_idx]
        if not hand:
            return []
        hand_numbers = set(c.effective_number for c in hand)
        is_lead = (self.field_count == 0 or self.field_last_player == -1
                   or self.field_last_player == player_idx)
        if is_lead:
            return sorted(hand_numbers)
        playable = []
        field_str = get_card_strength(self.field_number, self.is_revolution, self.is_eleven_back)
        for num in hand_numbers:
            s = get_card_strength(num, self.is_revolution, self.is_eleven_back)
            if s > field_str:
                if not (self.field_number == 0 and num == 0):
                    playable.append(num)
        return sorted(playable)

    def count_cards(self, player_idx: int, number: int) -> int:
        return sum(1 for c in self.hands[player_idx] if c.effective_number == number)

    def play_cards(self, player_idx: int, declared_num: int, is_lie: bool = False) -> bool:
        hand = self.hands[player_idx]
        if not hand:
            return False

        is_lead = (self.field_count == 0 or self.field_last_player == -1
                   or self.field_last_player == player_idx)
        target_count = 1 if is_lead else self.field_count

        if not is_lie:
            matching = [c for c in hand if c.effective_number == declared_num]
            if len(matching) < target_count:
                return False
            cards = matching[:target_count]
        else:
            others = [c for c in hand if c.effective_number != declared_num]
            if len(others) < target_count:
                others = list(hand)
            cards = others[:target_count]

        if not cards:
            return False

        card_ids = {c.id for c in cards}
        actual_nums = [c.effective_number for c in cards]

        self.play_log.append({
            'player': player_idx,
            'declared': declared_num,
            'actual_numbers': actual_nums,
            'is_lie': is_lie or any(n != declared_num for n in actual_nums),
            'card_count': len(cards),
            'field_was_empty': is_lead,
            'hand_size_before': len(hand),
        })

        self.hands[player_idx] = [c for c in hand if c.id not in card_ids]
        self.card_history.extend(self.field_cards)
        self.field_cards = cards
        self.field_number = declared_num
        self.field_count = len(cards)
        self.field_last_player = player_idx
        self.pass_count = 0

        # 簡易エフェクト
        if declared_num == 8:
            self._clear_field()
        elif declared_num == 11:
            self.is_eleven_back = True
        if len(cards) >= 4:
            self.is_revolution = not self.is_revolution

        # 手札0枚チェック
        if not self.hands[player_idx] and not self.player_out[player_idx]:
            if check_forbidden_finish(declared_num, self.is_revolution):
                self.player_out[player_idx] = True  # 禁止上がり
            else:
                self.finish_order.append(player_idx)
                self.player_out[player_idx] = True

        self._advance()
        return True

    def do_pass(self, player_idx: int):
        self.pass_count += 1
        self._advance()
        active = sum(1 for i in range(self.num_players) if not self.player_out[i])
        if self.pass_count >= active - 1 and self.field_last_player != -1:
            self._clear_field()

    def do_doubt(self, doubter_idx: int) -> bool:
        if self.field_last_player in (-1, doubter_idx):
            return False
        liar_idx = self.field_last_player
        is_lie = any(c.effective_number != self.field_number for c in self.field_cards)
        if is_lie:
            self.hands[liar_idx].extend(self.field_cards)
            self.player_lives[liar_idx] -= 1
            if self.player_lives[liar_idx] <= 0:
                self.player_out[liar_idx] = True
        else:
            self.hands[doubter_idx].extend(self.field_cards)
            self.player_lives[doubter_idx] -= 1
            if self.player_lives[doubter_idx] <= 0:
                self.player_out[doubter_idx] = True
            for c in self.field_cards:
                c.is_face_up = True
            self.face_up_pool.extend(self.field_cards)
        self.field_cards = []
        self._clear_field()
        return is_lie

    def _clear_field(self):
        self.card_history.extend(self.field_cards)
        self.field_cards = []
        self.field_number = 0
        self.field_count = 0
        self.field_last_player = -1
        self.pass_count = 0
        self.is_eleven_back = False

    def _advance(self):
        for _ in range(self.num_players):
            self.current_player = (self.current_player + 1) % self.num_players
            if not self.player_out[self.current_player] and self.hands[self.current_player]:
                break
        self.turn_count += 1

    def is_game_over(self) -> bool:
        active = sum(1 for i in range(self.num_players) if not self.player_out[i])
        return active <= 1 or self.turn_count > 500

    def get_winner(self) -> int:
        if self.finish_order:
            return self.finish_order[0]
        for i in range(self.num_players):
            if not self.player_out[i]:
                return i
        return 0

    def get_face_up_count(self, number: int) -> int:
        return sum(1 for c in self.face_up_pool if c.effective_number == number)


# ==========================================
# 3. ニューラルネットワーク (ONNX出力用)
# ==========================================
if HAS_TORCH:
    class StrategyNet(nn.Module):
        """統計データと並行して学習するネットワーク"""

        def __init__(self, obs_dim=62, action_dim=29, hidden=256):
            super().__init__()
            self.fc1 = nn.Linear(obs_dim, hidden)
            self.fc2 = nn.Linear(hidden, hidden)
            self.fc3 = nn.Linear(hidden, hidden // 2)
            self.actor = nn.Linear(hidden // 2, action_dim)
            self.critic = nn.Linear(hidden // 2, 1)

        def forward(self, x):
            x = F.relu(self.fc1(x))
            x = F.relu(self.fc2(x))
            x = F.relu(self.fc3(x))
            action_probs = F.softmax(self.actor(x), dim=-1)
            state_value = self.critic(x)
            return action_probs, state_value


# ==========================================
# 4. 動的報酬システム
# ==========================================
class DynamicRewardSystem:
    """学習中に報酬の重みを自動調整するシステム"""

    def __init__(self):
        # 初期報酬重み
        self.weights = {
            'honest_play':   0.10,   # 正直なプレイ
            'bluff_success': 0.20,   # ブラフ成功
            'bluff_caught':  -0.30,  # ブラフがバレた
            'doubt_success': 1.00,   # ダウト成功
            'doubt_failure': -1.00,  # ダウト失敗
            'win':           10.0,   # 勝利
            'lose':          -5.0,   # 敗北
            'pass':          -0.02,  # パス（微小ペナルティ）
            'card_reduction': 0.05,  # カード減少ボーナス
            'invalid_action': -0.15, # 無効アクション
        }
        # パフォーマンス追跡
        self.window_size = 500
        self.recent_wins: List[bool] = []
        self.recent_rewards: List[float] = []
        self.adjustment_history: List[Dict] = []
        self.last_adjustment_ep = 0

    def get_reward(self, event: str, **kwargs) -> float:
        base = self.weights.get(event, 0.0)
        # カード減少ボーナス: 手札が減るほど加算
        if event == 'card_reduction' and 'cards_left' in kwargs:
            cards_left = kwargs['cards_left']
            if cards_left <= 3:
                base *= 3.0
            elif cards_left <= 7:
                base *= 1.5
        return base

    def record_game(self, won: bool, total_reward: float):
        self.recent_wins.append(won)
        self.recent_rewards.append(total_reward)
        if len(self.recent_wins) > self.window_size:
            self.recent_wins.pop(0)
            self.recent_rewards.pop(0)

    def maybe_adjust(self, episode: int) -> Optional[Dict]:
        """500エピソードごとに報酬重みを調整"""
        if episode - self.last_adjustment_ep < 500:
            return None
        if len(self.recent_wins) < 200:
            return None

        self.last_adjustment_ep = episode
        win_rate = sum(self.recent_wins) / len(self.recent_wins)
        avg_reward = sum(self.recent_rewards) / len(self.recent_rewards)

        adjustments = {}

        # 勝率が低い → ブラフを抑えて安全策
        if win_rate < 0.20:
            self.weights['bluff_success'] *= 0.9
            self.weights['honest_play'] *= 1.1
            self.weights['doubt_success'] *= 1.05
            adjustments['reason'] = 'low_winrate_conservative'
        # 勝率が高い → さらに攻撃的に
        elif win_rate > 0.35:
            self.weights['bluff_success'] *= 1.1
            self.weights['doubt_success'] *= 1.05
            self.weights['card_reduction'] *= 1.1
            adjustments['reason'] = 'high_winrate_aggressive'

        # 報酬が低すぎる → ペナルティ軽減
        if avg_reward < -2.0:
            self.weights['doubt_failure'] *= 0.9
            self.weights['bluff_caught'] *= 0.9
            self.weights['lose'] *= 0.9
            adjustments['penalty_reduced'] = True

        # 報酬が高すぎる → ペナルティ強化
        if avg_reward > 5.0:
            self.weights['doubt_failure'] *= 1.1
            self.weights['bluff_caught'] *= 1.1
            adjustments['penalty_increased'] = True

        # クリッピング
        for k in self.weights:
            if self.weights[k] > 0:
                self.weights[k] = min(self.weights[k], 20.0)
                self.weights[k] = max(self.weights[k], 0.01)
            else:
                self.weights[k] = max(self.weights[k], -20.0)
                self.weights[k] = min(self.weights[k], -0.01)

        adjustments['episode'] = episode
        adjustments['win_rate'] = round(win_rate, 4)
        adjustments['avg_reward'] = round(avg_reward, 4)
        adjustments['weights_snapshot'] = {k: round(v, 4) for k, v in self.weights.items()}
        self.adjustment_history.append(adjustments)

        return adjustments


# ==========================================
# 5. 統計データ蓄積器
# ==========================================
class StatisticsCollector:

    def __init__(self):
        self.lie_stats: Dict[str, List[int]] = defaultdict(lambda: [0, 0])
        self.bluff_stats: Dict[str, List[int]] = defaultdict(lambda: [0, 0])
        self.doubt_perf: Dict[str, List[float]] = defaultdict(lambda: [0.0, 0.0, 0.0])
        self.sequence_wins: Dict[str, List[int]] = defaultdict(lambda: [0, 0])
        self.counter_stats = [0, 0, 0]

    def record_play(self, log: Dict, was_doubted: bool, doubt_success: bool):
        d = log['declared']
        cnt = log['card_count']
        empty = 'empty' if log['field_was_empty'] else 'nonempty'
        key = f"{d}_{cnt}_{empty}"
        self.lie_stats[key][0] += 1
        if log['is_lie']:
            self.lie_stats[key][1] += 1
        if log['is_lie']:
            hs = log.get('hand_size_before', 10)
            bucket = 'small' if hs <= 5 else ('medium' if hs <= 10 else 'large')
            bk = f"{d}_{bucket}"
            self.bluff_stats[bk][0] += 1
            if not was_doubted:
                self.bluff_stats[bk][1] += 1

    def record_doubt(self, threshold: float, success: bool, reward: float):
        bucket = f"{threshold:.2f}"
        self.doubt_perf[bucket][0] += 1
        if success:
            self.doubt_perf[bucket][1] += 1
        self.doubt_perf[bucket][2] += reward

    def record_game(self, strategy: str, won: bool):
        self.sequence_wins[strategy][0] += 1
        if won:
            self.sequence_wins[strategy][1] += 1

    def export(self) -> Dict:
        lie_prob = {}
        for k, (t, l) in self.lie_stats.items():
            if t >= 10:
                lie_prob[k] = round(l / t, 4)

        bluff_rate = {}
        for k, (t, s) in self.bluff_stats.items():
            if t >= 10:
                bluff_rate[k] = round(s / t, 4)

        best_thresh = 0.15
        best_reward = float('-inf')
        for bucket, (total, succ, rew) in self.doubt_perf.items():
            if total >= 20:
                avg = rew / total
                if avg > best_reward:
                    best_reward = avg
                    best_thresh = float(bucket)

        seq_w = {}
        for s, (t, w) in self.sequence_wins.items():
            if t >= 10:
                seq_w[s] = round(w / t, 4)

        bluff_vals = [v for v in bluff_rate.values() if v > 0]
        bluff_thresh = round(float(np.median(bluff_vals)), 4) if bluff_vals else 0.5

        return {
            "version": 1,
            "doubt_threshold": round(best_thresh, 4),
            "bluff_threshold": bluff_thresh,
            "lie_probability": lie_prob,
            "bluff_success_rate": bluff_rate,
            "play_sequence_weights": seq_w,
            "counter_stats": {
                "opportunities": self.counter_stats[0],
                "counter_count": self.counter_stats[1],
                "success_after": self.counter_stats[2],
            },
            "total_samples": {
                "lie_entries": len(self.lie_stats),
                "bluff_entries": len(self.bluff_stats),
                "doubt_entries": len(self.doubt_perf),
            },
        }


# ==========================================
# 6. プレイヤーポリシー (自己対戦相手)
# ==========================================
class HeuristicPolicy:
    def __init__(self):
        self.doubt_threshold = random.uniform(0.05, 0.40)
        self.bluff_rate = random.uniform(0.05, 0.40)

    def decide(self, env: DoubtRoyaleSimEnv, idx: int) -> Dict:
        hand = env.hands[idx]
        if not hand:
            return {'type': 'pass'}

        is_lead = (env.field_count == 0 or env.field_last_player == -1
                   or env.field_last_player == idx)

        # ダウト判断
        if not is_lead and env.field_last_player != -1 and env.field_last_player != idx:
            d = env.field_number
            if d != 0:
                fup = env.get_face_up_count(d)
                own = env.count_cards(idx, d)
                if fup + own >= 4:
                    return {'type': 'doubt'}
            if random.random() < self.doubt_threshold:
                return {'type': 'doubt'}

        # 正直プレイ
        playable = env.get_playable_numbers(idx)
        target_count = 1 if is_lead else env.field_count

        honest = [n for n in playable if env.count_cards(idx, n) >= target_count]
        safe = [n for n in honest
                if not (len(hand) - target_count == 0 and check_forbidden_finish(n, env.is_revolution))]

        if safe:
            return {'type': 'play', 'number': safe[0], 'lie': False}
        if honest:
            return {'type': 'play', 'number': honest[0], 'lie': False}

        # ブラフ
        if not is_lead and random.random() < self.bluff_rate and len(hand) >= target_count:
            field_str = get_card_strength(env.field_number, env.is_revolution, env.is_eleven_back)
            bluff_nums = [n for n in range(1, 14)
                          if get_card_strength(n, env.is_revolution, env.is_eleven_back) > field_str
                          and env.field_number != 0]
            if env.field_number != 0:
                bluff_nums.append(0)
            if bluff_nums:
                return {'type': 'play', 'number': random.choice(bluff_nums), 'lie': True}

        if is_lead and playable:
            return {'type': 'play', 'number': playable[0], 'lie': False}

        return {'type': 'pass'}


# ==========================================
# 7. 学習エージェント (NN + 統計)
# ==========================================
if HAS_TORCH:
    class StrategyAgent:
        def __init__(self, obs_dim=62, action_dim=29, lr=3e-4, gamma=0.99):
            self.obs_dim = obs_dim
            self.action_dim = action_dim
            self.gamma = gamma
            self.policy = StrategyNet(obs_dim, action_dim).to(DEVICE)
            self.optimizer = optim.Adam(self.policy.parameters(), lr=lr)
            self.ref_policy = StrategyNet(obs_dim, action_dim).to(DEVICE)
            self.ref_policy.load_state_dict(self.policy.state_dict())
            # バッファ
            self.states = []
            self.actions = []
            self.logprobs = []
            self.rewards = []
            self.dones = []
            self.kl_coeff = 0.01

        def select_action(self, state_vec: np.ndarray) -> int:
            with torch.no_grad():
                s = torch.FloatTensor(state_vec).unsqueeze(0).to(DEVICE)
                probs, _ = self.policy(s)
                from torch.distributions import Categorical
                dist = Categorical(probs)
                action = dist.sample()
                self.states.append(s.squeeze(0))
                self.actions.append(action)
                self.logprobs.append(dist.log_prob(action))
            return action.item()

        def store(self, reward: float, done: bool):
            self.rewards.append(reward)
            self.dones.append(done)

        def update(self):
            if len(self.states) == 0:
                return 0.0
            # バッファの長さを揃える (安全対策)
            min_len = min(len(self.states), len(self.rewards), len(self.dones))
            if min_len == 0:
                self.states.clear()
                self.actions.clear()
                self.logprobs.clear()
                self.rewards.clear()
                self.dones.clear()
                return 0.0
            states = self.states[:min_len]
            actions = self.actions[:min_len]
            logprobs = self.logprobs[:min_len]
            rewards_list = self.rewards[:min_len]
            dones_list = self.dones[:min_len]

            # 割引報酬
            returns = []
            R = 0
            for r, d in zip(reversed(rewards_list), reversed(dones_list)):
                if d: R = 0
                R = r + self.gamma * R
                returns.insert(0, R)
            returns = torch.tensor(returns, dtype=torch.float32).to(DEVICE)
            if len(returns) > 1:
                returns = (returns - returns.mean()) / (returns.std() + 1e-7)

            old_states = torch.stack(states).to(DEVICE)
            old_actions = torch.stack(actions).to(DEVICE)
            old_logprobs = torch.stack(logprobs).to(DEVICE)

            # PPO + KL
            for _ in range(4):
                probs, values = self.policy(old_states)
                from torch.distributions import Categorical
                dist = Categorical(probs)
                new_logprobs = dist.log_prob(old_actions)
                entropy = dist.entropy()

                ratios = torch.exp(new_logprobs - old_logprobs.detach())
                values_sq = values.squeeze(-1)  # (N,) に確実にする
                advantages = returns - values_sq.detach()

                surr1 = ratios * advantages
                surr2 = torch.clamp(ratios, 0.8, 1.2) * advantages

                # KL正則化
                with torch.no_grad():
                    ref_probs, _ = self.ref_policy(old_states)
                kl = F.kl_div(ref_probs.log(), probs, reduction='none').sum(-1)

                loss = (-torch.min(surr1, surr2).mean()
                        + 0.5 * F.mse_loss(values_sq, returns)
                        - 0.01 * entropy.mean()
                        + self.kl_coeff * kl.mean())

                self.optimizer.zero_grad()
                loss.backward()
                torch.nn.utils.clip_grad_norm_(self.policy.parameters(), 0.5)
                self.optimizer.step()

            loss_val = loss.item()
            self.states.clear()
            self.actions.clear()
            self.logprobs.clear()
            self.rewards.clear()
            self.dones.clear()
            return loss_val

        def update_ref(self):
            self.ref_policy.load_state_dict(self.policy.state_dict())

        def action_to_game(self, action: int, env: DoubtRoyaleSimEnv, idx: int) -> Dict:
            """NNのアクションをゲームアクションに変換"""
            if action == 0:
                return {'type': 'pass'}
            elif action == 14:
                return {'type': 'doubt'}
            elif 1 <= action <= 13:
                return {'type': 'play', 'number': action, 'lie': False}
            elif 16 <= action <= 28:
                return {'type': 'play', 'number': action - 15, 'lie': True}
            return {'type': 'pass'}

        def export_onnx(self, filepath: str):
            self.policy.eval()
            dummy = torch.randn(1, self.obs_dim).to(DEVICE)
            torch.onnx.export(
                self.policy, dummy, filepath,
                input_names=['input'],
                output_names=['action_probs', 'state_value'],
                opset_version=11,
                dynamic_axes={'input': {0: 'batch'}, 'action_probs': {0: 'batch'}, 'state_value': {0: 'batch'}}
            )
            self.policy.train()

        def save_checkpoint(self, filepath: str):
            torch.save({
                'policy_state': self.policy.state_dict(),
                'ref_state': self.ref_policy.state_dict(),
                'optimizer_state': self.optimizer.state_dict(),
            }, filepath)

        def load_checkpoint(self, filepath: str):
            ckpt = torch.load(filepath, map_location=DEVICE)
            self.policy.load_state_dict(ckpt['policy_state'])
            self.ref_policy.load_state_dict(ckpt['ref_state'])
            self.optimizer.load_state_dict(ckpt['optimizer_state'])
            print(f"✅ チェックポイント復元: {filepath}")


# ==========================================
# 8. ゲームシミュレーション
# ==========================================
def categorize_hand(hand: List[Card], is_revolution: bool) -> str:
    numbers = defaultdict(int)
    for c in hand:
        numbers[c.effective_number] += 1
    has_joker = numbers.get(0, 0) > 0
    has_eight = numbers.get(8, 0) > 0
    has_strong = sum(1 for n in [1, 2] if numbers.get(n, 0) > 0)
    has_effects = sum(1 for n in [6, 7, 10, 12] if numbers.get(n, 0) > 0)
    if is_revolution:
        return "strong_first"
    elif has_eight and has_effects >= 2:
        return "effect_first"
    elif has_strong >= 2 or has_joker:
        return "save_strong"
    return "low_first"


def execute_action(env: DoubtRoyaleSimEnv, idx: int, action: Dict) -> Tuple[bool, Optional[bool]]:
    """
    アクション実行。Returns: (action_taken, doubt_result_or_None)
    """
    if action['type'] == 'doubt':
        success = env.do_doubt(idx)
        return True, success
    elif action['type'] == 'play':
        played = env.play_cards(idx, action['number'], action.get('lie', False))
        if not played:
            env.do_pass(idx)
        return played, None
    else:
        env.do_pass(idx)
        return False, None


def run_episode(agent, collector: StatisticsCollector,
                reward_sys: DynamicRewardSystem,
                opponent_policies: List[HeuristicPolicy]) -> Tuple[float, bool]:
    """1エピソード実行。Returns: (total_reward, won)"""
    env = DoubtRoyaleSimEnv(4)

    strategy = categorize_hand(env.hands[0], env.is_revolution)
    total_reward = 0.0
    initial_hand_size = len(env.hands[0])

    while not env.is_game_over():
        p = env.current_player

        if p == 0:
            # エージェント (プレイヤー0)
            state = env.get_state_vector(0)

            if HAS_TORCH and agent is not None:
                raw_action = agent.select_action(state)
                action = agent.action_to_game(raw_action, env, 0)
            else:
                # NN無し → ヒューリスティック
                policy = HeuristicPolicy()
                action = policy.decide(env, 0)

            # リード時にパス不可
            is_lead = (env.field_count == 0 or env.field_last_player == -1
                       or env.field_last_player == 0)
            if action['type'] == 'pass' and is_lead and env.hands[0]:
                playable = env.get_playable_numbers(0)
                if playable:
                    action = {'type': 'play', 'number': playable[0], 'lie': False}
                elif env.hands[0]:
                    c = env.hands[0][0]
                    action = {'type': 'play', 'number': c.effective_number, 'lie': False}

            log_before = len(env.play_log)
            taken, doubt_result = execute_action(env, 0, action)

            # 報酬計算
            reward = 0.0
            if action['type'] == 'doubt':
                if doubt_result is True:
                    reward = reward_sys.get_reward('doubt_success')
                    if log_before > 0:
                        collector.record_doubt(
                            opponent_policies[0].doubt_threshold if opponent_policies else 0.15,
                            True, reward)
                elif doubt_result is False:
                    reward = reward_sys.get_reward('doubt_failure')
                    if log_before > 0:
                        collector.record_doubt(
                            opponent_policies[0].doubt_threshold if opponent_policies else 0.15,
                            False, reward)
            elif action['type'] == 'play':
                if taken:
                    if action.get('lie', False):
                        reward = reward_sys.get_reward('bluff_success')
                    else:
                        reward = reward_sys.get_reward('honest_play')
                    reward += reward_sys.get_reward('card_reduction',
                                                    cards_left=len(env.hands[0]))
                else:
                    reward = reward_sys.get_reward('invalid_action')
            else:
                reward = reward_sys.get_reward('pass')

            # プレイログ記録
            if len(env.play_log) > log_before:
                new_log = env.play_log[-1]
                collector.record_play(new_log, was_doubted=False, doubt_success=False)

            total_reward += reward
            if HAS_TORCH and agent is not None:
                agent.store(reward, env.is_game_over())

        else:
            # 相手: ヒューリスティック
            opp_idx = p - 1 if p - 1 < len(opponent_policies) else 0
            opp_policy = opponent_policies[opp_idx] if opponent_policies else HeuristicPolicy()
            action = opp_policy.decide(env, p)

            log_before = len(env.play_log)
            execute_action(env, p, action)

            # 相手のプレイも統計記録
            if len(env.play_log) > log_before:
                new_log = env.play_log[-1]
                was_doubted = (action['type'] == 'doubt')
                collector.record_play(new_log, was_doubted=False, doubt_success=False)

    # 勝敗報酬
    won = (env.get_winner() == 0)
    end_reward = reward_sys.get_reward('win') if won else reward_sys.get_reward('lose')
    total_reward += end_reward

    # 最後のステップの報酬に勝敗報酬を加算 (バッファ不整合を防ぐ)
    if HAS_TORCH and agent is not None and len(agent.rewards) > 0:
        agent.rewards[-1] += end_reward
        agent.dones[-1] = True

    collector.record_game(strategy, won)
    reward_sys.record_game(won, total_reward)
    return total_reward, won


# ==========================================
# 9. 保存・復元ユーティリティ
# ==========================================
def save_all(agent, collector: StatisticsCollector,
             reward_sys: DynamicRewardSystem,
             episode: int, elapsed: float):
    """Drive (またはローカル) に全データ保存"""

    # 統計データ JSON
    data = collector.export()
    data["training_info"] = {
        "total_episodes": episode,
        "training_time_sec": round(elapsed, 1),
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "reward_weights": {k: round(v, 4) for k, v in reward_sys.weights.items()},
        "reward_adjustments": reward_sys.adjustment_history[-3:],  # 直近3回分
    }

    json_path = os.path.join(DRIVE_DIR, 'strategy_data_v1.json')
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    # ONNX
    if HAS_TORCH and agent is not None:
        onnx_path = os.path.join(DRIVE_DIR, f'doubt_royale_v14_latest.onnx')
        agent.export_onnx(onnx_path)

        onnx_versioned = os.path.join(DRIVE_DIR, f'doubt_royale_v14_ep{episode}.onnx')
        agent.export_onnx(onnx_versioned)

        ckpt_path = os.path.join(DRIVE_DIR, 'checkpoint_latest.pth')
        agent.save_checkpoint(ckpt_path)

    print(f"  💾 保存完了 → {DRIVE_DIR}")
    print(f"     strategy_data_v1.json ({len(data['lie_probability'])} lie entries)")
    if HAS_TORCH and agent is not None:
        print(f"     doubt_royale_v14_latest.onnx")
        print(f"     doubt_royale_v14_ep{episode}.onnx")
        print(f"     checkpoint_latest.pth")


def try_restore(agent) -> int:
    """チェックポイントからの復元を試みる。復元したエピソード番号を返す"""
    ckpt_path = os.path.join(DRIVE_DIR, 'checkpoint_latest.pth')
    json_path = os.path.join(DRIVE_DIR, 'strategy_data_v1.json')

    start_ep = 0
    if HAS_TORCH and agent is not None and os.path.exists(ckpt_path):
        try:
            agent.load_checkpoint(ckpt_path)
        except Exception as e:
            print(f"⚠️ チェックポイント復元失敗: {e}")

    if os.path.exists(json_path):
        try:
            with open(json_path, 'r') as f:
                data = json.load(f)
            start_ep = data.get('training_info', {}).get('total_episodes', 0)
            print(f"✅ 前回の学習データ検出: {start_ep}エピソード完了済み")
        except Exception:
            pass

    return start_ep


# ==========================================
# 10. メイン学習ループ
# ==========================================
def train(total_episodes: int = 50000):
    print("=" * 60)
    print("  Doubt Royale - データ蓄積型 AI 学習")
    print(f"  目標エピソード数: {total_episodes:,}")
    print(f"  保存先: {DRIVE_DIR}")
    print(f"  PyTorch: {'✅' if HAS_TORCH else '❌'}")
    print(f"  Device: {DEVICE}")
    print("=" * 60)

    collector = StatisticsCollector()
    reward_sys = DynamicRewardSystem()

    agent = None
    if HAS_TORCH:
        agent = StrategyAgent(obs_dim=62, action_dim=29)

    # 復元を試みる
    start_ep = try_restore(agent)

    # 対戦相手プール
    opponent_pool: List[List[HeuristicPolicy]] = []

    t_start = time.time()
    win_count = 0
    total_reward_sum = 0.0
    update_step = 0
    loss_sum = 0.0
    loss_count = 0

    for ep in range(start_ep + 1, start_ep + total_episodes + 1):
        # 多様な相手を生成
        opponents = [HeuristicPolicy() for _ in range(3)]

        # エピソード実行
        ep_reward, won = run_episode(agent, collector, reward_sys, opponents)

        if won:
            win_count += 1
        total_reward_sum += ep_reward
        update_step += 1

        # NN更新 (200ステップごと)
        if HAS_TORCH and agent is not None and update_step >= 200:
            loss = agent.update()
            loss_sum += loss
            loss_count += 1
            update_step = 0

        # 参照方策更新 (1000エピソードごと)
        if HAS_TORCH and agent is not None and ep % 1000 == 0:
            agent.update_ref()

        # 動的報酬調整
        adj = reward_sys.maybe_adjust(ep)
        if adj:
            print(f"\n  🔧 報酬調整 (EP {ep}): WR={adj['win_rate']:.1%}, "
                  f"AvgR={adj['avg_reward']:.2f}, {adj.get('reason','')}")

        # --- 100エピソードごとの進捗表示 ---
        if ep % 100 == 0:
            elapsed = time.time() - t_start
            speed = (ep - start_ep) / elapsed if elapsed > 0 else 0
            recent_wr = sum(reward_sys.recent_wins[-100:]) / max(len(reward_sys.recent_wins[-100:]), 1)
            avg_r = total_reward_sum / max(ep - start_ep, 1)
            avg_loss = loss_sum / max(loss_count, 1)

            bar_total = 30
            progress = (ep - start_ep) / total_episodes
            bar_fill = int(bar_total * progress)
            bar = '█' * bar_fill + '░' * (bar_total - bar_fill)

            print(f"  [{bar}] EP {ep:>7,} | "
                  f"{speed:.0f} ep/s | "
                  f"WR(100)={recent_wr:.1%} | "
                  f"AvgR={avg_r:.2f} | "
                  f"Loss={avg_loss:.4f} | "
                  f"Lies={len(collector.lie_stats)} | "
                  f"DT={reward_sys.weights.get('doubt_success', 1):.2f}")

        # --- 1000エピソードごとの自動保存 ---
        if ep % 1000 == 0:
            elapsed = time.time() - t_start
            print(f"\n  📦 チェックポイント保存 (EP {ep})...")
            save_all(agent, collector, reward_sys, ep, elapsed)
            print()

    # 最終保存
    elapsed = time.time() - t_start
    print(f"\n{'=' * 60}")
    print(f"  学習完了！ {elapsed:.1f}秒 ({(start_ep + total_episodes) / elapsed:.0f} ep/s)")
    print(f"  総勝利数: {win_count}/{total_episodes} ({win_count/total_episodes:.1%})")
    print(f"{'=' * 60}")

    save_all(agent, collector, reward_sys, start_ep + total_episodes, elapsed)

    # 最終データサマリー
    final = collector.export()
    print(f"\n  📊 統計データサマリー:")
    print(f"     嘘確率エントリ: {len(final['lie_probability'])}")
    print(f"     ブラフ成功率エントリ: {len(final['bluff_success_rate'])}")
    print(f"     出し順勝率エントリ: {len(final['play_sequence_weights'])}")
    print(f"     最適ダウト閾値: {final['doubt_threshold']}")
    print(f"     ブラフ閾値: {final['bluff_threshold']}")

    print(f"\n  🔧 最終報酬ウェイト:")
    for k, v in reward_sys.weights.items():
        print(f"     {k}: {v:.4f}")

    print(f"\n  ✅ 全ファイルは {DRIVE_DIR} に保存済み")
    if IN_COLAB:
        print(f"     → Google Drive から doubt_royale_v14_latest.onnx と strategy_data_v1.json をダウンロードしてサーバーに配置してください")


# ==========================================
# 実行
# ==========================================
if __name__ == '__main__':
    train(total_episodes=50000)
