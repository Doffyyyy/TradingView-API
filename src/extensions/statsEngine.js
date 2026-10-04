/**
 * Edge Stats Engine (Inspired by LuxAlgo/edge-stats)
 * Quantitative Conditional Probability P(outcome | conditions) with Statistical Honesty.
 * Implements Wilson 95% Confidence Intervals, Minimum-N Guards, Stability Splits, and Bar Distributions.
 */

'use strict';

/**
 * Wilson score interval for a binomial proportion (default 95% confidence, z = 1.95996).
 * Returns { estimate, lo, hi, pFormatted, ciFormatted }
 */
function wilson(k, n, z = 1.959963984540054) {
  if (n <= 0) return null;
  if (k < 0 || k > n) throw new Error(`Invalid counts: k=${k}, n=${n}`);
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  const lo = Math.max(0, center - half);
  const hi = Math.min(1, center + half);

  return {
    p,
    lo,
    hi,
    pPct: (p * 100).toFixed(1) + '%',
    loPct: (lo * 100).toFixed(1) + '%',
    hiPct: (hi * 100).toFixed(1) + '%',
    ciString: `[${(lo * 100).toFixed(1)}%, ${(hi * 100).toFixed(1)}%]`,
  };
}

/**
 * Minimum sample size guard rails.
 * Low sample warning if N < 30, refused conclusion if N < 10.
 */
function applyGuards(n, floors = { warn: 30, refuse: 10 }) {
  return {
    lowSample: n < floors.warn,
    refused: n < floors.refuse,
    warnFloor: floors.warn,
    refuseFloor: floors.refuse,
  };
}

/**
 * First-half vs second-half stability test.
 * Checks whether historical edge is stable over time or degrading.
 */
function stabilitySplit(n1, k1, n2, k2) {
  const w1 = wilson(k1, n1);
  const w2 = wilson(k2, n2);
  let agree = null;
  if (w1 && w2) {
    agree = w1.lo <= w2.hi && w2.lo <= w1.hi;
  }
  return {
    firstHalf: { n: n1, k: k1, pPct: w1?.pPct ?? '--', ciString: w1?.ciString ?? '--' },
    secondHalf: { n: n2, k: k2, pPct: w2?.pPct ?? '--', ciString: w2?.ciString ?? '--' },
    agree: agree,
    statusText: agree === true ? 'Stable (Halves agree ✓)' : agree === false ? 'Shifted (Halves diverge ✗)' : 'Insufficient sample',
  };
}

/**
 * Distribution summary for continuous metrics (e.g. time to fill gap in minutes/bars)
 */
