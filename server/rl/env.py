import gymnasium as gym
from gymnasium import spaces
import numpy as np
import random

class DoubtRoyaleEnv(gym.Env):
    metadata = {"render_modes": ["human"]}

    def __init__(self, num_players=4, opponent_policies=None):
        super(DoubtRoyaleEnv, self).__init__()
        self.num_players = num_players
        self.opponent_policies = opponent_policies
        
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
        return self._get_obs(0), {}

    def _create_deck(self):
        deck = []
        for suit in range(4):
            for num in range(1, 14):
                deck.append({"suit": suit, "number": num, "id": f"card-{len(deck)}", "is_joker": False})
        deck.append({"suit": -1, "number": 0, "id": "card-52", "is_joker": True})
        deck.append({"suit": -1, "number": 0, "id": "card-53", "is_joker": True})
        return deck

    def _get_obs(self, player_idx):
        hand_vec = np.zeros(54, dtype=np.int32)
        for card in self.hands[player_idx]:
            idx = int(card["id"].split("-")[1])
            if 0 <= idx < 54: hand_vec[idx] = 1
        
        others_count = []
        for i in range(self.num_players):
            if i != player_idx:
                others_count.append(len(self.hands[i]))
        others_count = np.array(others_count, dtype=np.int32)
        
        last_player_rel = (self.field["last_player"] - player_idx + self.num_players) % self.num_players if self.field["last_player"] != -1 else -1
        
        return {
            "hand": hand_vec,
            "field": np.array([self.field["number"], self.field["count"], last_player_rel], dtype=np.int32),
            "others_count": others_count,
            "status": np.array([int(self.is_revolution), int(self.is_eleven_back)], dtype=np.int32)
        }

    def step(self, action):
        initial_hand_size = len(self.hands[0])
        terminated = False
        reward = 0
        
        if action == 0:
            self._handle_pass(0)
        elif 1 <= action <= 13:
            played = self._handle_play(0, action, lie=False)
            if played: reward += 0.2
        elif action == 14:
            success = self._handle_doubt(0)
            if success: reward += 1.0
            else: reward -= 1.0
        elif 16 <= action <= 28:
            played = self._handle_play(0, action - 15, lie=True)
            if played: reward += 0.1
        
        self._simulate_others()

        if len(self.hands[0]) == 0 and not self.player_out[0]:
            reward += 10.0
            terminated = True
        elif self.player_out[0]:
            reward -= 5.0
            terminated = True
            
        return self._get_obs(0), reward, terminated, False, {}

    def _handle_play(self, player_idx, declared_num, lie=False):
        hand = self.hands[player_idx]
        if not hand: return False
        cards_to_play = []
        if not lie:
            cards_to_play = [c for c in hand if (0 if c["is_joker"] else c["number"]) == declared_num]
            if not cards_to_play: cards_to_play = [hand[0]]
        else:
            others = [c for c in hand if (0 if c["is_joker"] else c["number"]) != declared_num]
            cards_to_play = [others[0]] if others else [hand[0]]
            
        self.hands[player_idx] = [c for c in hand if c["id"] not in [cp["id"] for cp in cards_to_play]]
        self.field.update({"number": declared_num, "count": len(cards_to_play), "last_player": player_idx, "cards": cards_to_play})
        self.current_player = (self.current_player + 1) % self.num_players
        return True

    def _handle_pass(self, player_idx):
        self.current_player = (self.current_player + 1) % self.num_players
        if self.field["last_player"] == self.current_player:
            self.field = {"number": 0, "count": 0, "last_player": -1, "cards": []}

    def _handle_doubt(self, player_idx):
        if self.field["last_player"] in [-1, player_idx]: return False
        liar_idx = self.field["last_player"]
        is_lie = any((0 if c["is_joker"] else c["number"]) != self.field["number"] for c in self.field["cards"])
        if is_lie:
            self.hands[liar_idx].extend(self.field["cards"])
            self.player_lives[liar_idx] -= 1
            res = (player_idx == 0)
        else:
            self.hands[player_idx].extend(self.field["cards"])
            self.player_lives[player_idx] -= 1
            res = (player_idx != 0)
        self.field = {"number": 0, "count": 0, "last_player": -1, "cards": []}
        return res

    def _simulate_others(self):
        steps = 0
        import torch
        while self.current_player != 0 and not all(self.player_out) and steps < 100:
            steps += 1
            p_idx = self.current_player
            if not self.hands[p_idx]:
                self.player_out[p_idx] = True
                self.current_player = (self.current_player + 1) % self.num_players
                continue

            if self.opponent_policies and p_idx < len(self.opponent_policies):
                policy = self.opponent_policies[p_idx]
                with torch.no_grad():
                    obs = self._get_obs(p_idx)
                    flat_obs = np.concatenate([obs["hand"], obs["field"], obs["others_count"], obs["status"]])
                    action = torch.argmax(policy(torch.FloatTensor(flat_obs))).item()
                if action == 0: self._handle_pass(p_idx)
                elif 1 <= action <= 13: self._handle_play(p_idx, action, lie=False)
                elif action == 14: self._handle_doubt(p_idx)
                elif 16 <= action <= 28: self._handle_play(p_idx, action-15, lie=True)
            else:
                r = random.random()
                if r < 0.7:
                    possible_nums = list(set([(0 if c["is_joker"] else c["number"]) for c in self.hands[p_idx]]))
                    self._handle_play(p_idx, random.choice(possible_nums) if possible_nums else 1, lie=False)
                elif r < 0.85: self._handle_play(p_idx, random.randint(1, 13), lie=True)
                elif r < 0.95: self._handle_pass(p_idx)
                else: self._handle_doubt(p_idx)
