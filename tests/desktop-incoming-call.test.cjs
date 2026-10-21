const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.cjs'), 'utf8');

test('an incoming desktop call brings a hidden-to-tray window back to the foreground', () => {
  const start = main.indexOf("ipcMain.on('onlyus:incoming-call', event => {");
  const end = main.indexOf("\n    ipcMain.on('onlyus:call-ended'", start);
  assert.ok(start >= 0 && end > start, 'incoming call handler must exist');
  const handler = main.slice(start, end);
  assert.match(handler, /if \(win && !win\.isDestroyed\(\)\)\s*\{[\s\S]*?showWindow\(\);/);
  assert.match(handler, /win\.flashFrame\(false\)/);
  assert.match(handler, /incomingNotification\.on\('click', showWindow\)/);
});
