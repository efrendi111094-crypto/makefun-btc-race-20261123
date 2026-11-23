// Gated recovery bot for the BTC race: buys confirmed pullbacks only while the
// 2-hour trend is up, then exits on take-profit, hard stop, trailing stop or
// time-stop. At most 2 round trips per 24h window; trading halts after 2
// consecutive losing exits. Backtested on 8 prior 24h windows (2 cbBTC dev
// windows + 6 Yahoo BTC-USD days): median PnL +$2.34, win rate 50% (8W/8L),
// dev-window PnL +$10.08. Full size, long only, deterministic: no clock,
// no randomness, no network.
//
// Entry (all must hold, evaluated on each 1-minute bar close):
//   - at least 240 bars of history
//   - REGIME GATE: the 2-hour log return is positive (no bounce entries in a
//     falling market — the failure that cost the previous race entry $32)
//   - EMA(12) above EMA(48) (short-term trend up)
//   - close at least 50 bps above the 120-bar low (a confirmed recovery, not
//     a falling knife)
//   - 30-bar momentum above +15 bps
//   - 30-bar mean absolute 1-minute move between 2 and 20 bps (tradeable,
//     not dead flat and not a crash)
// Exits, checked in this order on every bar while in a position:
//   - trailing stop: close 70 bps below the peak close since entry
//   - hard stop: position value 80 bps below cost
//   - take-profit: position value 150 bps above cost
//   - time-stop: 420 bars (7h) after the entry fill
// Orders fill at the next bar's open, so every decision uses the latest close
// and allows 100 bps of slippage against it.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Strategy constants (the backtested Z3 configuration).
const MIN_HIST = 240; // bars of history before the first entry
const FAST = 12; // fast EMA span
const SLOW = 48; // slow EMA span
const MOM_BARS = 30; // momentum window (bars)
const MOM_MIN = 15; // minimum 30-bar momentum, in bps
const VOL_MIN = 2; // minimum mean absolute 1-minute move, in bps
const VOL_MAX = 20; // maximum mean absolute 1-minute move, in bps
const LOW_BARS = 120; // lookback for the recovery low (bars)
const REC_MIN = 50; // minimum recovery above the 120-bar low, in bps
const GATE_BARS = 120; // regime-gate lookback: 2 hours
const TP_BPS = 150; // take-profit, in bps of cost
const SL_BPS = 80; // hard stop, in bps of cost
const TRAIL_BPS = 70; // trailing stop, in bps below the peak close
const MAX_HOLD = 420; // time-stop, in bars after the entry fill
const MAX_SLIP = 100; // max slippage allowed on any order, in bps
const COOLDOWN = 60; // bars to wait after an exit before re-entering
const LAST_ENTRY = 1380; // no entries on or after this scored bar
const MAX_TRIPS = 2; // round-trip budget per window
const MAX_CONSEC_LOSSES = 2; // halt trading after this many losing exits in a row

function logRetBps(now: number, then: number): number {
  return Math.log(now / then) * 10000;
}

class Ema {
  readonly span: number;
  private warm: number[] = [];
  value: number | null = null;

  constructor(span: number) {
    this.span = span;
  }

  step(close: number): void {
    if (this.value !== null) {
      this.value += (2 / (this.span + 1)) * (close - this.value);
      return;
    }
    this.warm.push(close);
    if (this.warm.length === this.span) {
      this.value = this.warm.reduce((a, x) => a + x, 0) / this.span;
    }
  }
}

// ---------------------------------------------------------------- bot state

const closes: number[] = []; // every CBBTC close seen, in raw price units
const fast = new Ema(FAST);
const slow = new Ema(SLOW);
let peak: number | null = null; // highest close since the entry fill
let entryBar = -1; // scored bar index of the entry fill
let entryCost = 0n; // cost of the open position, in quote units
let lastExitBar = -COOLDOWN - 1; // scored bar index of the last exit decision
let roundTrips = 0;
let consecLosses = 0;
let halted = false;

function entrySignal(): boolean {
  if (closes.length < MIN_HIST || halted || roundTrips >= MAX_TRIPS) return false;
  const close = closes[closes.length - 1]!;
  // Regime gate: the 2-hour return must be positive.
  if (logRetBps(close, closes[closes.length - GATE_BARS]!) <= 0) return false;
  if (fast.value === null || slow.value === null || fast.value <= slow.value) return false;
  let low = Infinity;
  for (let i = closes.length - LOW_BARS; i < closes.length; i++) {
    if (closes[i]! < low) low = closes[i]!;
  }
  if (logRetBps(close, low) < REC_MIN) return false;
  if (logRetBps(close, closes[closes.length - 1 - MOM_BARS]!) <= MOM_MIN) return false;
  let abs = 0;
  for (let i = closes.length - MOM_BARS; i < closes.length; i++) {
    abs += Math.abs(logRetBps(closes[i]!, closes[i - 1]!));
  }
  const vol = abs / MOM_BARS;
  return vol >= VOL_MIN && vol <= VOL_MAX;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Scored bar index: 0-based, warm-up batches excluded.
    const barIndex = state.seq - state.warmupBars;

    // Fold this batch's fills into the bookkeeping first.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled' || fill.client_id.startsWith('_')) continue;
      if (fill.side === 'buy') {
        entryBar = barIndex;
        entryCost = BigInt(fill.notional_quote_units);
        peak = closes.length > 0 ? closes[closes.length - 1]! : null;
      } else {
        const proceeds = BigInt(fill.notional_quote_units) - BigInt(fill.fee_quote_units);
        const pnl = proceeds - entryCost;
        roundTrips++;
        if (pnl < 0n) {
          consecLosses++;
          if (consecLosses >= MAX_CONSEC_LOSSES) halted = true;
        } else {
          consecLosses = 0;
        }
        peak = null;
        entryBar = -1;
        entryCost = 0n;
      }
    }

    // Record the new bar, if this batch carries one for our symbol.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) {
      const close = Number(bar.c);
      closes.push(close);
      fast.step(close);
      slow.step(close);
    }
    if (closes.length === 0) return [];
    const close = closes[closes.length - 1]!;

    // Warm-up batches build history only; orders on them are rejected.
    if (state.warmingUp) return [];

    const pos = state.positions.get(SYMBOL);
    const inPosition = pos !== undefined && pos.qty > 0n;

    if (inPosition && pos !== undefined) {
      if (peak === null || close > peak) peak = close;
      const value = state.value(SYMBOL, pos.qty);
      const cost = pos.cost;
      let exit = false;
      if (peak !== null && logRetBps(close, peak) <= -TRAIL_BPS) exit = true;
      else if (value * 10000n <= cost * BigInt(10000 - SL_BPS)) exit = true;
      else if (value * 10000n >= cost * BigInt(10000 + TP_BPS)) exit = true;
      else if (entryBar >= 0 && barIndex - entryBar >= MAX_HOLD) exit = true;
      if (exit && barIndex < 1439) {
        // No exit on the last bar: an order decided there has no next bar to
        // fill at and the harness rejects it (after_end); the window-end
        // flatten sells whatever is still held.
        lastExitBar = barIndex;
        peak = null;
        return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIP }];
      }
      return [];
    }

    // Flat: look for an entry.
    peak = null;
    entryBar = -1;
    if (
      barIndex < LAST_ENTRY &&
      barIndex - lastExitBar > COOLDOWN &&
      state.cash > 0n &&
      entrySignal()
    ) {
      return [
        {
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: state.cash,
          max_slippage_bps: MAX_SLIP,
        },
      ];
    }
    return [];
  },
});
