// Burst rider: a pump.fun replay bot with its own entry and exit logic.
//
// Idea: most new bonding curves bleed out after launch, but a few show a real
// burst of buy-side demand in their first trades. This bot only steps in when a
// coin proves that demand (price up at least 10% from its opening print, inside
// its first 60 trades, buys at least 55% of traded SOL), risks one fixed stake
// per coin, and gets out fast: a stop-loss, a give-back rule once a peak is
// banked, or a staleness rule when the coin stops moving. The take-profit sits
// far out (+60%) so the rare runner is banked by the give-back rule instead of
// being sold at the first pop. It never averages down, never re-enters a coin
// it already traded, and never holds a completed curve. Sells use a wide
// slippage band so a crashing coin actually fills instead of sitting through
// repeated rejections while the price keeps falling.
//
// All prices come from the curve's virtual reserves (quote per token). Every
// decision is made on the batch in hand; orders fill two slots later, so the
// slippage band is wide enough to survive that latency.

import type {
  Batch,
  BotState,
  BuyInput,
  OrderInput,
  SellInput,
} from './vendor/makefun-bot.ts';

export interface BurstParams {
  /** SOL spent on each entry, in lamports. */
  stakeLamports: bigint;
  /** Smallest buy worth sending, in lamports. */
  minBuyLamports: bigint;
  /** Entry needs price up this much (bps) over the opening print. */
  entryRiseBps: number;
  /** Only coins inside their first N trades can trigger an entry. */
  entryWindowTrades: number;
  /** Entry needs buys to be at least this share (bps) of traded SOL. */
  minBuyShareBps: number;
  /** Sell everything once value is up this much (bps) over entry cost. */
  takeProfitBps: number;
  /** Sell everything once value is down this much (bps) under entry cost. */
  stopLossBps: number;
  /** Once the peak clears armGiveBackBps, sell on a fall of this much from it. */
  giveBackBps: number;
  /** Peak (bps over entry cost) that arms the give-back exit. */
  armGiveBackBps: number;
  /** Sell if the coin trades this many more times without hitting an exit. */
  staleTrades: number;
  /** Slippage band for every order. */
  maxSlippageBps: number;
}

export const DEFAULT_PARAMS: BurstParams = {
  stakeLamports: 150_000_000n, // 0.15 SOL
  minBuyLamports: 10_000_000n, // 0.01 SOL
  entryRiseBps: 1000, // +10%
  entryWindowTrades: 60,
  minBuyShareBps: 5500, // 55% buys
  takeProfitBps: 6000, // +60%: let the rare runner run; the give-back rule banks it
  stopLossBps: 1500, // -15%
  giveBackBps: 1000, // -10% from the peak
  armGiveBackBps: 3000, // peak of +30% arms it
  staleTrades: 200,
  maxSlippageBps: 1000, // 10% on buys; sells use SELL_SLIPPAGE_BPS below
};

/** Sells use a wide band: a crashing coin must actually fill rather than sit
 *  through repeated max_slippage rejections while the price keeps falling. */
export const SELL_SLIPPAGE_BPS = 10_000;

/** Everything the bot remembers about one mint. */
interface CoinNote {
  /** Quote-per-token at first sight, as a float ratio of virtual reserves. */
  openPrice: number;
  /** TradeEvents seen on this curve. */
  trades: number;
  /** SOL spent by buyers in the entry window. */
  buySol: bigint;
  /** SOL taken by sellers in the entry window. */
  sellSol: bigint;
  /** The latest trade on this curve was a buy (fresh demand, not a dump). */
  lastTradeBuy: boolean;
  /** An entry decision was made (bought, or skipped for good). */
  decided: boolean;
  /** Best value-over-cost ratio seen since entry (1.0 = breakeven). */
  peakRatio: number;
  /** Trade count on the curve when the buy was sent. */
  tradesAtBuy: number;
}

