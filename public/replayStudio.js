/**
 * Hyperview Interactive Market Replay Studio (Phase 3 - Vela Replay Architecture)
 * Full bar-by-bar walkforward simulation with visual playback controls, speed selection, and instant rewind.
 */

(function (window) {
  'use strict';

  class ReplayStudio {
    constructor() {
      this.container = null;
      this.chart = null;
      this.candleSeries = null;
      this.volumeSeries = null;
      this.symbol = 'BINANCE:BTCUSDT';
      this.timeframe = '60';
      this.allCandles = [];
      this.currentIndex = 0;
      this.startIndex = 0;
      this.isPlaying = false;
      this.speed = 1; // 1x = 800ms, 2x = 400ms, 5x = 160ms, 10x = 80ms
      this.playTimer = null;
      this.isInitialized = false;
    }

    init(containerEl) {
      if (!containerEl) return;
      this.container = containerEl;

      if (!this.chart && typeof LightweightCharts !== 'undefined') {
        this.chart = LightweightCharts.createChart(this.container, {
          layout: { background: { color: '#0d111a' }, textColor: '#8c93a3' },
          grid: { vertLines: { color: '#161b26' }, horzLines: { color: '#161b26' } },
          crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
          timeScale: {
            borderColor: '#2b3040',
            timeVisible: true,
            rightOffset: 25,
            barSpacing: 9,
          },
          rightPriceScale: {
            borderColor: '#2b3040',
            autoScale: true,
            scaleMargins: { top: 0.1, bottom: 0.18 },
          },
        });

        this.candleSeries = this.chart.addCandlestickSeries({
          upColor: '#26a69a',
          downColor: '#ef5350',
          borderVisible: false,
          wickUpColor: '#26a69a',
          wickDownColor: '#ef5350',
        });

        this.volumeSeries = this.chart.addHistogramSeries({
          priceFormat: { type: 'volume' },
          priceScaleId: '',
        });

        this.volumeSeries.priceScale().applyOptions({
          scaleMargins: { top: 0.82, bottom: 0 },
        });

        window.addEventListener('resize', () => this.resize());
      }

      this.bindUI();
      this.isInitialized = true;
      this.loadReplayData(this.symbol, this.timeframe);
    }

    resize() {
      if (this.chart && this.container) {
        this.chart.applyOptions({
          width: this.container.clientWidth,
          height: this.container.clientHeight,
        });
      }
    }

    bindUI() {
      // Symbol chips
      document.querySelectorAll('.rep-chip-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.rep-chip-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          const sym = btn.dataset.sym;
          if (sym) {
            document.getElementById('rep-symbol-input').value = sym;
            this.symbol = sym;
            this.loadReplayData(this.symbol, this.timeframe);
          }
        });
      });

      // Timeframe buttons
      document.querySelectorAll('.rep-tf-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.rep-tf-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          const tf = btn.dataset.tf;
          if (tf) {
            this.timeframe = tf;
            this.loadReplayData(this.symbol, this.timeframe);
          }
        });
      });

      // Load button
      document.getElementById('btn-rep-load')?.addEventListener('click', () => {
        const inp = document.getElementById('rep-symbol-input')?.value.trim();
        if (inp) {
          this.symbol = inp;
          this.loadReplayData(this.symbol, this.timeframe);
        }
      });

      // Controls
      document.getElementById('btn-rep-reset')?.addEventListener('click', () => this.reset());
      document.getElementById('btn-rep-step-back')?.addEventListener('click', () => this.stepBack());
      document.getElementById('btn-rep-play')?.addEventListener('click', () => this.togglePlay());
      document.getElementById('btn-rep-step-fwd')?.addEventListener('click', () => this.stepForward());

      // Speed selection
      document.querySelectorAll('.rep-speed-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.rep-speed-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.speed = parseFloat(btn.dataset.speed) || 1;
          if (this.isPlaying) {
            this.pause();
            this.play();
          }
        });
      });

      // Timeline Progress Slider
      const slider = document.getElementById('rep-slider');
      if (slider) {
        slider.addEventListener('input', (e) => {
          const val = parseInt(e.target.value, 10);
          this.jumpToIndex(val);
        });
      }
    }

    async loadReplayData(sym, tf) {
      this.pause();
      const statusEl = document.getElementById('rep-status-text');
      if (statusEl) statusEl.textContent = 'Loading historical candles...';

      try {
        const res = await fetch(`/api/history?symbol=${encodeURIComponent(sym)}&timeframe=${encodeURIComponent(tf)}&range=1000`);
        const data = await res.json();
        if (!data.candles || data.candles.length === 0) {
          if (statusEl) statusEl.textContent = 'Failed to load historical data.';
          return;
        }

        this.allCandles = data.candles;
        const total = this.allCandles.length;

        // Default cut-off: Reveal first 75% of candles, leaving last 25% for replay
        this.startIndex = Math.max(20, Math.floor(total * 0.70));
        this.currentIndex = this.startIndex;

        // Update Slider
        const slider = document.getElementById('rep-slider');
        if (slider) {
          slider.min = '20';
          slider.max = String(total - 1);
          slider.value = String(this.currentIndex);
        }

        this.updateChart();
        if (statusEl) statusEl.textContent = `Ready: ${total} bars loaded. Replay starts at bar ${this.startIndex}.`;
      } catch (e) {
        if (statusEl) statusEl.textContent = 'Error: ' + e.message;
      }
    }

    updateChart() {
      if (!this.candleSeries || this.allCandles.length === 0) return;
      const visible = this.allCandles.slice(0, this.currentIndex + 1);
      this.candleSeries.setData(visible);
      this.volumeSeries.setData(visible.map(c => ({
        time: c.time,
        value: c.volume || 0,
        color: c.close >= c.open ? 'rgba(38, 166, 154, 0.45)' : 'rgba(239, 83, 80, 0.45)',
      })));

      this.updateReadout();
    }

    updateReadout() {
      if (this.allCandles.length === 0) return;
      const cur = this.allCandles[this.currentIndex];
      const start = this.allCandles[this.startIndex];
      if (!cur || !start) return;

      const pnlPct = ((cur.close - start.close) / start.close) * 100;
      const pnlSign = pnlPct >= 0 ? '+' : '';
      const pnlClass = pnlPct >= 0 ? 'val-green' : 'val-red';

      const d = new Date(cur.time * 1000);
      const dateStr = d.toLocaleDateString('vi-VN') + ' ' + d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

      const priceStr = cur.close >= 1 ? cur.close.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : cur.close.toFixed(4);

      const curPriceEl = document.getElementById('rep-cur-price');
      if (curPriceEl) curPriceEl.textContent = '$' + priceStr;

      const pnlEl = document.getElementById('rep-pnl-change');
      if (pnlEl) {
        pnlEl.textContent = `${pnlSign}${pnlPct.toFixed(2)}%`;
        pnlEl.className = 'rep-stat-val ' + pnlClass;
      }

      const barCountEl = document.getElementById('rep-bar-count');
      if (barCountEl) {
        const replayed = this.currentIndex - this.startIndex;
        barCountEl.textContent = `${this.currentIndex + 1} / ${this.allCandles.length} (+${replayed} bars)`;
      }

      const barTimeEl = document.getElementById('rep-bar-time');
      if (barTimeEl) barTimeEl.textContent = dateStr;

      const slider = document.getElementById('rep-slider');
      if (slider && parseInt(slider.value, 10) !== this.currentIndex) {
        slider.value = String(this.currentIndex);
      }
    }

    stepForward() {
      if (this.currentIndex < this.allCandles.length - 1) {
        this.currentIndex++;
        const nextBar = this.allCandles[this.currentIndex];
        this.candleSeries.update(nextBar);
        this.volumeSeries.update({
          time: nextBar.time,
          value: nextBar.volume || 0,
          color: nextBar.close >= nextBar.open ? 'rgba(38, 166, 154, 0.45)' : 'rgba(239, 83, 80, 0.45)',
        });
        this.updateReadout();
      } else {
        this.pause();
        const statusEl = document.getElementById('rep-status-text');
        if (statusEl) statusEl.textContent = '🏁 Replay simulation reached the end of history.';
      }
    }

    stepBack() {
      if (this.currentIndex > 20) {
        this.currentIndex--;
        this.updateChart();
      }
    }

    jumpToIndex(idx) {
      if (idx >= 20 && idx < this.allCandles.length) {
        this.currentIndex = idx;
        this.updateChart();
      }
    }

    reset() {
      this.pause();
      this.currentIndex = this.startIndex;
      this.updateChart();
      const statusEl = document.getElementById('rep-status-text');
      if (statusEl) statusEl.textContent = 'Reset to start cut-off position.';
    }

    play() {
      if (this.currentIndex >= this.allCandles.length - 1) {
        this.currentIndex = this.startIndex;
        this.updateChart();
      }
      this.isPlaying = true;
      const playBtn = document.getElementById('btn-rep-play');
      if (playBtn) {
        playBtn.innerHTML = '<span style="font-size: 14px;">⏸</span> <span>Pause</span>';
        playBtn.classList.add('playing');
      }
      const ms = Math.max(50, Math.floor(800 / this.speed));
      this.playTimer = setInterval(() => this.stepForward(), ms);
    }

    pause() {
      this.isPlaying = false;
      if (this.playTimer) {
        clearInterval(this.playTimer);
        this.playTimer = null;
      }
      const playBtn = document.getElementById('btn-rep-play');
      if (playBtn) {
        playBtn.innerHTML = '<span style="font-size: 14px;">▶</span> <span>Play</span>';
        playBtn.classList.remove('playing');
      }
    }

    togglePlay() {
      if (this.isPlaying) {
        this.pause();
      } else {
        this.play();
      }
    }
  }

  window.ReplayStudio = ReplayStudio;
  window.replayStudioInstance = new ReplayStudio();

})(window);
