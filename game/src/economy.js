// economy.js — pure money rules. No DOM, no three.js, so the whole module
// unit-tests in Node. Money is the round-to-round memory of the match:
// you start poor, kills and plants pay, and winning pays much more than
// losing, so a lost round still lets you re-arm.
export const START_MONEY = 800;
export const KILL_REWARD = 300;
export const PLANT_REWARD = 300;
export const WIN_REWARD = 3250;
export const LOSS_REWARD = 1900;

export function createEconomy() {
  return { money: START_MONEY };
}

export function canAfford(econ, cost) {
  return econ.money >= cost;
}

// Spends when affordable, returns true; never lets money go negative.
export function spend(econ, cost) {
  if (cost < 0 || econ.money < cost) return false;
  econ.money -= cost;
  return true;
}

export function earn(econ, amount) {
  econ.money += amount;
  return econ.money;
}

// End-of-round payout: winners re-arm in style, losers stay in the game.
export function roundReward(econ, won) {
  return earn(econ, won ? WIN_REWARD : LOSS_REWARD);
}
