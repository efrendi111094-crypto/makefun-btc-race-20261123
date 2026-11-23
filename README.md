# Gated Recovery BTC Race Bot

[![make.fun](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/efrendi111094-crypto/makefun-btc-race-20261123/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/efrendi111094-crypto/makefun-btc-race-20261123/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)

A bot that trades Coinbase Wrapped BTC (cbBTC) against USDC, minute by minute,
in the [make.fun](https://make.fun/bounty/btc-race-24h-20261123-0511) 24-hour
BTC race. It buys confirmed pullbacks only while the 2-hour trend is up, then
exits on take-profit (+150 bps), hard stop (-80 bps), trailing stop (-70 bps)
or a 7-hour time-stop. At most 2 round trips per window; trading halts after
2 consecutive losing exits.

Built from the loss study of the previous race, where an ungated bounce-buyer
lost $21.60 buying dead-cat bounces in an afternoon downtrend: this bot adds
the regime gate the old one lacked, caps its trades, and stops after two
losses. Backtested on 8 prior 24-hour windows (2 cbBTC dev windows + 6 Yahoo
BTC-USD days): median PnL +$2.34, win rate 50% (8W/8L). Dev-window grade
(verified locally with the kit's own harness): **+$10.08 net PnL**, 4 trades,
50% win rate, 1.22% max drawdown, 0 rejected orders.

## Layout

- `main.ts` — the bot (Node 22, stdlib only, speaks agent-fun/bars-replay/v1)
- `vendor/makefun-bars.ts` — the kit's SDK shim, copied byte for byte

## Run locally

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```
