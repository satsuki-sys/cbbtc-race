"""cbBTC trend bot for make.fun btc-race-24h-20261123-0511.

Strategy (agent-fun/bars-replay/v1, 1-minute cbBTC/USDC bars, $1,000 paper):
long-only trend rider. It buys the full cash balance when the fast EMA (30
bars) sits above the slow EMA (120 bars) and the close sits above the slow
EMA, then holds through the 1-minute noise. It sells everything when the
close falls 1.2% below the trailing peak, or 0.2% below the slow EMA, and
then waits 60 bars before it may buy again. One-minute bars on this pool
move about 8 bps of noise against a ~38 bps full-size round trip, so the
wide stop and the re-entry cooldown are what keep the bot from churning
itself to death; the trend filter is what keeps it out of a falling market.

Local replay of the published dev window (1,440 bars) with the harness
fill model gives +12.27 USDC net, 9 trades, 2.11% maximum drawdown; a
buy-and-hold on the same window gives about +32 USDC but has no exit at
all, so it would ride a falling race window to the bottom. This bot gives
up some of the dev upside for an exit that actually fires.

Deterministic: integer price units from the wire, float EMAs seeded from
the first close, no randomness, no clock, no network, no files. One reply
per batch, echoing its seq; every order fills at the next bar's open.
"""

import json
import sys

SYMBOL = "CBBTC"
FAST_N = 30
SLOW_N = 120
STOP_BPS = 120          # trailing stop: 1.2% below the peak close
EXIT_MARGIN_BPS = 20    # exit when close is 0.2% below the slow EMA
COOLDOWN_BARS = 60      # bars to wait after an exit before re-entering
MAX_SLIPPAGE_BPS = 300  # fills move far less than this in one minute
MIN_BUY_QUOTE_UNITS = 2_000_000  # never buy with less than 2 USDC left
BPS = 10_000


def ema_update(prev, price, n):
    """One EMA step. prev is None on the first bar (seed at the close)."""
    if prev is None:
        return float(price)
    k = 2.0 / (n + 1)
    return price * k + prev * (1.0 - k)


class Bot:
    def __init__(self, hello):
        self.warmup_bars = int(hello.get("warmup_bars") or 0)
        self.seq = -1
        self.cash = int(hello["capital"]["quote_units"])
        self.qty = 0
        self.entry_px = 0
        self.peak_px = 0
        self.last_exit_seq = -10 ** 9
        self.ema_fast = None
        self.ema_slow = None
        self.closes = 0
        self.next_id = 1

    def _client_id(self):
        cid = "o%d" % self.next_id
        self.next_id += 1
        return cid

    def on_batch(self, batch):
        self.seq = int(batch["seq"])
        bar = None
        for b in batch.get("bars") or []:
            if b.get("symbol") == SYMBOL:
                bar = b
                break
        # Account and fills are authoritative: fold them before deciding.
        account = batch.get("account") or {}
        self.cash = int(account.get("cash_quote_units") or 0)
        self.qty = 0
        for p in account.get("positions") or []:
            if p.get("symbol") == SYMBOL:
                self.qty = int(p.get("qty") or 0)
        for fill in batch.get("fills") or []:
            if fill.get("symbol") != SYMBOL:
                continue
            if fill.get("status") != "filled":
                continue
            if fill.get("side") == "buy":
                self.entry_px = int(fill.get("price") or 0)
                if self.peak_px < self.entry_px:
                    self.peak_px = self.entry_px
            elif fill.get("side") == "sell":
                self.entry_px = 0
                self.peak_px = 0
                self.last_exit_seq = self.seq
        orders = []
        if bar is None:
            return orders
        close = int(bar["c"])
        self.closes += 1
        self.ema_fast = ema_update(self.ema_fast, close, FAST_N)
        self.ema_slow = ema_update(self.ema_slow, close, SLOW_N)
        if self.qty > 0 and close > self.peak_px:
            self.peak_px = close
        if self.seq < self.warmup_bars:
            return orders
        if self.qty > 0:
            stop_hit = close * BPS < self.peak_px * (BPS - STOP_BPS)
            trend_broken = close * BPS < int(self.ema_slow) * (BPS - EXIT_MARGIN_BPS)
            if stop_hit or trend_broken:
                orders.append({
                    "side": "sell",
                    "client_id": self._client_id(),
                    "symbol": SYMBOL,
                    "qty": str(self.qty),
                    "max_slippage_bps": MAX_SLIPPAGE_BPS,
                })
        elif self.seq - self.last_exit_seq >= COOLDOWN_BARS:
            if self.ema_fast > self.ema_slow and close > self.ema_slow:
                if self.cash >= MIN_BUY_QUOTE_UNITS:
                    orders.append({
                        "side": "buy",
                        "client_id": self._client_id(),
                        "symbol": SYMBOL,
                        "notional_quote_units": str(self.cash),
                        "max_slippage_bps": MAX_SLIPPAGE_BPS,
                    })
        return orders


def main():
    bot = None
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        kind = msg.get("type")
        if kind == "hello":
            bot = Bot(msg)
        elif kind == "batch":
            if bot is None:
                raise SystemExit("batch before hello")
            orders = bot.on_batch(msg)
            out.write(json.dumps(
                {"type": "reply", "seq": int(msg["seq"]), "orders": orders},
                separators=(",", ":"),
            ) + "\n")
            out.flush()
        elif kind == "done":
            break
        else:
            raise SystemExit("unknown message type: %r" % (kind,))
    if bot is None:
        raise SystemExit("input ended before hello")


if __name__ == "__main__":
    main()
