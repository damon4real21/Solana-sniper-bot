const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const logger = {
  info: (msg, ...args) =>
    console.log(`${colors.cyan}[${ts()}] INFO${colors.reset}  ${msg}`, ...args),
  success: (msg, ...args) =>
    console.log(`${colors.green}[${ts()}] ✅${colors.reset}   ${msg}`, ...args),
  warn: (msg, ...args) =>
    console.log(`${colors.yellow}[${ts()}] WARN${colors.reset}  ${msg}`, ...args),
  error: (msg, ...args) =>
    console.log(`${colors.red}[${ts()}] ERROR${colors.reset} ${msg}`, ...args),
  trade: (msg, ...args) =>
    console.log(`${colors.green}[${ts()}] 💰${colors.reset}   ${msg}`, ...args),
  rug: (msg, ...args) =>
    console.log(`${colors.red}[${ts()}] 🚨${colors.reset}   ${msg}`, ...args),
};

module.exports = logger;
