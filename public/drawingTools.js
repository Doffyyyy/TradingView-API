/**
 * Hyperview Professional Drawing Tools Suite (Phase 2 - Vela Architecture)
 * Supports Trendline, Horizontal Line, Ray, Rectangle Box, Fibonacci Retracement, Long/Short Position R:R Box, Magnet Mode, and Per-Symbol Persistence.
 */

(function (window) {
  'use strict';

  class DrawingEngine {
    constructor() {
      this.chart = null;
      this.candleSeries = null;
      this.container = null;
      this.canvas = null;
      this.ctx = null;
      this.currentSymbol = 'BTC';
      this.activeTool = 'cursor'; // 'cursor', 'trendline', 'ray', 'horizontal', 'box', 'fib', 'long_pos', 'short_pos'
      this.isMagnetActive = false;
      this.drawings = []; // Array of drawing objects
      this.inProgressDrawing = null;
      this.selectedDrawing = null;
      this.hoveredDrawing = null;
      this.mousePos = { x: 0, y: 0 };
      this.isDrawing = false;
      this.dpr = window.devicePixelRatio || 1;
    }

    init(chartInstance, seriesInstance, containerEl, initialSymbol = 'BTC') {
      this.chart = chartInstance;
      this.candleSeries = seriesInstance;
      this.container = containerEl;
      this.currentSymbol = initialSymbol;

      // Create overlay canvas if not exists
      let c = document.getElementById('chart-drawing-canvas');
      if (!c) {
        c = document.createElement('canvas');
        c.id = 'chart-drawing-canvas';
        c.style.position = 'absolute';
        c.style.top = '0';
        c.style.left = '0';
        c.style.width = '100%';
        c.style.height = '100%';
        c.style.zIndex = '6';
        c.style.pointerEvents = 'none'; // Controlled dynamically
        this.container.appendChild(c);
      }
      this.canvas = c;
      this.ctx = c.getContext('2d');

      this.resizeCanvas();
      this.bindEvents();
      this.loadDrawingsForSymbol(this.currentSymbol);
    }

    resizeCanvas() {
      if (!this.canvas || !this.container) return;
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      this.dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.floor(w * this.dpr);
      this.canvas.height = Math.floor(h * this.dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      if (this.ctx) {
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.scale(this.dpr, this.dpr);
      }
      this.render();
    }

    setSymbol(newSymbol) {
      if (newSymbol === this.currentSymbol) return;
      this.saveDrawingsForSymbol(this.currentSymbol);
      this.currentSymbol = newSymbol;
      this.selectedDrawing = null;
      this.inProgressDrawing = null;
      this.loadDrawingsForSymbol(newSymbol);
    }

    setActiveTool(tool) {
      this.activeTool = tool;
      this.inProgressDrawing = null;
      this.selectedDrawing = null;
      if (this.canvas) {
        if (tool === 'cursor') {
          this.canvas.style.pointerEvents = 'none';
          this.container.style.cursor = 'default';
        } else {
          this.canvas.style.pointerEvents = 'auto';
          this.container.style.cursor = 'crosshair';
        }
      }
      this.updateToolbarUI();
      this.render();
    }

    toggleMagnet() {
      this.isMagnetActive = !this.isMagnetActive;
      const btn = document.getElementById('draw-tool-magnet');
      if (btn) btn.classList.toggle('active', this.isMagnetActive);
    }

    updateToolbarUI() {
      document.querySelectorAll('.draw-tool-btn').forEach(b => {
        const t = b.dataset.tool;
        if (t && t !== 'magnet' && t !== 'trash') {
          b.classList.toggle('active', t === this.activeTool);
        }
      });
    }

    // Convert screen (x, y) to { time, price }
    screenToChart(x, y) {
      if (!this.chart || !this.candleSeries) return null;
      let time = this.chart.timeScale().coordinateToTime(x);
      let price = this.candleSeries.coordinateToPrice(y);

      // If magnet is active, snap to nearest candle OHLC
      if (this.isMagnetActive && typeof currentCandlesCache !== 'undefined' && currentCandlesCache.length > 0) {
        const timeScale = this.chart.timeScale();
        let nearestBar = null;
        let minDist = 30; // 30px snap threshold

        for (let i = currentCandlesCache.length - 1; i >= 0; i--) {
          const b = currentCandlesCache[i];
          const bx = timeScale.timeToCoordinate(b.time);
          if (bx !== null) {
            const dist = Math.abs(bx - x);
            if (dist < minDist) {
              minDist = dist;
              nearestBar = b;
            }
          }
        }

        if (nearestBar) {
          time = nearestBar.time;
          const candidates = [nearestBar.open, nearestBar.high, nearestBar.low, nearestBar.close];
          let bestPrice = price;
          let minPriceDist = Infinity;
          for (const cand of candidates) {
            const cy = this.candleSeries.priceToCoordinate(cand);
            if (cy !== null && Math.abs(cy - y) < minPriceDist) {
              minPriceDist = Math.abs(cy - y);
              bestPrice = cand;
            }
          }
          price = bestPrice;
        }
      }

      return { time, price };
    }

    // Convert { time, price } to screen (x, y)
    chartToScreen(pt) {
      if (!this.chart || !this.candleSeries || !pt) return null;
      const x = this.chart.timeScale().timeToCoordinate(pt.time);
      const y = this.candleSeries.priceToCoordinate(pt.price);
      if (x === null || y === null || isNaN(x) || isNaN(y)) return null;
      return { x, y };
    }

    bindEvents() {
      // Re-render when chart scales or pans
      if (this.chart) {
        this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => this.render());
      }
      window.addEventListener('resize', () => this.resizeCanvas());

      // Mouse events on canvas
      this.canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
      this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
      this.canvas.addEventListener('mouseup', (e) => this.handleMouseUp(e));

      // Key listener for Delete
      window.addEventListener('keydown', (e) => {
        if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedDrawing) {
          this.removeDrawing(this.selectedDrawing);
        } else if (e.key === 'Escape') {
          this.setActiveTool('cursor');
        }
      });
    }

    handleMouseDown(e) {
      if (this.activeTool === 'cursor') return;
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const pt = this.screenToChart(x, y);
      if (!pt || !pt.time || !pt.price) return;

      if (!this.isDrawing) {
        // Start new drawing
        this.isDrawing = true;
        this.inProgressDrawing = {
          id: 'draw_' + Date.now(),
          type: this.activeTool,
          points: [pt],
          color: this.getDefaultColorForTool(this.activeTool),
          lineWidth: 2,
        };

        // Single-click tools: Horizontal line or Long/Short position
        if (this.activeTool === 'horizontal') {
          this.finishDrawing();
        } else if (this.activeTool === 'long_pos') {
          const entry = pt.price;
          const tp = entry * 1.018; // +1.8%
          const sl = entry * 0.991; // -0.9% (2:1 RR)
          this.inProgressDrawing.entryPrice = entry;
          this.inProgressDrawing.takeProfit = tp;
          this.inProgressDrawing.stopLoss = sl;
          this.finishDrawing();
        } else if (this.activeTool === 'short_pos') {
          const entry = pt.price;
          const tp = entry * 0.982; // -1.8%
          const sl = entry * 1.009; // +0.9% (2:1 RR)
          this.inProgressDrawing.entryPrice = entry;
          this.inProgressDrawing.takeProfit = tp;
          this.inProgressDrawing.stopLoss = sl;
          this.finishDrawing();
        }
      } else {
        // Second point clicked
        this.inProgressDrawing.points.push(pt);
        this.finishDrawing();
      }
      this.render();
    }

    handleMouseMove(e) {
      const rect = this.canvas.getBoundingClientRect();
      this.mousePos.x = e.clientX - rect.left;
      this.mousePos.y = e.clientY - rect.top;

      if (this.isDrawing && this.inProgressDrawing) {
        const pt = this.screenToChart(this.mousePos.x, this.mousePos.y);
        if (pt) {
          this.inProgressDrawing.tempPoint = pt;
          this.render();
        }
      }
    }

    handleMouseUp() {
      // For drag-based creation if desired
    }

    finishDrawing() {
      if (!this.inProgressDrawing) return;
      delete this.inProgressDrawing.tempPoint;
      this.drawings.push(this.inProgressDrawing);
      this.selectedDrawing = this.inProgressDrawing;
      this.inProgressDrawing = null;
      this.isDrawing = false;
      this.saveDrawingsForSymbol(this.currentSymbol);
      this.setActiveTool('cursor');
    }

    removeDrawing(d) {
      const idx = this.drawings.indexOf(d);
      if (idx !== -1) {
        this.drawings.splice(idx, 1);
        this.selectedDrawing = null;
        this.saveDrawingsForSymbol(this.currentSymbol);
        this.render();
      }
    }

    clearAllDrawings() {
      if (confirm('Clear all drawings on ' + this.currentSymbol + '?')) {
        this.drawings = [];
        this.selectedDrawing = null;
        this.saveDrawingsForSymbol(this.currentSymbol);
        this.render();
      }
    }

    getDefaultColorForTool(tool) {
      switch (tool) {
        case 'trendline': return '#38bdf8'; // Sky blue
        case 'ray': return '#a855f7'; // Purple
        case 'horizontal': return '#f59e0b'; // Amber
        case 'box': return 'rgba(56, 189, 248, 0.2)'; // Blue zone
        case 'fib': return '#c084fc'; // Violet
        case 'long_pos': return '#10b981'; // Emerald green
        case 'short_pos': return '#ef4444'; // Red
        default: return '#38bdf8';
      }
    }

    saveDrawingsForSymbol(sym) {
      try {
        localStorage.setItem('hyperview_drawings_' + sym, JSON.stringify(this.drawings));
      } catch (e) {}
    }

    loadDrawingsForSymbol(sym) {
      try {
        const raw = localStorage.getItem('hyperview_drawings_' + sym);
        this.drawings = raw ? JSON.parse(raw) : [];
      } catch (e) {
        this.drawings = [];
      }
      this.render();
    }

    // --- Main Canvas Render Loop ---
    render() {
      if (!this.ctx || !this.canvas) return;
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      this.ctx.clearRect(0, 0, w, h);

      // Render completed drawings
      for (const d of this.drawings) {
        this.renderDrawing(d, d === this.selectedDrawing);
      }

      // Render drawing in progress
      if (this.inProgressDrawing) {
        this.renderDrawing(this.inProgressDrawing, true);
      }
    }

    renderDrawing(d, isSelected) {
      const ctx = this.ctx;
      if (!ctx) return;

      const p1 = d.points[0];
      const p2 = d.points[1] || d.tempPoint || p1;
      const s1 = this.chartToScreen(p1);
      const s2 = this.chartToScreen(p2);

      ctx.save();

      if (d.type === 'trendline') {
        if (!s1 || !s2) { ctx.restore(); return; }
        ctx.strokeStyle = d.color || '#38bdf8';
        ctx.lineWidth = d.lineWidth || 2;
        ctx.beginPath();
        ctx.moveTo(s1.x, s1.y);
        ctx.lineTo(s2.x, s2.y);
        ctx.stroke();

        // End anchor circles
        this.drawHandle(s1.x, s1.y, isSelected);
        this.drawHandle(s2.x, s2.y, isSelected);

      } else if (d.type === 'ray') {
        if (!s1 || !s2) { ctx.restore(); return; }
        ctx.strokeStyle = d.color || '#a855f7';
        ctx.lineWidth = d.lineWidth || 2;
        const dx = s2.x - s1.x;
        const dy = s2.y - s1.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const extX = s1.x + (dx / len) * 3000;
        const extY = s1.y + (dy / len) * 3000;

        ctx.beginPath();
        ctx.moveTo(s1.x, s1.y);
        ctx.lineTo(extX, extY);
        ctx.stroke();
        this.drawHandle(s1.x, s1.y, isSelected);

      } else if (d.type === 'horizontal') {
        if (!s1) { ctx.restore(); return; }
        ctx.strokeStyle = d.color || '#f59e0b';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(0, s1.y);
        ctx.lineTo(this.canvas.clientWidth, s1.y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Badge at right edge
        const pxText = '$' + (p1.price >= 1 ? p1.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : p1.price.toFixed(4));
        this.drawPriceBadge(this.canvas.clientWidth - 75, s1.y, pxText, '#f59e0b');

      } else if (d.type === 'box') {
        if (!s1 || !s2) { ctx.restore(); return; }
        const minX = Math.min(s1.x, s2.x);
        const maxX = Math.max(s1.x, s2.x);
        const minY = Math.min(s1.y, s2.y);
        const maxY = Math.max(s1.y, s2.y);
        const boxW = Math.max(2, maxX - minX);
        const boxH = Math.max(2, maxY - minY);

        ctx.fillStyle = 'rgba(56, 189, 248, 0.15)';
        ctx.fillRect(minX, minY, boxW, boxH);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(minX, minY, boxW, boxH);

        this.drawHandle(minX, minY, isSelected);
        this.drawHandle(maxX, maxY, isSelected);

      } else if (d.type === 'fib') {
        if (!s1 || !s2) { ctx.restore(); return; }
        const levels = [
          { r: 0.0, c: '#787b86', lbl: '0.0' },
          { r: 0.236, c: '#ef5350', lbl: '0.236' },
          { r: 0.382, c: '#f59e0b', lbl: '0.382' },
          { r: 0.5, c: '#10b981', lbl: '0.5' },
          { r: 0.618, c: '#fbbf24', lbl: '0.618 (Golden)' },
          { r: 0.786, c: '#38bdf8', lbl: '0.786' },
          { r: 1.0, c: '#a855f7', lbl: '1.0' },
        ];

        const leftX = Math.min(s1.x, s2.x);
        const rightX = Math.max(s1.x, s2.x) + 40;
        const diffP = p2.price - p1.price;

        // Golden pocket tint
        const p05 = p1.price + diffP * 0.5;
        const p0618 = p1.price + diffP * 0.618;
        const y05 = this.candleSeries.priceToCoordinate(p05);
        const y0618 = this.candleSeries.priceToCoordinate(p0618);
        if (y05 !== null && y0618 !== null) {
          ctx.fillStyle = 'rgba(251, 191, 36, 0.12)';
          ctx.fillRect(leftX, Math.min(y05, y0618), rightX - leftX, Math.abs(y0618 - y05));
        }

        levels.forEach(lv => {
          const lPrice = p1.price + diffP * lv.r;
          const ly = this.candleSeries.priceToCoordinate(lPrice);
          if (ly !== null) {
            ctx.strokeStyle = lv.c;
            ctx.lineWidth = lv.r === 0.618 ? 2 : 1;
            ctx.beginPath();
            ctx.moveTo(leftX, ly);
            ctx.lineTo(rightX, ly);
            ctx.stroke();

            // Label
            ctx.fillStyle = lv.c;
            ctx.font = '10px -apple-system, sans-serif';
            ctx.fillText(`${lv.lbl} ($${lPrice.toFixed(2)})`, leftX + 4, ly - 3);
          }
        });

      } else if (d.type === 'long_pos' || d.type === 'short_pos') {
        if (!s1) { ctx.restore(); return; }
        const isLong = d.type === 'long_pos';
        const entryPx = d.entryPrice || p1.price;
        const tpPx = d.takeProfit || (isLong ? entryPx * 1.02 : entryPx * 0.98);
        const slPx = d.stopLoss || (isLong ? entryPx * 0.99 : entryPx * 1.01);

        const entryY = this.candleSeries.priceToCoordinate(entryPx);
        const tpY = this.candleSeries.priceToCoordinate(tpPx);
        const slY = this.candleSeries.priceToCoordinate(slPx);

        if (entryY !== null && tpY !== null && slY !== null) {
          const boxLeft = Math.max(10, s1.x - 20);
          const boxWidth = 140;

          // Target box (Green)
          const targetTop = Math.min(entryY, tpY);
          const targetH = Math.abs(tpY - entryY);
          ctx.fillStyle = 'rgba(16, 185, 129, 0.18)';
          ctx.fillRect(boxLeft, targetTop, boxWidth, targetH);
          ctx.strokeStyle = '#10b981';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(boxLeft, targetTop, boxWidth, targetH);

          // Stop box (Red)
          const stopTop = Math.min(entryY, slY);
          const stopH = Math.abs(slY - entryY);
          ctx.fillStyle = 'rgba(239, 68, 68, 0.18)';
          ctx.fillRect(boxLeft, stopTop, boxWidth, stopH);
          ctx.strokeStyle = '#ef4444';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(boxLeft, stopTop, boxWidth, stopH);

          // Center Info Banner
          const rewardPct = Math.abs((tpPx - entryPx) / entryPx * 100);
          const riskPct = Math.abs((entryPx - slPx) / entryPx * 100);
          const rr = (riskPct > 0 ? (rewardPct / riskPct).toFixed(2) : '2.00');

          ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
          ctx.fillRect(boxLeft + 4, entryY - 14, boxWidth - 8, 28);
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 1;
          ctx.strokeRect(boxLeft + 4, entryY - 14, boxWidth - 8, 28);

          ctx.fillStyle = '#fff';
          ctx.font = 'bold 9.5px sans-serif';
          ctx.fillText(`Target: +${rewardPct.toFixed(2)}% | Stop: -${riskPct.toFixed(2)}%`, boxLeft + 8, entryY - 2);
          ctx.fillStyle = '#38bdf8';
          ctx.fillText(`Risk/Reward: 1:${rr}`, boxLeft + 8, entryY + 10);
        }
      }

      ctx.restore();
    }

    drawHandle(x, y, isSelected) {
      if (!isSelected) return;
      const ctx = this.ctx;
      ctx.save();
      ctx.fillStyle = '#38bdf8';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    drawPriceBadge(x, y, text, color) {
      const ctx = this.ctx;
      ctx.save();
      ctx.fillStyle = color;
      ctx.fillRect(x, y - 9, 70, 18);
      ctx.fillStyle = '#111827';
      ctx.font = 'bold 9.5px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(text, x + 35, y + 4);
      ctx.restore();
    }
  }

  window.DrawingEngine = DrawingEngine;
  window.drawingEngineInstance = new DrawingEngine();

})(window);
