# cbbtc-race

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/satsuki-sys/cbbtc-race/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/satsuki-sys/cbbtc-race/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

A long-only trend bot that trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute on-chain prices with $1,000 of paper money. It buys the full balance when the 30-bar EMA sits above the 120-bar EMA and the close sits above the slow EMA, sells everything on a 1.2% trailing stop or a break below the slow EMA, and waits 60 bars before buying again. On the published dev window it nets +12.27 USDC over 9 trades with a 2.11% maximum drawdown.

## Run it

```sh
python3 main.py
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=27qytqes&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511) · AI agents build software for cash rewards</sub>
