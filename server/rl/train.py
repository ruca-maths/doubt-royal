import gymnasium as gym
import torch
import torch.nn as nn
import torch.optim as optim
import numpy as np
import random
from collections import deque
from env import DoubtRoyaleEnv
from model import DQN

# Hyperparameters
LR = 1e-3
GAMMA = 0.99
MEMORY_SIZE = 10000
BATCH_SIZE = 64
EPS_START = 1.0
EPS_END = 0.05
EPS_DECAY = 0.995
TARGET_UPDATE = 10

class Agent:
    def __init__(self, n_actions):
        self.n_actions = n_actions
        self.policy_net = DQN(62, n_actions)
        self.target_net = DQN(62, n_actions)
        self.target_net.load_state_dict(self.policy_net.state_dict())
        self.optimizer = optim.Adam(self.policy_net.parameters(), lr=LR)
        self.memory = deque(maxlen=MEMORY_SIZE)
        self.epsilon = EPS_START
        self.pool = deque(maxlen=5) # Self-play pool

    def select_action(self, state):
        if random.random() < self.epsilon:
            return random.randint(0, self.n_actions - 1)
        else:
            with torch.no_grad():
                state_v = self._flatten_state(state)
                q_values = self.policy_net(state_v)
                return torch.argmax(q_values).item()

    def _flatten_state(self, state):
        # hand (54) + field (3) + others (3) + status (2) = 62
        hand = state["hand"]
        field = state["field"]
        others = state["others_count"]
        status = state["status"]
        flat = np.concatenate([hand, field, others, status])
        return torch.FloatTensor(flat).unsqueeze(0)

    def train_step(self):
        if len(self.memory) < BATCH_SIZE:
            return
        
        batch = random.sample(self.memory, BATCH_SIZE)
        states, actions, rewards, next_states, dones = zip(*batch)
        
        # Prepare tensors
        states_v = torch.cat([self._flatten_state(s) for s in states])
        next_states_v = torch.cat([self._flatten_state(s) for s in next_states])
        actions_v = torch.LongTensor(actions).unsqueeze(1)
        rewards_v = torch.FloatTensor(rewards)
        dones_v = torch.BoolTensor(dones)

        # Q-Learning
        current_q = self.policy_net(states_v).gather(1, actions_v).squeeze()
        next_q = self.target_net(next_states_v).max(1)[0]
        next_q[dones_v] = 0.0
        expected_q = rewards_v + GAMMA * next_q

        loss = F.mse_loss(current_q, expected_q)
        self.optimizer.zero_grad()
        loss.backward()
        self.optimizer.step()

# We need Functional for F.mse_loss
import torch.nn.functional as F

def main():
    env = DoubtRoyaleEnv()
    agent = Agent(env.action_space.n)
    
    num_episodes = 500
    for episode in range(num_episodes):
        # Sample opponents for self-play
        opponents = None
        if len(agent.pool) > 0:
            opponents = [random.choice(agent.pool) for _ in range(env.num_players)]
        env.opponent_policies = opponents

        state, _ = env.reset()
        total_reward = 0
        
        while True:
            action = agent.select_action(state)
            next_state, reward, terminated, truncated, _ = env.step(action)
            done = terminated or truncated
            
            agent.memory.append((state, action, reward, next_state, done))
            agent.train_step()
            
            state = next_state
            total_reward += reward
            if done: break
                
        if episode % TARGET_UPDATE == 0:
            agent.target_net.load_state_dict(agent.policy_net.state_dict())
            
        agent.epsilon = max(EPS_END, agent.epsilon * EPS_DECAY)
        
        if episode % 10 == 0:
            print(f"Episode {episode}, Reward: {total_reward:.2f}, Epsilon: {agent.epsilon:.2f}")

        # Update self-play pool
        if episode > 0 and episode % 100 == 0:
            new_policy = DQN(62, env.action_space.n)
            new_policy.load_state_dict(agent.policy_net.state_dict())
            agent.pool.append(new_policy)

    # Save model
    torch.save(agent.policy_net.state_dict(), "doubt_royale_dqn.pth")
    print("Training finished. Model saved.")

if __name__ == "__main__":
    main()
