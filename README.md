# HYPERVIEW — Institutional-Grade Quantitative Crypto Trading Terminal

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Web3 SIWE](https://img.shields.io/badge/Web3-EIP--4361%20SIWE-emerald)](https://eips.ethereum.org/EIPS/eip-4361)
[![Hyperliquid API](https://img.shields.io/badge/Exchange-Hyperliquid%20L1-purple)](https://hyperliquid.xyz)
[![Node.js](https://img.shields.io/badge/Node.js-v18%2B-green.svg)](https://nodejs.org/)

**Hyperview** là nền tảng phân tích định lượng và giao dịch phái sinh tiền mã hóa thời gian thực (Real-time Quantitative Terminal), tích hợp sâu với sàn phi tập trung **Hyperliquid L1**. Nền tảng kết hợp các chu kỳ giá vô địch của **Oliver Kell**, 26 mô hình đồng thuận kỹ thuật (Technical Consensus Models), kiến trúc bảo mật **Zero-Trust Web3 (SIWE EIP-4361)** và môi trường **Strategy Studio Sandbox** cho phép người dùng tự viết mã thuật toán cá nhân.

---

## 📑 Mục Lục
1. [Tính Năng Nổi Bật](#-tính-năng-nổi-bật)
2. [Kiến Trúc An Ninh & Cam Kết Non-Custodial](#-kiến-trúc-an-ninh--cam-kết-non-custodial)
3. [Hướng Dẫn Thiết Lập Hyperliquid API Agent Wallet (Auto-Trading Bot)](#-hướng-dẫn-thiết-lập-hyperliquid-api-agent-wallet-auto-trading-bot)
4. [Tự Viết Chiến Lược Trong Strategy Studio](#-tự-viết-chiến-lược-trong-strategy-studio)
5. [Cài Đặt & Chạy Cục Bộ (Local Deployment)](#-cài-đặt--chạy-cục-bộ-local-deployment)
6. [Bản Quyền & Miễn Trừ Trách Nhiệm](#-bản-quyền--miễn-trừ-trách-nhiệm)

---

## 🌟 Tính Năng Nổi Bật

- **Realtime Charting & Multi-Layout:** Khung đồ thị độ trễ thấp (<18ms), hỗ trợ chia màn hình đa khung thời gian (1 Chart, 2 Split Vertical, 2 Split Horizontal).
- **Kho Chỉ Báo Định Chế (Indicators Repository):**
  - *FiboRadar [Mr_Rakun]:* Tự động xác định các vùng Fibonacci thoái lui và mở rộng động.
  - *Galton Volume Profile & Footprint:* Mô hình phân bổ khối lượng nhị thức và Imbalance delta flow.
  - *LuxAlgo Signals & Overlays (v6.1 Clone):* Smart Trail ATR và Reversal Zones thích ứng.
  - *EMA30 Band Breakout [EL COBER]:* Phát hiện đột phá dải động lượng kèm bộ lọc Spike Volume $\ge 1.15x$.
- **Zero-Trust Multi-Tenant Architecture:**
  - Watchlist và Live Journal lưu trữ độc lập theo từng tài khoản (`data/user_watchlists/`, `data/user_portfolios/`).
  - Cấp tài khoản Paper Trading $10,000 USD ban đầu cho mỗi người dùng tự giao dịch hoặc chạy bot cá nhân.
  - Tài khoản Live tự động tính toán tổng Equity thời gian thực từ ví kết nối (Hyperliquid Perp + Spot USDC + Arbitrum Native USDC).
- **Quản Trị Rủi Ro Tương Quan Vốn (Equity-Correlated Risk Engine):**
  - Khóa dừng lỗ ngày (Daily Stop Loss Circuit Breaker) cứng ở mức **2.0% Equity** (Ví dụ: -$200 trên vốn $10,000; -$20 trên vốn $1,000).
  - Khóa chốt lời bảo toàn lợi nhuận ngày ở mức **3.0% Equity**.
  - Giới hạn ký quỹ tối đa mỗi vị thế ở mức **25.0% Equity**.

---

## 🔒 Kiến Trúc An Ninh & Cam Kết Non-Custodial

### 1. Không Bao Giờ Chạm Vào Private Key
Hệ thống **hoàn toàn không lưu trữ** khóa bí mật (Private Key) hay cụm từ khôi phục (Seed Phrase) của ví chính. Toàn bộ tài sản luôn nằm dưới sự kiểm soát 100% của người dùng trong ví cá nhân (MetaMask, Rabby, Phantom).

### 2. Xác Thực Thuần Văn Bản (EIP-4361 SIWE)
Khi kết nối ví, nền tảng chỉ yêu cầu ký thông điệp đọc hiểu được (`personal_sign`):
- **Không tốn phí Gas.**
- **Không phải là giao dịch chuyển tiền trên Blockchain (`eth_sendTransaction`).**
- **Zero Token Approvals:** Nền tảng tuyệt đối không yêu cầu cấp quyền `approve()` hay `setApprovalForAll()` cho bất kỳ Smart Contract lạ nào.

### 3. Safe VM Sandbox Cho Code Người Dùng
Khi người dùng dán mã nguồn JavaScript chiến lược vào Strategy Studio:
- Mã được thẩm định cú pháp (AST Syntax Verification) trước khi lưu.
- Thực thi hoàn toàn trong môi trường cô lập `vm.createContext()` của Node.js với thời gian timeout tối đa 250ms.
- Triệt tiêu hoàn toàn quyền truy cập vào các module nhạy cảm (`process`, `require`, `fs`, `child_process`).

---

## 🔑 Hướng Dẫn Thiết Lập Hyperliquid API Agent Wallet (Auto-Trading Bot)

Để bot tự động mở/đóng lệnh trên Hyperliquid mà **KHÔNG CẦN** đưa Private Key của ví chính, Hyperliquid cung cấp giải pháp bảo mật tiêu chuẩn định chế: **API Agent Wallet (Delegated Signer)**.

### 💡 Tại sao cơ chế Agent Wallet lại an toàn tuyệt đối?
1. **Chỉ Có Quyền Giao Dịch (Trade-Only):** Agent Wallet được ví chính ủy quyền trực tiếp trên Hyperliquid L1 để ký mở lệnh (Market/Limit), chốt lời/cắt lỗ (TP/SL) và đóng vị thế.
2. **CẤM RÚT TIỀN (Withdrawal Forbidden):** Agent Wallet **hoàn toàn không có quyền rút tiền** hoặc chuyển tài sản sang ví khác. Kể cả trong trường hợp xấu nhất máy chủ bot bị lộ key Agent, hacker **cũng không thể rút được 1 xu** từ tài khoản của bạn.
3. **Thu hồi quyền tức thì (Revoke):** Bạn có thể hủy quyền của Agent bất kỳ lúc nào chỉ bằng 1 cú click chuột trên sàn Hyperliquid.

---

### 🚀 Hướng Dẫn Từng Bước (Chỉ Mất 1 Phút)

#### Bước 1: Truy Cập Sàn Hyperliquid
- Mở trình duyệt và truy cập trang chủ chính thức: **[https://app.hyperliquid.xyz/trade](https://app.hyperliquid.xyz/trade)**.
- Kết nối ví chính của bạn (MetaMask, Rabby hoặc Phantom).

#### Bước 2: Mở Cài Đặt API
- Bấm vào biểu tượng **Bánh răng Cài đặt (⚙️ Settings)** ở góc trên cùng bên phải giao diện.
- Trong menu cài đặt, chuyển sang tab **API**.

#### Bước 3: Tạo Khóa API Agent Mới
- Tại mục **API Wallets / Agent Keys**, nhập tên gợi nhớ cho bot (ví dụ: `Hyperview_Bot_Alpha` hoặc `AutoTrader`).
- Bấm nút **Create API Key** (hoặc **Approve Agent**).

#### Bước 4: Ký Xác Nhận Trên Ví Web3
- Cửa sổ ví MetaMask/Rabby sẽ hiện thông báo yêu cầu bạn ký giao dịch ủy quyền Agent cho Hyperliquid L1.
- Kiểm tra nội dung thông điệp (chỉ là ủy quyền Agent Trading) và bấm **Confirm / Sign**.

#### Bước 5: Lưu Lại Khóa Bí Mật Của Agent (API Secret)
Sau khi ký thành công, giao diện Hyperliquid sẽ hiển thị hộp thoại chứa thông tin khóa:
1. **API Wallet Address:** Địa chỉ công khai của Agent.
2. **API Secret (Private Key của Agent):** Chuỗi ký tự khóa bí mật bắt đầu bằng `0x...`.

> ⚠️ **LƯU Ý:** Sao chép và lưu trữ `API Secret` vào nơi an toàn. Khóa này chỉ xuất hiện 1 lần duy nhất sau khi tạo.

#### Bước 6: Cấu Hình Vào Bot / File Môi Trường
Điền khóa Agent vừa lấy vào file cấu hình bot hoặc biến môi trường:
```bash
# Cấu hình bot tự động ký lệnh trên Hyperliquid
HL_USER_ADDRESS="0x<ĐỊA_CHỈ_VÍ_CHÍNH_CỦA_BẠN>"
HL_AGENT_PRIVATE_KEY="0x<API_SECRET_CỦA_AGENT_WALLET>"
```

#### Bước 7: Cách Hủy Ủy Quyền Khẩn Cấp (Revoke Key)
Bất cứ khi nào bạn muốn dừng bot hoặc nghi ngờ lộ khóa Agent:
1. Vào lại **Settings (⚙️) -> API** trên Hyperliquid.
2. Tìm đến tên Agent đã tạo và bấm nút **Revoke / Delete (Thùng rác)**.
3. Xác nhận trên ví. Ngay lập tức, Agent Key cũ sẽ bị vô hiệu hóa vĩnh viễn trên blockchain Hyperliquid.

---

## 🧠 Tự Viết Chiến Lược Trong Strategy Studio

Trong menu **Indicators (`fx`)**, cuộn xuống dưới cùng và click vào nút **`➕ Add Strategy (Code Engine)`** để mở bảng điều khiển.

### Quy Chuẩn Hàm `onTick(market, portfolio)`
Mỗi chiến lược tùy biến chỉ cần cài đặt hàm chuẩn sau:

```javascript
/**
 * @param {Object} market - Dữ liệu thị trường thời gian thực
 *   { symbol, price, high, low, volume, rsi, ema10, ema20, ema50, supertrend, macd }
 * @param {Object} portfolio - Dữ liệu tài khoản của chính bạn
 *   { balance, cash, equity, openPositions }
 * @returns {Object|null} - Lệnh cần thực thi hoặc null nếu giữ nguyên
 */
function onTick(market, portfolio) {
  const { symbol, price, rsi, ema10, ema20 } = market;
  const hasPos = (portfolio.openPositions || []).some(p => p.symbol === symbol);

  // Ví dụ: Bắt đáy RSI < 30 khi EMA10 cắt lên EMA20
  if (!hasPos && rsi < 30 && ema10 >= ema20) {
    return {
      action: 'BUY',
      symbol: symbol,
      sizePct: 20, // Tự động quy đổi ra 20% vốn theo Equity thực tế
      tp: Math.round(price * 1.03 * 100) / 100, // Chốt lời +3%
      sl: Math.round(price * 0.985 * 100) / 100, // Cắt lỗ -1.5%
      reason: 'RSI Oversold Crossover'
    };
  }

  // Chốt lời vị thế khi RSI vượt quá mua (> 70)
  if (hasPos && rsi > 70) {
    return { action: 'CLOSE', symbol: symbol, reason: 'RSI Overbought TP' };
  }

  return null;
}
```

---

## 💻 Cài Đặt & Chạy Cục Bộ (Local Deployment)

### Yêu Cầu Hệ Thống
- Node.js phiên bản **18.x** trở lên.
- Trình quản lý gói: `npm` hoặc `pnpm`.

### Khởi Chạy
```bash
# 1. Clone mã nguồn
git clone https://github.com/Doffyyyy/TradingView-API.git
cd TradingView-API

# 2. Cài đặt thư viện phụ thuộc
npm install

# 3. Khởi chạy máy chủ giao dịch
node server.js
```
Mở trình duyệt và truy cập: **`http://localhost:8095`** (hoặc `http://localhost:8095/terminal` để vào trực tiếp bàn làm việc Trading Terminal).

---

## 📜 Bản Quyền & Miễn Trừ Trách Nhiệm

- **Phần mềm mã nguồn mở:** Phát hành theo giấy phép [MIT License](LICENSE).
- **Miễn trừ rủi ro:** Giao dịch tài sản tiền mã hóa và phái sinh tiềm ẩn mức độ rủi ro cao đối với nguồn vốn của bạn. Hãy đảm bảo bạn hiểu rõ các nguyên tắc quản trị vốn và chỉ giao dịch với số tiền bạn có khả năng chấp nhận rủi ro.

---
*Built with passion by Hyperview Labs. Powered by Hyperliquid L1 & EIP-4361 SIWE.*
