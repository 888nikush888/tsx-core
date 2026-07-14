import assert from 'assert';
import { drawMainMenuBuffered } from '../src/ui.js';

function captureMenu(config, state) {
  let output = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  try {
    drawMainMenuBuffered(config, state, 0, state.resolvedSourceChatIds, state.totalForwardedCount);
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}

function baseConfig() {
  return {
    apiId: 0,
    sourceChannels: [],
    targetChannel: '',
    sourceAliases: {},
    sourceFilters: {},
    filters: { blockedKeywords: [], regexPatterns: [], allowedTypes: [] },
    forwardOptions: {
      sendCopy: false,
      removeCaption: false,
      maxConcurrency: 2,
      forwardToTarget: true
    },
    xmlParsing: {
      enabled: false,
      primaryModel: 'primary/model',
      fallbackModel: 'fallback/model'
    },
    dupeBlocker: { enabled: false, cooldownHours: 24 }
  };
}

const previousApiId = process.env.TELEGRAM_API_ID;
const previousApiHash = process.env.TELEGRAM_API_HASH;
try {
  delete process.env.TELEGRAM_API_ID;
  delete process.env.TELEGRAM_API_HASH;
  const stopped = captureMenu(baseConfig(), {
    isRunning: false,
    resolvedSourceChatIds: new Set(),
    totalForwardedCount: 0
  });
  assert.match(stopped, /STANDBY \/ INTERCEPT-OFF/);
  assert.match(stopped, /UNRESOLVED/);
  assert.match(stopped, /Keine Quell-Knoten konfiguriert/);
  assert.match(stopped, /XML-Signal-KI/);

  process.env.TELEGRAM_API_ID = '12345';
  process.env.TELEGRAM_API_HASH = 'a'.repeat(32);
  const activeConfig = baseConfig();
  activeConfig.sourceChannels = ['@source'];
  activeConfig.targetChannel = '@target';
  activeConfig.forwardOptions.sendCopy = true;
  activeConfig.forwardOptions.removeCaption = true;
  activeConfig.xmlParsing.enabled = true;
  activeConfig.dupeBlocker.enabled = true;
  const running = captureMenu(activeConfig, {
    isRunning: true,
    resolvedSourceChatIds: new Set(['-1001']),
    totalForwardedCount: 7
  });
  assert.match(running, /RUNNING \/ INTERCEPT-ACTIVE/);
  assert.match(running, /RESOLVED \(Knoten-ID: 12345\)/);
  assert.match(running, /KOPY-MODUS/);
  assert.match(running, /7 Pakete/);
  console.log('UI rendering contract tests passed.');
} finally {
  if (previousApiId === undefined) delete process.env.TELEGRAM_API_ID;
  else process.env.TELEGRAM_API_ID = previousApiId;
  if (previousApiHash === undefined) delete process.env.TELEGRAM_API_HASH;
  else process.env.TELEGRAM_API_HASH = previousApiHash;
}