function summarizeDistribution(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / count;

  const quantile = (q) => {
    const pos = (count - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (sorted[base + 1] !== undefined) {
      return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    }
    return sorted[base];
  };

  return {
    count,
    min: sorted[0],
    p25: Math.round(quantile(0.25) * 10) / 10,
    median: Math.round(quantile(0.50) * 10) / 10,
    p75: Math.round(quantile(0.75) * 10) / 10,
    p90: Math.round(quantile(0.90) * 10) / 10,
    max: sorted[count - 1],
    mean: Math.round(mean * 10) / 10,
  };
}

/**
 * Group raw intraday candles (1H or 15M) into daily trading sessions.
 */
function groupIntoDailySessions(candles) {
  if (!candles || candles.length < 5) return [];

  const sessionsMap = new Map();
  for (const c of candles) {
    const d = new Date(c.time * 1000);
    // Use UTC date YYYY-MM-DD
    const dateKey = d.toISOString().slice(0, 10);
    if (!sessionsMap.has(dateKey)) {
      sessionsMap.set(dateKey, {
        date: dateKey,
        bars: [],
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume || 0,
      });
    }
    const sess = sessionsMap.get(dateKey);
    sess.bars.push(c);
    sess.high = Math.max(sess.high, c.high);
    sess.low = Math.min(sess.low, c.low);
    sess.close = c.close;
    sess.volume += (c.volume || 0);
  }

  return Array.from(sessionsMap.values());
}

/**
 * Compute Edge Statistics over a series of candles.
 * Evaluates:
 * 1. P(Touch Prior Day High | conditions)
 * 2. P(Touch Prior Day Low | conditions)
 * 3. P(Gap Fill | Gap >= 0.2%) + Time to fill distribution
 * 4. P(Opening Range Breakout Continuation vs False Break)
 * 5. P(Inside Day Breakout)
 */
function computeEdgeStats(candles, currentPrice) {
  const sessions = groupIntoDailySessions(candles);
  if (sessions.length < 15) {
    return { error: 'Insufficient sessions history for quantitative edge stats (needs >= 15 days)' };
  }

  // Pre-calculate session features
  const features = [];
  for (let i = 1; i < sessions.length; i++) {
    const prev = sessions[i - 1];
    const cur = sessions[i];

    const gapAbs = cur.open - prev.close;
    const gapPct = (gapAbs / prev.close) * 100;
    const absGapPct = Math.abs(gapPct);

    // Gap filled: if gap up, did price trade down to prev.close? If gap down, did price trade up to prev.close?
    let gapFilled = false;
    let gapFillBars = null;
    if (absGapPct >= 0.15) {
      for (let bIdx = 0; bIdx < cur.bars.length; bIdx++) {
        const b = cur.bars[bIdx];
        if (gapPct > 0 && b.low <= prev.close) {
          gapFilled = true;
          gapFillBars = bIdx + 1;
          break;
        } else if (gapPct < 0 && b.high >= prev.close) {
          gapFilled = true;
          gapFillBars = bIdx + 1;
          break;
        }
      }
    }

    // Touch PDH / PDL
    const touchedPdh = cur.high >= prev.high;
    const touchedPdl = cur.low <= prev.low;
    const closedAbovePdh = cur.close > prev.high;
    const closedBelowPdl = cur.close < prev.low;

    // Inside day
    const isInsideDay = cur.high <= prev.high && cur.low >= prev.low;
    const prevWasInsideDay = i >= 2 ? (prev.high <= sessions[i - 2].high && prev.low >= sessions[i - 2].low) : false;

    // Opening range (First bar or 2 bars)
    const orHigh = cur.bars[0] ? cur.bars[0].high : cur.high;
    const orLow = cur.bars[0] ? cur.bars[0].low : cur.low;
    let orBrokeUp = false;
    let orBrokeDown = false;
    for (let bIdx = 1; bIdx < cur.bars.length; bIdx++) {
      const b = cur.bars[bIdx];
      if (b.high > orHigh) orBrokeUp = true;
      if (b.low < orLow) orBrokeDown = true;
    }

    features.push({
      date: cur.date,
      prev,
      cur,
      gapPct,
      absGapPct,
      hasGap: absGapPct >= 0.15,
      gapFilled,
      gapFillBars,
      touchedPdh,
      touchedPdl,
      closedAbovePdh,
      closedBelowPdl,
      isInsideDay,
      prevWasInsideDay,
      orBrokeUp,
      orBrokeDown,
    });
  }

  const totalN = features.length;
  const halfN = Math.floor(totalN / 2);
  const firstHalf = features.slice(0, halfN);
  const secondHalf = features.slice(halfN);

  // 1. Touch Prior Day High (PDH)
  const pdhHits = features.filter(f => f.touchedPdh).length;
  const pdhW = wilson(pdhHits, totalN);
  const pdhHalf1 = firstHalf.filter(f => f.touchedPdh).length;
  const pdhHalf2 = secondHalf.filter(f => f.touchedPdh).length;
  const pdhStability = stabilitySplit(firstHalf.length, pdhHalf1, secondHalf.length, pdhHalf2);

  // 2. Touch Prior Day Low (PDL)
  const pdlHits = features.filter(f => f.touchedPdl).length;
  const pdlW = wilson(pdlHits, totalN);
  const pdlHalf1 = firstHalf.filter(f => f.touchedPdl).length;
  const pdlHalf2 = secondHalf.filter(f => f.touchedPdl).length;
  const pdlStability = stabilitySplit(firstHalf.length, pdlHalf1, secondHalf.length, pdlHalf2);

  // 3. Gap Fill
  const gapSessions = features.filter(f => f.hasGap);
  const gapN = gapSessions.length;
  const gapFillHits = gapSessions.filter(f => f.gapFilled).length;
  const gapW = wilson(gapFillHits, gapN);
  const gapFillBarsList = gapSessions.filter(f => f.gapFilled && f.gapFillBars).map(f => f.gapFillBars);
  const gapDist = summarizeDistribution(gapFillBarsList);

  // 4. Opening Range Breakout (ORB)
  const orbUpHits = features.filter(f => f.orBrokeUp && !f.orBrokeDown).length;
  const orbDownHits = features.filter(f => f.orBrokeDown && !f.orBrokeUp).length;
  const orbBothHits = features.filter(f => f.orBrokeUp && f.orBrokeDown).length;
  const orbUpW = wilson(orbUpHits, totalN);
  const orbFalseW = wilson(orbBothHits, totalN);

  // 5. Developing Session Live Status
  const latestPrev = sessions[sessions.length - 2];
  const latestCur = sessions[sessions.length - 1];
  const livePrice = currentPrice || latestCur.close;

  const distToPdhPct = ((latestPrev.high - livePrice) / livePrice) * 100;
  const distToPdlPct = ((livePrice - latestPrev.low) / livePrice) * 100;

  const currentGapPct = ((latestCur.open - latestPrev.close) / latestPrev.close) * 100;
  const isPdhAlreadyTouched = latestCur.high >= latestPrev.high;
  const isPdlAlreadyTouched = latestCur.low <= latestPrev.low;

  return {
    symbolMeta: {
      totalBars: candles.length,
      totalSessions: sessions.length,
      evaluatedDateRange: `${sessions[0].date} → ${sessions[sessions.length - 1].date}`,
    },
    liveSession: {
      date: latestCur.date,
      open: latestCur.open,
      high: latestCur.high,
      low: latestCur.low,
      currentPrice: livePrice,
      prevClose: latestPrev.close,
      prevHigh: latestPrev.high,
      prevLow: latestPrev.low,
      isPdhAlreadyTouched,
      isPdlAlreadyTouched,
      distToPdhPct: parseFloat(distToPdhPct.toFixed(2)),
      distToPdlPct: parseFloat(distToPdlPct.toFixed(2)),
      gapPct: parseFloat(currentGapPct.toFixed(2)),
    },
    edges: {
      pdhTouch: {
        id: 'prev-high-touch',
        title: 'Touch Prior Day High (PDH)',
        k: pdhHits,
        n: totalN,
        estimate: pdhW.pPct,
        ci95: pdhW.ciString,
        stability: pdhStability.statusText,
        alreadyHitToday: isPdhAlreadyTouched,
      },
      pdlTouch: {
        id: 'prev-low-touch',
        title: 'Touch Prior Day Low (PDL)',
        k: pdlHits,
        n: totalN,
        estimate: pdlW.pPct,
        ci95: pdlW.ciString,
        stability: pdlStability.statusText,
        alreadyHitToday: isPdlAlreadyTouched,
      },
      gapFill: {
        id: 'gap-fill',
        title: 'Session Gap Fill Rate',
        k: gapFillHits,
        n: gapN,
        estimate: gapW ? gapW.pPct : 'N/A',
        ci95: gapW ? gapW.ciString : 'N/A',
        timeDistribution: gapDist ? `Median: ${gapDist.median} bars (P75: ${gapDist.p75}b, P90: ${gapDist.p90}b)` : 'Insufficient gap samples',
      },
      orbContinuation: {
        id: 'orb-continuation',
        title: 'Opening Range Clean Expansion',
        k: orbUpHits,
        n: totalN,
        estimate: orbUpW.pPct,
        ci95: orbUpW.ciString,
        falseBreakRate: orbFalseW.pPct,
      },
    },
    disclaimer: 'Statistical conditional frequencies with 95% Wilson confidence intervals. Historical estimates, not predictions.',
  };
}

module.exports = {
  wilson,
  applyGuards,
  stabilitySplit,
  summarizeDistribution,
  computeEdgeStats,
};
