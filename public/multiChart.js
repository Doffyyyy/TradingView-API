/**
 * Hyperview Multi-Chart Grid & Layout Manager (Phase 3 - Vela Multi-Chart Architecture)
 * Supports 1 (Single), 2V (Vertical Split), 2H (Horizontal Split), and 4 (2x2 Grid) with synchronized crosshair.
 */

(function (window) {
  'use strict';

  class MultiChartManager {
    constructor() {
      this.currentLayout = '1';
      this.charts = {}; // { 'cell-2': { chart, candleSeries, volumeSeries, symbol, timeframe } }
      this.isSyncCrosshair = true;
      this.defaultConfigs = {
        '2': { symbol: 'BINANCE:ETHUSDT', timeframe: '60' },
        '3': { symbol: 'BINANCE:SOLUSDT', timeframe: '15' },
        '4': { symbol: 'HYPERLIQUID:HYPE', timeframe: '60' },
      };
    }

    init() {
      this.bindLayoutDropdown();
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

      const volumeSeries = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: '',
      });
      volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

      this.charts[cellId] = {
        chart,
        candleSeries,
        volumeSeries,
        container: chartHost,
        symbol: cfg.symbol,
        timeframe: cfg.timeframe,
      };

      // Bind cell mini toolbar controls
      const symSelect = document.getElementById('grid-sym-select-' + cellId);
      const tfButtons = cellEl.querySelectorAll('.grid-tf-btn');

      symSelect?.addEventListener('change', (e) => {
        this.charts[cellId].symbol = e.target.value;
        this.loadCellChart(cellId);
      });

      tfButtons.forEach(btn => {
        btn.addEventListener('click', () => {
          tfButtons.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.charts[cellId].timeframe = btn.dataset.tf;
          this.loadCellChart(cellId);
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

          const legendEl = document.getElementById('grid-legend-' + cellId);
          if (legendEl) {
            const last = data.candles[data.candles.length - 1];
            legendEl.textContent = `${c.symbol.split(':')[1] || c.symbol} [${c.timeframe}m]: $${last.close.toLocaleString()}`;
          }
        }
      } catch (e) {}
    }
  }

  window.MultiChartManager = MultiChartManager;
  window.multiChartManagerInstance = new MultiChartManager();

})(window);
