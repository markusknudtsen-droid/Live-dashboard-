import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config.js";
import { ActivePosition } from "./trader.js";

export interface TradeHistoryItem {
  timestamp: number;
  symbol: string;
  action: string;
  confidence: number;
  result: string;
  txSignature?: string;
}

export interface BotState {
  activePositions: ActivePosition[];
  tradeHistory: TradeHistoryItem[];
}

const DEFAULT_STATE: BotState = {
  activePositions: [],
  tradeHistory: [],
};

export async function loadState(): Promise<BotState> {
  try {
    const raw = await readFile(CONFIG.stateFilePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<BotState>;
    return {
      activePositions: Array.isArray(parsed.activePositions) ? parsed.activePositions : [],
      tradeHistory: Array.isArray(parsed.tradeHistory) ? parsed.tradeHistory : [],
    };
  } catch {
    return DEFAULT_STATE;
  }
}

export async function saveState(state: BotState): Promise<void> {
  const fullPath = path.resolve(CONFIG.stateFilePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, JSON.stringify(state, null, 2), "utf-8");
}
