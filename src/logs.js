// In-memory copy of the server log, shown in the panel. console.log, console.warn and console.error
// print exactly as before (Railway's log is unchanged); each line is also kept, with a UTC timestamp,
// in a buffer of the last MAX_LINES lines. The buffer is lost on restart or redeploy.
'use strict';

const util = require('util');

const MAX_LINES = 500;
const lines = [];
let started = false;

function record(level, args) {
  const stamp = new Date().toISOString();
  for (const part of util.format(...args).split('\n')) lines.push(`${stamp} ${level} ${part}`);
  while (lines.length > MAX_LINES) lines.shift();
}

// Wraps the console methods once. Call it before the other modules so startup lines are kept too.
function capture() {
  if (started) return;
  started = true;
  for (const [method, level] of [['log', 'info'], ['warn', 'warn'], ['error', 'error']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      try {
        record(level, args);
      } catch {
        // Keeping a log line must never break the real logging below.
      }
      original(...args);
    };
  }
}

// A copy of the kept lines, oldest first.
const getLines = () => lines.slice();

module.exports = { capture, getLines };
