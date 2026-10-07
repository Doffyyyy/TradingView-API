/**
 * HTF Accessor for Strategy V2.
 * Strictly guarantees ZERO lookahead bias when mapping 15M execution candles to 1H (and 4H) candles.
 * A 1H candle is ONLY accessible once its closing timestamp is strictly <= the closing timestamp of the 15M bar.
 */

class HtfAccessor {
  /**
   * @param {Array} candles15m 15M candles array
   * @param {Array} candles1h 1H candles array
   */
  constructor(candles15m, candles1h) {
    this.candles15m = candles15m;
    this.candles1h = candles1h;
    this.map15mTo1hIndex = new Int32Array(candles15m.length);

    this._precomputeMapping();
  }

  _precomputeMapping() {
    const n15 = this.candles15m.length;
    const n1 = this.candles1h.length;
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const FIFTEEN_MIN_MS = 15 * 60 * 1000;

    let h1Idx = 0;
    for (let i = 0; i < n15; i++) {
      const closeTime15m = this.candles15m[i].time + FIFTEEN_MIN_MS;
      
      // Advance h1Idx as long as the next 1h candle closes before or at closeTime15m
      while (h1Idx + 1 < n1 && (this.candles1h[h1Idx + 1].time + ONE_HOUR_MS) <= closeTime15m) {
        h1Idx++;
      }

      // Check if the current h1Idx candle is actually closed before or at closeTime15m
      if (h1Idx < n1 && (this.candles1h[h1Idx].time + ONE_HOUR_MS) <= closeTime15m) {
        this.map15mTo1hIndex[i] = h1Idx;
      } else {
        this.map15mTo1hIndex[i] = -1; // No closed 1h candle available yet
      }
    }
  }

  /**
   * Returns the index of the latest closed 1H candle for a given 15M bar index.
   * @param {number} index15m 
   * @returns {number} 1H candle index, or -1 if none available yet
   */
  getLastClosed1hIndex(index15m) {
    if (index15m < 0 || index15m >= this.map15mTo1hIndex.length) return -1;
    return this.map15mTo1hIndex[index15m];
  }

  /**
   * Returns the latest closed 1H candle object.
   * @param {number} index15m 
   * @returns {object|null}
   */
  getLastClosed1hCandle(index15m) {
    const idx = this.getLastClosed1hIndex(index15m);
    if (idx === -1) return null;
    return this.candles1h[idx];
  }
}

module.exports = {
  HtfAccessor,
};
