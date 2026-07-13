import http from 'http';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeConfigSync } from './config.js';
import { addLog, getLogHistory } from './ui.js';
import { getIncomingMessages, getProcessedSignals, clearDb, deleteIncomingMessage, deleteProcessedSignal } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface WebServerState {
  config: any;
  state: any;
  getQueueState: () => { running: number; queued: number; maxConcurrency: number; paused: boolean };
  startForwarding: (config: any) => Promise<void>;
  stopForwarding: () => Promise<any>;
  reloadConfig: () => void;
  applyRuntimeConfig: (config: any) => void;
  updateEnvValue: (key: string, value: string) => void;
  getMetricsHistory?: () => any[];
}

let server: http.Server | null = null;

export function startWebServer(port: number, appState: WebServerState) {
  server = http.createServer(async (req, res) => {
    const url = req.url || '';
    const method = req.method || 'GET';

    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // GET /api/status
    if (url === '/api/status' && method === 'GET') {
      const queue = appState.getQueueState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        isRunning: appState.state.isRunning,
        connectionState: appState.state.connectionState || 'disconnected',
        totalForwardedCount: appState.state.totalForwardedCount || 0,
        processedSinceRestart: appState.state.processedSinceRestart || 0,
        forwardingEnabled: appState.config.forwardOptions?.forwardToTarget ?? true,
        forwardXmlToTarget: appState.config.xmlParsing?.forwardXmlToTarget ?? false,
        startTime: appState.state.startupTime
          ? new Date(appState.state.startupTime * 1000).toISOString()
          : null,
        queue,
        resolvedSources: Array.from(appState.state.resolvedSourceChatIds || []),
        openRouterModel: process.env.OPENROUTER_MODEL || 'google/gemini-flash-1.5',
        openRouterFallbackModel: process.env.OPENROUTER_FALLBACK_MODEL || 'anthropic/claude-3-haiku',
        openRouterApiKeyConfigured: !!process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY !== 'your_openrouter_api_key_here',
        config: {
          sourceChannels: appState.config.sourceChannels,
          targetChannel: appState.config.targetChannel,
        }
      }));
      return;
    }

    // GET /api/logs
    if (url === '/api/logs' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ logs: getLogHistory() }));
      return;
    }

    // GET /api/metrics-history
    if (url === '/api/metrics-history' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ history: appState.getMetricsHistory ? appState.getMetricsHistory() : [] }));
      return;
    }

    // GET /api/incoming-messages
    if (url === '/api/incoming-messages' && method === 'GET') {
      try {
        const messages = await getIncomingMessages(100);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ messages }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // GET /api/processed-signals
    if (url === '/api/processed-signals' && method === 'GET') {
      try {
        const signals = await getProcessedSignals(100);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ signals }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // DELETE /api/incoming-messages
    if (url.startsWith('/api/incoming-messages') && method === 'DELETE') {
      const parsedUrl = new URL(url, `http://${req.headers.host || 'localhost'}`);
      const idStr = parsedUrl.searchParams.get('id');
      const id = idStr ? parseInt(idStr, 10) : NaN;
      if (isNaN(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or invalid id.' }));
        return;
      }
      try {
        await deleteIncomingMessage(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // DELETE /api/processed-signals
    if (url.startsWith('/api/processed-signals') && method === 'DELETE') {
      const parsedUrl = new URL(url, `http://${req.headers.host || 'localhost'}`);
      const id = parsedUrl.searchParams.get('id');
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing id.' }));
        return;
      }
      try {
        await deleteProcessedSignal(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // POST /api/control
    if (url === '/api/control' && method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          if (payload.action === 'start') {
            if (appState.state.isRunning) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Routing is already active.' }));
              return;
            }
            appState.startForwarding(appState.config).catch(err => {
              addLog(`[ERROR] Fehler beim Web-Start: ${err.message}`);
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Routing started.' }));
          } else if (payload.action === 'stop') {
            if (!appState.state.isRunning) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Routing is not active.' }));
              return;
            }
            await appState.stopForwarding();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Routing stopped.' }));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid action.' }));
          }
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // GET /api/config
    if (url === '/api/config' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(appState.config));
      return;
    }

    // POST /api/config
    if (url === '/api/config' && method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const newConfig = JSON.parse(body);
          Object.assign(appState.config, newConfig);
          writeConfigSync(appState.config);
          appState.reloadConfig();
          appState.applyRuntimeConfig(appState.config);
          addLog('[INFO] Konfiguration über das Web-Dashboard aktualisiert.');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Configuration saved successfully.', queue: appState.getQueueState() }));
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid config JSON: ' + err.message }));
        }
      });
      return;
    }

    // POST /api/env
    if (url === '/api/env' && method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          if (payload.openRouterModel !== undefined) appState.updateEnvValue('OPENROUTER_MODEL', payload.openRouterModel);
          if (payload.openRouterFallbackModel !== undefined) appState.updateEnvValue('OPENROUTER_FALLBACK_MODEL', payload.openRouterFallbackModel);
          if (payload.openRouterApiKey !== undefined && payload.openRouterApiKey !== '') appState.updateEnvValue('OPENROUTER_API_KEY', payload.openRouterApiKey);
          
          addLog('[INFO] Environment variables updated via Web Dashboard.');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Environment variables saved successfully.' }));
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid env JSON: ' + err.message }));
        }
      });
      return;
    }

    // POST /api/import
    if (url === '/api/import' && method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const bundle = JSON.parse(body);
          if (!bundle.config || typeof bundle.config !== 'object') {
            throw new Error('Import file does not contain a valid "config" section.');
          }

          // Merge config
          Object.assign(appState.config, bundle.config);
          writeConfigSync(appState.config);

          // Apply ENV variables if present
          if (bundle.env && typeof bundle.env === 'object') {
            const ENV_KEYS_TO_EXPORT = ['OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'OPENROUTER_FALLBACK_MODEL', 'TELEGRAM_API_ID', 'TELEGRAM_API_HASH'];
            for (const key of ENV_KEYS_TO_EXPORT) {
              if (bundle.env[key] !== undefined) {
                appState.updateEnvValue(key, String(bundle.env[key]));
              }
            }
          }

          appState.reloadConfig();
          appState.applyRuntimeConfig(appState.config);
          addLog('[INFO] System configuration imported successfully from Web Dashboard.');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Configuration imported successfully.' }));
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Import failed: ' + err.message }));
        }
      });
      return;
    }

    // GET /api/templates
    if (url === '/api/templates' && method === 'GET') {
      const templatesDir = path.join(__dirname, '../templates');
      try {
        await fsPromises.mkdir(templatesDir, { recursive: true });
        const files = await fsPromises.readdir(templatesDir);
        const templates: Record<string, string> = {};
        
        let defaultContent = '';
        try {
          defaultContent = await fsPromises.readFile(path.join(templatesDir, 'default.txt'), 'utf-8');
        } catch {
          defaultContent = '';
        }
        templates['default'] = defaultContent;

        for (const file of files) {
          if (file.endsWith('.txt') && file !== 'default.txt') {
            const name = file.slice(0, -4);
            try {
              const content = await fsPromises.readFile(path.join(templatesDir, file), 'utf-8');
              templates[name] = content;
            } catch (e) {
              // ignore read errors
            }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ templates }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // POST /api/templates
    if (url === '/api/templates' && method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          const { name, content } = payload;
          if (!name || typeof name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(name)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid template name.' }));
            return;
          }
          
          const templatesDir = path.join(__dirname, '../templates');
          await fsPromises.mkdir(templatesDir, { recursive: true });
          await fsPromises.writeFile(path.join(templatesDir, `${name}.txt`), content || '', 'utf-8');
          
          addLog(`[INFO] Template '${name}' saved successfully via Web Dashboard.`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // DELETE /api/templates
    if (url.startsWith('/api/templates') && method === 'DELETE') {
      const parsedUrl = new URL(url, `http://${req.headers.host || 'localhost'}`);
      const name = parsedUrl.searchParams.get('name');
      if (!name || typeof name !== 'string' || name === 'default' || !/^[a-zA-Z0-9_-]+$/.test(name)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid template name for deletion.' }));
        return;
      }

      try {
        const templatesDir = path.join(__dirname, '../templates');
        const filePath = path.join(templatesDir, `${name}.txt`);
        try {
          await fsPromises.unlink(filePath);
          addLog(`[INFO] Template '${name}' deleted via Web Dashboard.`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err: any) {
          if (err.code === 'ENOENT') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Template not found.' }));
          } else {
            throw err;
          }
        }
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // POST /api/factory-reset
    if (url === '/api/factory-reset' && method === 'POST') {
      try {
        const { DEFAULT_CONFIG } = await import('./config.js');
        Object.assign(appState.config, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
        writeConfigSync(appState.config);
        appState.reloadConfig();
        appState.applyRuntimeConfig(appState.config);
        addLog('[INFO] Konfiguration über das Web-Dashboard auf Werkseinstellungen zurückgesetzt.');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Factory reset completed.' }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // POST /api/clear-database
    if (url === '/api/clear-database' && method === 'POST') {
      try {
        await clearDb();
        addLog('[INFO] SQLite-Datenbank über das Web-Dashboard geleert.');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Database cleared successfully.' }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Serve static files from frontend/dist
    let filePath = url === '/' ? '/index.html' : url;
    // Security check: prevent path traversal
    const normalizedPath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
    const absolutePath = path.join(__dirname, '../frontend/dist', normalizedPath);

    try {
      const stats = await fsPromises.stat(absolutePath);
      if (stats.isFile()) {
        const ext = path.extname(absolutePath).toLowerCase();
        let mimeType = 'application/octet-stream';
        if (ext === '.html') mimeType = 'text/html; charset=utf-8';
        else if (ext === '.js') mimeType = 'application/javascript; charset=utf-8';
        else if (ext === '.css') mimeType = 'text/css; charset=utf-8';
        else if (ext === '.png') mimeType = 'image/png';
        else if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
        else if (ext === '.gif') mimeType = 'image/gif';
        else if (ext === '.svg') mimeType = 'image/svg+xml';
        else if (ext === '.ico') mimeType = 'image/x-icon';
        else if (ext === '.json') mimeType = 'application/json';

        res.writeHead(200, { 'Content-Type': mimeType });
        const content = await fsPromises.readFile(absolutePath);
        res.end(content);
        return;
      }
    } catch {
      // Fallback to index.html for SPA routing
      try {
        const fallbackPath = path.join(__dirname, '../frontend/dist/index.html');
        const content = await fsPromises.readFile(fallbackPath);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
        return;
      } catch {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html>
<head><title>Dashboard Dev Mode</title></head>
<body style="font-family:sans-serif;background:#0d1117;color:#c9d1d9;padding:2rem;">
  <h1>Dashboard Development Mode</h1>
  <p>Bitte compile das React-Frontend mit: <code>npm run build</code></p>
</body>
</html>`);
        return;
      }
    }
  });

  server.listen(port, () => {
    console.log(`[INFO] Web Control Dashboard listening on http://localhost:${port}`);
  });
}

export function stopWebServer(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (server) {
      server.close(() => {
        resolve();
      });
      server = null;
    } else {
      resolve();
    }
  });
}
