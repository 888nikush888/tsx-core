import readline from 'readline';

// ANSI Escape Codes - Hybrid Theme (Vercel Cleanness + Modern Emojis/Colors)
const ESC = '\x1b[';
const C_RESET = `${ESC}0m`;
const C_BOLD = `${ESC}1m`;
const C_DIM = `${ESC}2m`;
const C_GREEN = `${ESC}32m`;
const C_CYAN = `${ESC}36m`;
const C_RED = `${ESC}31m`;
const C_YELLOW = `${ESC}33m`;

const clearScreen = () => process.stdout.write('\x1B[2J\x1B[H');

// Mock Configuration State
let mockConfig = {
  xmlParsing: { enabled: true, forwardXml: false, saveLocal: true, command: 'python' },
  filters: { regex: ['/urgent/i', '/signal/i'], keywords: ['LONG', 'SHORT', 'BUY'] }
};

// UI Navigation State
let viewStack = ['main']; 
let selectedIndex = 0;
let currentOptions = [];

// Live-Daten
let logs = [];
let packets = 0;
let errors = 0;
let trafficHistory = new Array(50).fill(0);
let currentTrafficCount = 0;
let eventInterval = null;
let graphInterval = null;

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

// ---------------------------------------------------------
// MENÜ DATENSTRUKTUREN (Hybrid Style)
// ---------------------------------------------------------
function getMainMenuOptions() {
  return [
    { id: 'api', label: 'API Credentials', status: '🔑 Configured' },
    { id: 'sources', label: 'Source Channels', status: '📡 2 Active' },
    { id: 'target', label: 'Target Channel', status: '🎯 -1003943765261' },
    { id: 'forward', label: 'Forwarding Options', status: '⚙️  Copy, No Captions' },
    { id: 'filters', label: 'Filters & Regex', status: `🛡️  ${mockConfig.filters.regex.length} Regex, ${mockConfig.filters.keywords.length} Words` },
    { id: 'xml', label: 'XML Signal Parser', status: mockConfig.xmlParsing.enabled ? '🤖 🟢 Enabled' : '🤖 🔴 Disabled' },
    { id: 'sep', label: '', status: '' },
    { id: 'start', label: '▶ Start Live Routing', status: '' },
    { id: 'exit', label: '■ Exit', status: '' }
  ];
}

function getXmlMenuOptions() {
  return [
    { id: 'toggle_enabled', label: 'Parser Engine', status: mockConfig.xmlParsing.enabled ? '🟢 Active' : '🔴 Inactive' },
    { id: 'toggle_forward', label: 'Forward XML to Target', status: mockConfig.xmlParsing.forwardXml ? '🟢 Yes' : '🔴 No' },
    { id: 'toggle_save', label: 'Save XML locally', status: mockConfig.xmlParsing.saveLocal ? '🟢 Yes' : '🔴 No' },
    { id: 'cmd', label: 'Python Command', status: `⌨️  ${mockConfig.xmlParsing.command}` },
    { id: 'sep', label: '', status: '' },
    { id: 'back', label: '← Back', status: '' }
  ];
}

function getFiltersMenuOptions() {
  return [
    { id: 'keywords', label: 'Manage Keywords', status: `📝 ${mockConfig.filters.keywords.join(', ')}` },
    { id: 'regex', label: 'Manage Regex Patterns', status: `🔍 ${mockConfig.filters.regex.length} active` },
    { id: 'sep', label: '', status: '' },
    { id: 'back', label: '← Back', status: '' }
  ];
}

function getCurrentOptions() {
  const view = viewStack[viewStack.length - 1];
  if (view === 'main') return getMainMenuOptions();
  if (view === 'xml') return getXmlMenuOptions();
  if (view === 'filters') return getFiltersMenuOptions();
  return [];
}

