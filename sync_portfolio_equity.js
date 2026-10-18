const fs = require('fs');
const path = require('path');

const portPath = path.join(__dirname, 'data', 'paper_portfolio.json');
const port = JSON.parse(fs.readFileSync(portPath, 'utf8'));

// Target total closed equity before open position = $11,773.13
const targetClosedEquity = 11773.13;
let openMargin = 0;
if (port.positions && port.positions.length > 0) {
  port.positions.forEach(p => {
    openMargin += (p.margin !== undefined ? p.margin : p.notional);
  });
}

port.cash = Math.round((targetClosedEquity - openMargin) * 100) / 100;
port.equity = targetClosedEquity;

fs.writeFileSync(portPath, JSON.stringify(port, null, 2));

console.log('Synchronized paper_portfolio.json to continuous journal equity:');
console.log('Target Closed Equity: $' + targetClosedEquity);
console.log('Open Margin in Positions: $' + openMargin);
console.log('Available Cash: $' + port.cash);
console.log('Equity: $' + port.equity);
