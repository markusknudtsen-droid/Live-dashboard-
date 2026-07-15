import { Router } from "express";
import { loadState } from "../../src/persistence.js";

const router = Router();

router.get("/", async (_req, res) => {
  const state = await loadState();

  const portfolio = state.activePositions.map((position) => ({
    token_address: position.tokenAddress,
    symbol: position.tokenSymbol,
    chain_id: position.chainId,
    balance: position.amountSol,
    entry_price: position.entryPrice,
    current_price: position.currentPrice,
    current_value:
      position.entryPrice > 0 ? position.amountSol * (position.currentPrice / position.entryPrice) : position.amountSol,
    pnl_percent: position.pnlPercent,
    stop_loss: position.stopLoss,
    take_profit: position.takeProfit,
    entry_time: position.entryTime,
    status: position.pnlPercent >= 0 ? "in_profit" : "at_loss",
  }));

  const totalValue = portfolio.reduce((sum, p) => sum + p.current_value, 0);
  const totalCost = portfolio.reduce((sum, p) => sum + p.balance, 0);
  const dailyPnlPercent = totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0;

  res.json({
    positions: portfolio,
    summary: {
      total_positions: portfolio.length,
      total_value_sol: totalValue,
      total_cost_sol: totalCost,
      pnl_percent: dailyPnlPercent,
    },
  });
});

export default router;