// ---------------------------------------------------------
// MENÜ ZEICHNEN
// ---------------------------------------------------------
function drawGenericMenu(title, options, selectedIdx) {
  let out = '\x1B[?25l'; 
  out += '\x1B[H'; 
  clearScreen();

  out += `\n  ${C_BOLD}🚀 NEXUS DATALINK${C_RESET} ${C_DIM}v2.0.0${C_RESET}\n\n`;
  out += `  ${C_BOLD}? ${title}${C_RESET}\n\n`;

  options.forEach((opt, index) => {
    if (opt.id === 'sep') {
      out += `\n`;
      return;
    }

    const isSelected = index === selectedIdx;
    const prefix = isSelected ? `${C_CYAN}❯${C_RESET}` : ' ';
    const labelColor = isSelected ? C_CYAN : '';
    const labelBold = isSelected ? C_BOLD : '';
    
    const paddedLabel = opt.label.padEnd(25, ' ');
    const statusText = opt.status ? `${C_DIM}${opt.status}${C_RESET}` : '';

    out += `  ${prefix} ${labelColor}${labelBold}${paddedLabel}${C_RESET}  ${statusText}\n`;
  });

  out += `\n`;
  process.stdout.write(out);
}

function drawCurrentMenu() {
  currentOptions = getCurrentOptions();
  const view = viewStack[viewStack.length - 1];
  let title = 'What would you like to configure?';
  if (view === 'xml') title = 'XML Signal Parser Settings';
  if (view === 'filters') title = 'Filter & Security Settings';
  
  drawGenericMenu(title, currentOptions, selectedIndex);
}

