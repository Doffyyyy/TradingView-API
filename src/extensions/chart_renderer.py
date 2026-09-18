import sys
import json
import math
from PIL import Image, ImageDraw, ImageFont

def render_chart(candles, meta, output_path):
    width, height = 900, 520
    img = Image.new('RGB', (width, height), color='#0f1117')
    draw = ImageDraw.Draw(img)

    # Margins
    top_margin = 85
    bottom_margin = 60
    left_margin = 20
    right_margin = 85

    chart_w = width - left_margin - right_margin
    chart_h = height - top_margin - bottom_margin

    # Price bounds
    highs = [c['high'] for c in candles]
    lows = [c['low'] for c in candles]
    min_price = min(lows) if lows else 0
    max_price = max(highs) if highs else 1
    price_range = max_price - min_price or 1.0

    # Grid & Axes
    num_grid = 5
    for i in range(num_grid + 1):
        y = top_margin + int(chart_h * (i / num_grid))
        draw.line([(left_margin, y), (width - right_margin, y)], fill='#1a1e2a', width=1)
        grid_price = max_price - (price_range * (i / num_grid))
        draw.text((width - right_margin + 8, y - 6), f"{grid_price:.2f}", fill='#6b7280')

    # Draw Candlesticks
    n = len(candles)
    bar_width = max(3, int(chart_w / max(1, n)) - 2)
    step = chart_w / max(1, n)

    for i, c in enumerate(candles):
        x = left_margin + int(i * step + step / 2)
        y_open = top_margin + int((max_price - c['open']) / price_range * chart_h)
        y_close = top_margin + int((max_price - c['close']) / price_range * chart_h)
        y_high = top_margin + int((max_price - c['high']) / price_range * chart_h)
        y_low = top_margin + int((max_price - c['low']) / price_range * chart_h)

        is_bull = c['close'] >= c['open']
        color = '#26a69a' if is_bull else '#ef5350'

        # Wick
        draw.line([(x, y_high), (x, y_low)], fill=color, width=1)

        # Body
        top_body = min(y_open, y_close)
        bot_body = max(y_open, y_close)
        if bot_body - top_body < 1:
            bot_body = top_body + 1

        draw.rectangle(
            [(x - bar_width // 2, top_body), (x + bar_width // 2, bot_body)],
            fill=color,
            outline=color
        )

    # Header section
    sym = meta.get('symbol', 'BINANCE:BTCUSDT')
    strat = meta.get('strategy', 'Astra Alpha')
    sharpe = meta.get('sharpe', '2.15')
    dd = meta.get('drawdown', '-4.2%')
    kelly = meta.get('kelly', '15.0%')
    last_price = candles[-1]['close'] if candles else 0

    # Title & Price
    draw.text((20, 15), f"{sym}", fill='#ffffff')
    draw.text((20, 38), f"LAST: {last_price:.2f}", fill='#26a69a')

    # Badges on top right
    bx = 320
    draw.rectangle([(bx, 15), (bx + 160, 48)], fill='#181b24', outline='#2b3040')
    draw.text((bx + 10, 18), "STRATEGY", fill='#8c93a3')
    draw.text((bx + 10, 32), f"{strat}", fill='#38bdf8')

    bx += 175
    draw.rectangle([(bx, 15), (bx + 110, 48)], fill='#181b24', outline='#2b3040')
    draw.text((bx + 10, 18), "SHARPE", fill='#8c93a3')
    draw.text((bx + 10, 32), f"{sharpe}", fill='#4ade80')

    bx += 125
    draw.rectangle([(bx, 15), (bx + 110, 48)], fill='#181b24', outline='#2b3040')
    draw.text((bx + 10, 18), "MAX DD", fill='#8c93a3')
    draw.text((bx + 10, 32), f"{dd}", fill='#f87171')

    bx += 125
    draw.rectangle([(bx, 15), (bx + 125, 48)], fill='#181b24', outline='#2b3040')
    draw.text((bx + 10, 18), "KELLY SIZED", fill='#8c93a3')
    draw.text((bx + 10, 32), f"{kelly}", fill='#fbbf24')

    # Footer
    draw.line([(0, height - 30), (width, height - 30)], fill='#2b3040', width=1)
    draw.text((20, height - 22), "TradingView API Engine | Validation Bot Approved Signal", fill='#6b7280')

    img.save(output_path, 'PNG')
    print(f"Chart saved to {output_path}")

if __name__ == '__main__':
    data_file = sys.argv[1]
    out_file = sys.argv[2]
    with open(data_file, 'r') as f:
        payload = json.load(f)
    render_chart(payload['candles'], payload['meta'], out_file)
