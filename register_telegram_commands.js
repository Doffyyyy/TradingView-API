const fs = require('fs');
const axios = require('axios');

const envPath = 'C:/Users/ADMIN/AppData/Local/hermes/.env';
const content = fs.readFileSync(envPath, 'utf8');
const mToken = content.match(/TELEGRAM_BOT_TOKEN=([^\r\n]+)/);
const token = mToken[1].trim();

async function setCommands() {
  const getRes = await axios.get(`https://api.telegram.org/bot${token}/getMyCommands`);
  let existingCommands = getRes.data.result || [];

  // Filter out existing 'report' if any
  existingCommands = existingCommands.filter(c => c.command !== 'report');

  // Prepend 'report' as the first command in the menu
  const updatedCommands = [
    {
      command: 'report',
      description: '📊 Gửi ngay Báo Cáo Trading PnL & File Excel Hyperview'
    },
    ...existingCommands
  ];

  const setRes = await axios.post(`https://api.telegram.org/bot${token}/setMyCommands`, {
    commands: updatedCommands
  });

  console.log('setMyCommands response:', setRes.data);

  // Verify
  const verifyRes = await axios.get(`https://api.telegram.org/bot${token}/getMyCommands`);
  console.log('Verified first 5 commands:');
  console.log(verifyRes.data.result.slice(0, 5));
}

setCommands().catch(err => {
  console.error('Error setting commands:', err.response ? err.response.data : err.message);
});
