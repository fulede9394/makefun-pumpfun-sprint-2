# Burst Rider — Pump.fun Bot Sprint

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/fulede9394/makefun-pumpfun-sprint-2/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/fulede9394/makefun-pumpfun-sprint-2/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A trading bot for [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) on [make.fun](https://make.fun).

## Strategy

Most new bonding curves bleed out after launch, but a few show a real burst of
buy-side demand in their first trades. The bot only steps in when a coin proves
that demand — price up at least 10% from its opening print, inside its first
60 trades, with buys making up at least 55% of traded SOL — then risks one
fixed 0.15 SOL stake per coin and gets out fast:

- **Take profit** at +60% over entry cost (far out — runners are banked by the give-back rule)
- **Stop loss** at −15% under entry cost
- **Give-back exit** once a peak of +30% is banked and price falls 10% from it
- **Staleness exit** after 200 further trades without an exit trigger

It never averages down, never re-enters a coin it already traded, and never
holds a completed curve. At most 5 positions are open at once.

## Layout

- `main.ts` — entrypoint; wires the strategy into the replay harness
- `strategy.ts` — the burst-rider strategy (entry/exit rules, per-coin ledger)
- `vendor/makefun-bot.ts` — the kit's replay SDK shim, vendored byte for byte
- `LICENSE` — MIT

## Run it

Grade locally with the kit (from the unpacked kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver docker --bundle <transcripts.tar.gz>
```