function curvePrice(state: BotState, mint: string): number | null {
  const curve = state.curves.get(mint);
  if (curve === undefined) return null;
  if (curve.virtual_token_reserves <= 0n) return null;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

export function createBurstBot(params: BurstParams) {
  const notes = new Map<string, CoinNote>();
  const pendingSells = new Set<string>();

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const { caps } = state.hello;
      const txFee = state.txFeeLamports();
      let freeCash = state.freeCashLamports();
      let openSlots =
        caps.max_open_positions - state.committedPositionCount();

      // Fold this batch's fills back into the bookkeeping: a sell that resolved
      // frees its mint, a buy that resolved starts peak tracking.
      for (const fill of batch.fills) {
        if (fill.side === 'sell') pendingSells.delete(fill.mint);
      }

      // Update per-coin notes from this batch's events.
      const touched = new Set<string>();
      for (const event of batch.events) {
        touched.add(event.mint);
        if (event.event === 'CreateEvent') {
          if (!notes.has(event.mint)) {
            const price = curvePrice(state, event.mint);
            notes.set(event.mint, {
              openPrice: price ?? 0,
              trades: 0,
              buySol: 0n,
              sellSol: 0n,
              lastTradeBuy: false,
              decided: false,
              peakRatio: 1,
              tradesAtBuy: 0,
            });
          }
          continue;
        }
        if (event.event === 'TradeEvent') {
          let note = notes.get(event.mint);
          if (note === undefined) {
            const price = curvePrice(state, event.mint);
            note = {
              openPrice: price ?? 0,
              trades: 0,
              buySol: 0n,
              sellSol: 0n,
              lastTradeBuy: false,
              decided: false,
              peakRatio: 1,
              tradesAtBuy: 0,
            };
            notes.set(event.mint, note);
          }
          note.trades += 1;
          note.lastTradeBuy = event.is_buy;
          const sol = BigInt(event.sol_amount);
          if (event.is_buy) note.buySol += sol;
          else note.sellSol += sol;
          continue;
        }
        // CompleteEvent: the curve is done; drop the note so no stale
        // entry is ever attempted on it.
        if (event.event === 'CompleteEvent') notes.delete(event.mint);
      }

      // Exits first: free slots and cash before looking for new entries.
      for (const [mint, holding] of state.positions) {
        if (pendingSells.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const note = notes.get(mint);
        const price = curvePrice(state, mint);
        if (price === null || price <= 0) continue;
        const value =
          Number(holding.token_amount) * price;
        const cost = Number(holding.cost_lamports);
        if (cost <= 0) continue;
        const ratio = value / cost;
        if (note !== undefined && ratio > note.peakRatio) {
          note.peakRatio = ratio;
        }
        const peak = note?.peakRatio ?? ratio;
        const stale =
          note !== undefined &&
          curve.trades - note.tradesAtBuy >= params.staleTrades;
        const takeProfit = ratio >= 1 + params.takeProfitBps / 10_000;
        const stopLoss = ratio <= 1 - params.stopLossBps / 10_000;
        const giveBack =
          peak >= 1 + params.armGiveBackBps / 10_000 &&
          ratio <= peak * (1 - params.giveBackBps / 10_000);
        if (takeProfit || stopLoss || giveBack || stale) {
          if (orders.length >= caps.max_orders_per_batch) continue;
          const sell: SellInput = {
            side: 'sell',
            mint,
            token_amount: holding.token_amount,
            max_slippage_bps: SELL_SLIPPAGE_BPS,
          };
          orders.push(sell);
          pendingSells.add(mint);
        }
      }

      // Entries: only coins touched by this batch, still inside their early
      // window, undecided, and showing a real demand burst.
      for (const mint of touched) {
        if (orders.length >= caps.max_orders_per_batch) break;
        const note = notes.get(mint);
        if (note === undefined || note.decided) continue;
        if (note.trades > params.entryWindowTrades) {
          note.decided = true;
          continue;
        }
        if (note.openPrice <= 0) continue;
        const price = curvePrice(state, mint);
        if (price === null) continue;
        const riseBps = ((price - note.openPrice) / note.openPrice) * 10_000;
        if (riseBps < params.entryRiseBps) continue;
        const traded = note.buySol + note.sellSol;
        if (traded <= 0n) continue;
        const buyShareBps = Number((note.buySol * 10_000n) / traded);
        if (buyShareBps < params.minBuyShareBps) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) {
          note.decided = true;
          continue;
        }
        const cap = state.maxBuyLamports(mint);
        if (cap < params.minBuyLamports) continue;
        const amount =
          cap < params.stakeLamports ? cap : params.stakeLamports;
        if (openSlots <= 0 || freeCash < amount + txFee) continue;
        note.decided = true;
        note.tradesAtBuy = curve.trades;
        note.peakRatio = 1;
        const buy: BuyInput = {
          side: 'buy',
          mint,
          quote_lamports: amount,
          max_slippage_bps: params.maxSlippageBps,
        };
        orders.push(buy);
        freeCash -= amount + txFee;
        openSlots -= 1;
      }

      return orders;
    },
  };
}
