import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import assert from 'assert';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, '../config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

function parseSignalWithPython(text, customEnv = {}) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '../src/signal_parser.ts');
    const py = spawn(process.execPath, ['--import', 'tsx', scriptPath, '--stdin'], {
      shell: false,
      env: { ...process.env, ...customEnv }
    });

    let stdout = '';
    let stderr = '';

    py.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    py.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    py.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `Process exited with code ${code}`));
      }
    });

    py.on('error', (err) => {
      reject(err);
    });

    py.stdin.write(text);
    py.stdin.end();
  });
}

function parseSignalWithMockPython(text) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'mock_parser.js');
    const py = spawn(process.execPath, [scriptPath], {
      shell: false,
      env: { ...process.env, OPENROUTER_API_KEY: 'dummy_key' }
    });

    let stdout = '';
    let stderr = '';

    py.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    py.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    py.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `Process exited with code ${code}`));
      }
    });

    py.on('error', (err) => {
      reject(err);
    });

    py.stdin.write(text);
    py.stdin.end();
  });
}

async function runTests() {
  console.log("=== Running Node.js Integration Verification ===");
  console.log("1. Testing TS parser child process execution from Node.js...");

  // We pass an empty OPENROUTER_API_KEY to force a configuration error.
  // We want to verify that the Node.js helper correctly captures the stderr and rejects with it.
  const dummySignalText = "➡️ SHORT HYPEUSDT Entry: 68.60 - 70.07 Stoploss: 70.97 Leverage: 15x";
  
  try {
    await parseSignalWithPython(dummySignalText, { OPENROUTER_API_KEY: '' });
    console.error("FAIL: Expected parseSignalWithPython to throw an error due to missing API key, but it succeeded.");
    process.exit(1);
  } catch (error) {
    if (error.message.includes("OPENROUTER_API_KEY environment variable is not set")) {
      console.log("SUCCESS: Captured expected configuration error from TS parser script:", error.message);
    } else {
      console.error("FAIL: Received unexpected error:", error.message);
      process.exit(1);
    }
  }

  console.log("2. Testing successful mock parsing via JS subprocess...");
  try {
    const result = await parseSignalWithMockPython(dummySignalText);
    assert.match(result, /<signal>/);
    assert.match(result, /<action>SHORT<\/action>/);
    assert.match(result, /<pair>HYPEUSDT<\/pair>/);
    assert.match(result, /<leverage>15<\/leverage>/);
    console.log("SUCCESS: Correctly received and validated structured XML from mock JS subprocess.");
  } catch (error) {
    console.error("FAIL: Mock JS execution failed:", error.message);
    process.exit(1);
  }

  console.log("3. Verifying configuration parameters...");
  console.log("xmlParsing configuration:", JSON.stringify(config.xmlParsing, null, 2));
  if (config.xmlParsing && typeof config.xmlParsing.enabled === 'boolean') {
    console.log("SUCCESS: xmlParsing configuration is valid.");
  } else {
    console.error("FAIL: xmlParsing configuration is missing or invalid.");
    process.exit(1);
  }

  console.log("\nALL NODE.JS INTEGRATION VERIFICATION TESTS PASSED!");
}

await runTests().catch(err => {
  console.error("Integration verification failed with exception:", err);
  process.exit(1);
});
