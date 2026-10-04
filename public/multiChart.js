/**
 * Hyperview Multi-Chart Grid & Layout Manager (Phase 3 - Vela Multi-Chart Architecture)
 * Supports 1 (Single), 2V (Vertical Split), 2H (Horizontal Split), and 4 (2x2 Grid)
 * Pre-loaded with Technical Indicators (EMA 20, EMA 50, Reaction Level Matrix S/R Lines, Volume)
 * Full Watchlist token integration and Persistent Session Auto-Save & Restore
 */

(function (window) {
  'use strict';

  function calculateEMA(candles, period) {
    if (!candles || candles.length < period) return [];
    const k = 2 / (period + 1);
    const result = [];
    
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += candles[i].close;
    }
    let ema = sum / period;
    result.push({ time: candles[period - 1].time, value: parseFloat(ema.toFixed(4)) });

    for (let i = period; i < candles.length; i++) {
      ema = (candles[i].close - ema) * k + ema;
      result.push({ time: candles[i].time, value: parseFloat(ema.toFixed(4)) });
    }
    return result;
  }

  class MultiChartManager {
    constructor() {
      this.currentLayout = '1';
      this.charts = {}; // { 'cell-2': { chart, candleSeries, volumeSeries, ema20Series, ema50Series, priceLines: [], symbol, timeframe } }
      this.isSyncCrosshair = true;
      this.defaultConfigs = {
        '2': { symbol: 'BINANCE:ETHUSDT', timeframe: '60' },
        '3': { symbol: 'BINANCE:SOLUSDT', timeframe: '15' },
        '4': { symbol: 'HYPERLIQUID:HYPE', timeframe: '60' },
      };
      this.watchlist = [];
    }

    init(watchlist) {
      if (watchlist && watchlist.length) {
        this.watchlist = watchlist;
        this.populateWatchlistTokens(watchlist);
      }
      this.bindLayoutDropdown();
    }

    populateWatchlistTokens(items) {
      if (!items || !items.length) return;
      this.watchlist = items;

      ['2', '3', '4'].forEach(cellId => {
        const selectEl = document.getElementById('grid-sym-select-' + cellId);
        if (!selectEl) return;
        const currentVal = this.defaultConfigs[cellId]?.symbol || selectEl.value;

        let html = '';
        items.forEach(item => {
          const sym = item.symbol || item;
          const name = item.name || sym.split(':')[1] || sym;
          const isSelected = sym === currentVal;
          html += `<option value="${sym}" style="background-color: #131722; color: #f0f3f6;" ${isSelected ? 'selected' : ''}>${name}</option>`;
        });
        selectEl.innerHTML = html;

        if (currentVal && Array.from(selectEl.options).some(o => o.value === currentVal)) {
          selectEl.value = currentVal;
        }
      });
    }

    bindLayoutDropdown() {
      const btnMenu = document.getElementById('btn-layout-menu');
      const dropdown = document.getElementById('layout-dropdown');

      btnMenu?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const isHidden = dropdown.style.display === 'none' || !dropdown.style.display;
        dropdown.style.display = isHidden ? 'block' : 'none';
        btnMenu.classList.toggle('active', isHidden);
      });

      document.addEventListener('click', (e) => {
        if (dropdown && dropdown.style.display === 'block' && !e.target.closest('#layout-dropdown') && !e.target.closest('#btn-layout-menu')) {
          dropdown.style.display = 'none';
          btnMenu?.classList.remove('active');
        }
      });

      document.querySelectorAll('.layout-opt-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const l = btn.dataset.layout;
          if (l) {
            this.setLayout(l);
            dropdown.style.display = 'none';
            btnMenu?.classList.remove('active');
          }
        });
      });
    }

    setLayout(layout) {
      this.currentLayout = layout;
      const labelEl = document.getElementById('layout-current-label');
      const wrapper = document.getElementById('charts-grid-wrapper');
      if (!wrapper) return;

      const labels = {
        '1': '1 Chart',
        '2v': '2 Split (2V)',
        '2h': '2 Split (2H)',
        '4': '4 Grid (2x2)',
      };
      if (labelEl) labelEl.textContent = labels[layout] || '1 Chart';

      // Reset grid styles on wrapper
      wrapper.style.display = 'flex';
      wrapper.style.flexDirection = 'row';
      wrapper.style.flexWrap = 'nowrap';

      const cell1 = document.getElementById('chart-cell-1');
      const cell2 = document.getElementById('chart-cell-2');
      const cell3 = document.getElementById('chart-cell-3');
      const cell4 = document.getElementById('chart-cell-4');

      if (layout === '1') {
        cell1.style.width = '100%';
        cell1.style.height = '100%';
        cell1.style.display = 'flex';
        if (cell2) cell2.style.display = 'none';
        if (cell3) cell3.style.display = 'none';
        if (cell4) cell4.style.display = 'none';

      } else if (layout === '2v') {
        // Vertical Split: Side by Side (Left / Right)
        wrapper.style.flexDirection = 'row';
        cell1.style.width = '50%';
        cell1.style.height = '100%';
        cell1.style.display = 'flex';

        this.ensureChartCell('2', cell2);
        cell2.style.width = '50%';
        cell2.style.height = '100%';
        cell2.style.display = 'flex';

        if (cell3) cell3.style.display = 'none';
        if (cell4) cell4.style.display = 'none';

      } else if (layout === '2h') {
        // Horizontal Split: Top / Bottom
        wrapper.style.flexDirection = 'column';
        cell1.style.width = '100%';
        cell1.style.height = '50%';
        cell1.style.display = 'flex';

        this.ensureChartCell('2', cell2);
        cell2.style.width = '100%';
        cell2.style.height = '50%';
        cell2.style.display = 'flex';

        if (cell3) cell3.style.display = 'none';
        if (cell4) cell4.style.display = 'none';

      } else if (layout === '4') {
        // 4 Grid: 2 rows x 2 cols
        wrapper.style.flexDirection = 'row';
        wrapper.style.flexWrap = 'wrap';

        cell1.style.width = '50%';
        cell1.style.height = '50%';
        cell1.style.display = 'flex';

        this.ensureChartCell('2', cell2);
        cell2.style.width = '50%';
        cell2.style.height = '50%';
        cell2.style.display = 'flex';

        this.ensureChartCell('3', cell3);
        cell3.style.width = '50%';
        cell3.style.height = '50%';
        cell3.style.display = 'flex';

        this.ensureChartCell('4', cell4);
        cell4.style.width = '50%';
        cell4.style.height = '50%';
        cell4.style.display = 'flex';
      }

      // Trigger resize on all charts
      setTimeout(() => {
        if (typeof resizeChart === 'function') resizeChart();
        Object.values(this.charts).forEach(c => {
          if (c && c.chart && c.container) {
            c.chart.applyOptions({
              width: c.container.clientWidth,
              height: c.container.clientHeight,
            });
          }
        });
      }, 60);

      if (typeof triggerAutoSave === 'function') triggerAutoSave();
    }

    ensureChartCell(cellId, cellEl) {
      if (!cellEl) return;
      if (this.charts[cellId]) return; // Already instantiated

      const cfg = this.defaultConfigs[cellId] || { symbol: 'BINANCE:ETHUSDT', timeframe: '60' };
      const containerId = 'chart-container-' + cellId;
      const chartHost = document.getElementById(containerId);
      if (!chartHost) return;

      const chart = LightweightCharts.createChart(chartHost, {
        layout: { background: { color: '#0d111a' }, textColor: '#8c93a3' },
        grid: { vertLines: { color: '#161b26' }, horzLines: { color: '#161b26' } },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        timeScale: { borderColor: '#2b3040', timeVisible: true, rightOffset: 25, barSpacing: 8 },
        rightPriceScale: { borderColor: '#2b3040', autoScale: true, scaleMargins: { top: 0.1, bottom: 0.15 } },
      });

      const candleSeries = chart.addCandlestickSeries({
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderVisible: false,
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350',
      });

      // Technical Indicators for Secondary Windows:
      // 1. EMA 20 (Cyan)
      const ema20Series = chart.addLineSeries({
        color: '#38bdf8',
        lineWidth: 1.5,
        title: 'EMA 20',
        crosshairMarkerVisible: true,
      });

      // 2. EMA 50 (Amber)
      const ema50Series = chart.addLineSeries({
        color: '#f59e0b',
        lineWidth: 1.5,
        title: 'EMA 50',
        crosshairMarkerVisible: true,
      });

      // 3. Volume Histogram
      const volumeSeries = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: '',
      });
      volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

      const symSelect = document.getElementById('grid-sym-select-' + cellId);
      if (symSelect && cfg.symbol) {
        symSelect.value = cfg.symbol;
      }

      const activeTf = cfg.timeframe || '60';
      const tfButtons = cellEl.querySelectorAll('.grid-tf-btn');
      tfButtons.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tf === activeTf);
      });

      this.charts[cellId] = {
        chart,
        candleSeries,
        volumeSeries,
        ema20Series,
        ema50Series,
        priceLines: [],
        container: chartHost,
        symbol: cfg.symbol,
        timeframe: activeTf,
      };

      // Bind cell mini toolbar controls
      symSelect?.addEventListener('change', (e) => {
        this.charts[cellId].symbol = e.target.value;
        this.loadCellChart(cellId);
        if (typeof triggerAutoSave === 'function') triggerAutoSave();
      });

      tfButtons.forEach(btn => {
        btn.addEventListener('click', () => {
          tfButtons.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.charts[cellId].timeframe = btn.dataset.tf;
          this.loadCellChart(cellId);
          if (typeof triggerAutoSave === 'function') triggerAutoSave();
        });
      });

      this.loadCellChart(cellId);
    }

    async loadCellChart(cellId) {
      const c = this.charts[cellId];
      if (!c) return;

      try {
        const res = await fetch(`/api/history?symbol=${encodeURIComponent(c.symbol)}&timeframe=${encodeURIComponent(c.timeframe)}&range=1000`);
        const data = await res.json();
        if (data.candles && data.candles.length > 0) {
          c.candleSeries.setData(data.candles);
          c.volumeSeries.setData(data.candles.map(b => ({
            time: b.time,
            value: b.volume || 0,
            color: b.close >= b.open ? 'rgba(38, 166, 154, 0.45)' : 'rgba(239, 83, 80, 0.45)',
          })));

          // Calculate and set EMAs
          const ema20 = calculateEMA(data.candles, 20);
          if (ema20.length > 0) c.ema20Series.setData(ema20);

          const ema50 = calculateEMA(data.candles, 50);
          if (ema50.length > 0) c.ema50Series.setData(ema50);

          // Clear existing S/R price lines
          if (c.priceLines && c.priceLines.length > 0) {
            c.priceLines.forEach(pl => {
              try { c.candleSeries.removePriceLine(pl); } catch (e) {}
            });
            c.priceLines = [];
          }

          // Compute Support & Resistance levels from recent swing points (Reaction Level Matrix S/R)
          const recent = data.candles.slice(-150);
          let highRes = -Infinity;
          let lowSup = Infinity;
          for (const b of recent) {
            if (b.high > highRes) highRes = b.high;
            if (b.low < lowSup) lowSup = b.low;
          }

          if (highRes > 0 && lowSup > 0 && highRes !== lowSup) {
            const resLine = c.candleSeries.createPriceLine({
              price: highRes,
              color: '#ef5350',
              lineWidth: 1,
              lineStyle: LightweightCharts.LineStyle.Dashed,
              axisLabelVisible: true,
              title: 'RES',
            });
            const supLine = c.candleSeries.createPriceLine({
              price: lowSup,
              color: '#22c55e',
              lineWidth: 1,
              lineStyle: LightweightCharts.LineStyle.Dashed,
              axisLabelVisible: true,
              title: 'SUP',
            });
            c.priceLines.push(resLine, supLine);
          }

          const legendEl = document.getElementById('grid-legend-' + cellId);
          if (legendEl) {
            const last = data.candles[data.candles.length - 1];
            const lastEma20 = ema20.length > 0 ? ema20[ema20.length - 1].value : null;
            const lastEma50 = ema50.length > 0 ? ema50[ema50.length - 1].value : null;

            let legendText = `${c.symbol.split(':')[1] || c.symbol} [${c.timeframe}m]: $${last.close.toLocaleString()}`;
            if (lastEma20) legendText += ` <span style="color:#38bdf8;margin-left:4px;">E20:$${lastEma20}</span>`;
            if (lastEma50) legendText += ` <span style="color:#f59e0b;margin-left:4px;">E50:$${lastEma50}</span>`;
            legendEl.innerHTML = legendText;
          }
        }
      } catch (e) {}
    }
  }

  window.MultiChartManager = MultiChartManager;
  window.multiChartManagerInstance = new MultiChartManager();

})(window);