// ---------------------------------------------------------
// LIVE DASHBOARD ZEICHNEN
// ---------------------------------------------------------
function drawSparkline(data) {
  const chars = [' ', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const max = Math.max(...data, 4); 
  return data.map(v => {
    const idx = Math.floor((v / max) * 7);
    return `${C_CYAN}${chars[idx]}${C_RESET}`; // Cyan für etwas mehr Pop im Graphen
  }).join('');
}

function drawDashboard() {
  let out = '\x1B[?25l'; 
  out += '\x1B[H'; 
  clearScreen();

  out += `\n  ${C_BOLD}🚀 NEXUS DATALINK${C_RESET} ${C_DIM}v2.0.0${C_RESET}\n`;
  out += `  ${C_DIM}- Status:${C_RESET} 🟢 ${C_GREEN}Active & Syncing${C_RESET}\n\n`;

  // Stats Grid mit Emojis und Farben
  out += `  ${C_DIM}TRAFFIC${C_RESET}                 ${C_DIM}PERFORMANCE${C_RESET}\n`;
  out += `  ${C_GREEN}▲ ${String(packets).padEnd(6, ' ')}${C_RESET} ${C_DIM}Routed${C_RESET}          ⚡ ${C_BOLD}12ms${C_RESET} ${C_DIM}Avg Latency${C_RESET}\n`;
  out += `  ${C_RED}▼ ${String(errors).padEnd(6, ' ')}${C_RESET} ${C_DIM}Errors${C_RESET}          ⚙️  ${C_BOLD}0/2${C_RESET}  ${C_DIM}Queue Load${C_RESET}\n\n`;

  out += `  ${C_BOLD}Throughput${C_RESET}\n`;
  out += `  ${drawSparkline(trafficHistory)}\n\n`;

  out += `  ${C_BOLD}Event Log${C_RESET}\n`;
  const displayLogs = logs.slice(-7);
  for (let i = 0; i < 7; i++) {
    if (i < displayLogs.length) {
      out += `  ${displayLogs[i]}\n`;
    } else {
      out += `\n`;
    }
  }

  out += `\n  ${C_DIM}Press Ctrl+C to return${C_RESET}\n`;
  process.stdout.write(out);
}

function addLog(msg, icon) {
  const time = new Date().toISOString().split('T')[1].slice(0, 8);
  logs.push(`${C_DIM}${time} │${C_RESET} ${icon}  ${msg}`);
  if (logs.length > 15) logs.shift();
}

function startLiveView() {
  clearScreen();
  addLog('Boot sequence completed', '✅');
  addLog('Connected to TDLib Mainframe', '🔗');
  addLog('Listening for incoming packets...', '📡');

  graphInterval = setInterval(() => {
    trafficHistory.shift();
    trafficHistory.push(currentTrafficCount);
    currentTrafficCount = 0;
  }, 500);

  eventInterval = setInterval(() => {
    const rand = Math.random();
    if (rand > 0.7) {
      packets++;
      currentTrafficCount++;
      const id = Math.floor(Math.random() * 90000) + 10000;
      if (Math.random() > 0.5) {
        addLog(`Safely routed packet #${id} to target`, '🚀');
      } else {
        addLog(`Parsed XML payload from #${id}`, '🤖');
      }
    } else if (rand > 0.98) {
      errors++;
      addLog(`${C_RED}FloodWait triggered. 2s backoff applied.${C_RESET}`, '⚠️ ');
    }
    drawDashboard();
  }, 100);
}

function stopLiveView() {
  clearInterval(graphInterval);
  clearInterval(eventInterval);
}

// ---------------------------------------------------------
// INPUT HANDLING
// ---------------------------------------------------------
process.stdin.on('keypress', (str, key) => {
  if (key.ctrl && key.name === 'c') {
    if (viewStack[viewStack.length - 1] === 'live') {
      stopLiveView();
      viewStack.pop();
      selectedIndex = 0;
      drawCurrentMenu();
      return;
    } else {
      process.stdout.write('\x1B[?25h'); 
      clearScreen();
      process.exit(0);
    }
  }

  const currentView = viewStack[viewStack.length - 1];

  if (currentView === 'mock_input') {
    viewStack.pop();
    drawCurrentMenu();
    return;
  }

  if (currentView !== 'live') {
    if (key.name === 'up') {
      selectedIndex--;
      if (selectedIndex < 0) selectedIndex = currentOptions.length - 1;
      if (currentOptions[selectedIndex].id === 'sep') selectedIndex--; 
      drawCurrentMenu();
    } else if (key.name === 'down') {
      selectedIndex++;
      if (selectedIndex >= currentOptions.length) selectedIndex = 0;
      if (currentOptions[selectedIndex].id === 'sep') selectedIndex++; 
      drawCurrentMenu();
    } else if (key.name === 'return') {
      const opt = currentOptions[selectedIndex];
      
      if (opt.id === 'back') {
        viewStack.pop();
        selectedIndex = 0;
        drawCurrentMenu();
      } else if (opt.id === 'exit') {
        process.stdout.write('\x1B[?25h');
        clearScreen();
        process.exit(0);
      } else if (opt.id === 'start') {
        viewStack.push('live');
        startLiveView();
      } else if (opt.id === 'xml' || opt.id === 'filters') {
        viewStack.push(opt.id);
        selectedIndex = 0;
        drawCurrentMenu();
      } else if (opt.id === 'toggle_enabled') {
        mockConfig.xmlParsing.enabled = !mockConfig.xmlParsing.enabled;
        drawCurrentMenu();
      } else if (opt.id === 'toggle_forward') {
        mockConfig.xmlParsing.forwardXml = !mockConfig.xmlParsing.forwardXml;
        drawCurrentMenu();
      } else if (opt.id === 'toggle_save') {
        mockConfig.xmlParsing.saveLocal = !mockConfig.xmlParsing.saveLocal;
        drawCurrentMenu();
      } else {
        viewStack.push('mock_input');
        clearScreen();
        console.log(`\n  ${C_BOLD}? Text Input Mock${C_RESET}`);
        console.log(`  ${C_DIM}Entering text is skipped in this UI demo.${C_RESET}`);
        console.log(`\n  ${C_DIM}Press any key to return...${C_RESET}`);
      }
    }
  }
});

drawCurrentMenu();
