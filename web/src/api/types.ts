export interface PortfolioPosition {
  token_address: string;
  symbol: string;
  chain_id: string;
  balance: number;
  entry_price: number;
  current_price: number;
  current_value: number;
  pnl_percent: number;
  stop_loss: number;
  take_profit: number;
  entry_time: number;
  status: "in_profit" | "at_loss";
}

export interface PortfolioResponse {
  positions: PortfolioPosition[];
  summary: {
    total_positions: number;
    total_value_sol: number;
    total_cost_sol: number;
    pnl_percent: number;
  };
}

export interface TrendingToken {
  address: string;
  symbol: string;
  name: string;
  chain_id: string;
  price_usd: number;
  price_change_24h: number;
  volume_24h: number;
  liquidity_usd: number;
  buy_to_sell_ratio: number;
  age_hours: number;
  boost_count: number;
  auto_buy_ready: boolean;
  cto_candidate: boolean;
  signal_status: "buy-ready" | "cto-watch" | "boost-watch" | "volume-watch";
  url: string;
}

export interface ScannerAlert {
  type: "BOOST" | "CTO";
  token_address: string;
  symbol: string;
  boost_count: number;
  triggered_at: number;
  status: "active";
}

export interface ScannerSnapshot {
  boosted_threshold: number;
  alerts: ScannerAlert[];
  tokens: TrendingToken[];
}

export interface TradeLogItem {
  id: string;
  type: string;
  pair: string;
  timestamp: number;
  confidence: number;
  outcome: string;
  status: "completed" | "failed";
  token_address?: string;
  amount_sol?: number;
  price?: number;
  paper?: boolean;
  pnl_percent?: number;
  profit_sol?: number;
  tx_signature?: string;
}

export interface TradeLogResponse {
  items: TradeLogItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface BotSettings {
  active_status: boolean;
  buy_amount_sol: number;
  override_enabled: boolean;
  private_withdrawal_address: string;
  min_confidence: number;
  stop_loss_percent: number;
  take_profit_percent: number;
  updated_at: number;
}

export interface VaultInfo {
  wallet_address: string;
  balance_sol: number;
  extractable_sol: number;
  reserved_sol: number;
  private_withdrawal_address: string;
}

export interface EncryptedWalletBlob {
  version: 1;
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface SecurityStatus {
  connections: {
    solana_rpc: { healthy: boolean; detail: string; latency_ms: number | null };
    dexscreener: { healthy: boolean; detail: string; latency_ms: number | null };
    openrouter_key_configured: boolean;
    dashboard_api_url_configured: boolean;
    dashboard_ingest_key_configured: boolean;
  };
  connection_manager: {
    dashboard_port: number;
    engine_mode: "paper" | "live";
    real_trading_ready: boolean;
    missing_requirements: string[];
  };
  keys: {
    openrouter_api_key: string;
    dashboard_api_key: string;
  };
  wallet: {
    active_address: string | null;
    unlocked_override_active: boolean;
    encrypted_vault_present: boolean;
  };
}
