/**
 * cbBTC trend bot for make.fun btc-race-24h-20261123-0511.
 *
 * Strategy (agent-fun/bars-replay/v1, 1-minute cbBTC/USDC bars, $1,000 paper):
 * long-only trend rider. It buys the full cash balance when the fast EMA (30
 * bars) sits above the slow EMA (120 bars) and the close sits above the slow
 * EMA, then holds through the 1-minute noise. It sells everything when the
 * close falls 1.2% below the trailing peak, or 0.2% below the slow EMA, and
 * then waits 60 bars before it may buy again. One-minute bars on this pool
 * move about 8 bps of noise against a ~38 bps full-size round trip, so the
 * wide stop and the re-entry cooldown are what keep the bot from churning
 * itself to death; the trend filter is what keeps it out of a falling market.
 *
 * A local replay of the published dev window (1,440 bars) with the harness
 * fill model gives +12.27 USDC net, 9 trades, 2.11% maximum drawdown; a
 * buy-and-hold on the same window gives about +32 USDC but has no exit at
 * all, so it would ride a falling race window to the bottom. This bot gives
 * up some of the dev upside for an exit that actually fires.
 *
 * Deterministic: integer price units from the wire, float EMAs seeded from
 * the first close, no randomness, no clock, no network, no files. One reply
 * per batch, echoing its seq; every order fills at the next bar's open.
 * Erasable TypeScript only, standard library only.
 */

import * as readline from "node:readline";

const SYMBOL = "CBBTC";
const FAST_N = 30;
const SLOW_N = 120;
const STOP_BPS = 120; // trailing stop: 1.2% below the peak close
const EXIT_MARGIN_BPS = 20; // exit when close is 0.2% below the slow EMA
const COOLDOWN_BARS = 60; // bars to wait after an exit before re-entering
const MAX_SLIPPAGE_BPS = 300; // fills move far less than this in one minute
const MIN_BUY_QUOTE_UNITS = 2000000; // never buy with less than 2 USDC left
const BPS = 10000;

type Order = {
  side: "buy" | "sell";
  client_id: string;
  symbol: string;
  notional_quote_units?: string;
  qty?: string;
  max_slippage_bps: number;
};

type Bar = {
  symbol: string;
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string | null;
  o_depth: string[];
  c_depth: string[];
};

type Fill = {
  client_id: string;
  symbol: string;
  side: "buy" | "sell";
  status: "filled" | "rejected";
  reason: string | null;
  decided_bar: number;
  fill_bar: number;
  price: string;
  qty: string;
  notional_quote_units: string;
  fee_quote_units: string;
};

type Position = { symbol: string; qty: string; cost_quote_units: string };

type Batch = {
  type: "batch";
  seq: number;
  t: number;
  bars: Bar[];
  fills: Fill[];
  account: {
    cash_quote_units: string;
    positions: Position[];
    equity_quote_units: string;
  };
};

type Hello = {
  type: "hello";
  protocol: string;
  seed: string;
  symbols: { symbol: string; mint: string; price_scale: number; qty_scale: number }[];
  capital: { quote: string; quote_scale: number; quote_units: string };
  bar_interval: string;
  first_close_ms: number;
  caps: {
    max_open_positions: number;
    max_orders_per_bar: number;
    max_weight_bps: number;
    shorts: boolean;
    leverage: boolean;
  };
  fees: { fee_bps: number; slippage_bps: number; min_notional_quote_units: string };
  latency_bars: number;
  warmup_bars?: number;
};

function emaUpdate(prev: number | null, price: number, n: number): number {
  if (prev === null) {
    return price;
  }
  const k = 2 / (n + 1);
  return price * k + prev * (1 - k);
}

class Bot {
  warmupBars: number;
  seq = -1;
  cash: number;
  qty = 0;
  entryPx = 0;
  peakPx = 0;
  lastExitSeq = -1000000000;
  emaFast: number | null = null;
  emaSlow: number | null = null;
  nextId = 1;

  constructor(hello: Hello) {
    this.warmupBars = hello.warmup_bars ?? 0;
    this.cash = Number(hello.capital.quote_units);
  }

  clientId(): string {
    const id = "o" + this.nextId;
    this.nextId += 1;
    return id;
  }

  onBatch(batch: Batch): Order[] {
    this.seq = batch.seq;
    let bar: Bar | null = null;
    for (const b of batch.bars ?? []) {
      if (b.symbol === SYMBOL) {
        bar = b;
        break;
      }
    }
    // Account and fills are authoritative: fold them before deciding.
    const account = batch.account ?? {};
    this.cash = Number(account.cash_quote_units ?? 0);
    this.qty = 0;
    for (const p of account.positions ?? []) {
      if (p.symbol === SYMBOL) {
        this.qty = Number(p.qty ?? 0);
      }
    }
    for (const fill of batch.fills ?? []) {
      if (fill.symbol !== SYMBOL || fill.status !== "filled") {
        continue;
      }
      if (fill.side === "buy") {
        this.entryPx = Number(fill.price ?? 0);
        if (this.peakPx < this.entryPx) {
          this.peakPx = this.entryPx;
        }
      } else if (fill.side === "sell") {
        this.entryPx = 0;
        this.peakPx = 0;
        this.lastExitSeq = this.seq;
      }
    }
    const orders: Order[] = [];
    if (bar === null) {
      return orders;
    }
    const close = Number(bar.c);
    this.emaFast = emaUpdate(this.emaFast, close, FAST_N);
    this.emaSlow = emaUpdate(this.emaSlow, close, SLOW_N);
    if (this.qty > 0 && close > this.peakPx) {
      this.peakPx = close;
    }
    if (this.seq < this.warmupBars) {
      return orders;
    }
    if (this.qty > 0) {
      const stopHit = close * BPS < this.peakPx * (BPS - STOP_BPS);
      const trendBroken =
        close * BPS < Math.trunc(this.emaSlow as number) * (BPS - EXIT_MARGIN_BPS);
      if (stopHit || trendBroken) {
        orders.push({
          side: "sell",
          client_id: this.clientId(),
          symbol: SYMBOL,
          qty: String(this.qty),
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    } else if (this.seq - this.lastExitSeq >= COOLDOWN_BARS) {
      if ((this.emaFast as number) > (this.emaSlow as number) && close > (this.emaSlow as number)) {
        if (this.cash >= MIN_BUY_QUOTE_UNITS) {
          orders.push({
            side: "buy",
            client_id: this.clientId(),
            symbol: SYMBOL,
            notional_quote_units: String(this.cash),
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
        }
      }
    }
    return orders;
  }
}

async function main(): Promise<void> {
  let bot: Bot | null = null;
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const text = line.trim();
    if (text === "") {
      continue;
    }
    const msg = JSON.parse(text) as { type: string };
    if (msg.type === "hello") {
      bot = new Bot(msg as unknown as Hello);
    } else if (msg.type === "batch") {
      if (bot === null) {
        throw new Error("batch before hello");
      }
      const batch = msg as unknown as Batch;
      const orders = bot.onBatch(batch);
      process.stdout.write(
        JSON.stringify({ type: "reply", seq: batch.seq, orders }) + "\n",
      );
    } else if (msg.type === "done") {
      // The harness is finished; exit now instead of waiting for stdin to
      // close, so the run ends promptly under either driver.
      lines.close();
      process.exit(0);
    } else {
      throw new Error("unknown message type: " + JSON.stringify(msg.type));
    }
  }
  if (bot === null) {
    throw new Error("input ended before hello");
  }
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
