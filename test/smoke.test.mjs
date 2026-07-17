import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Speaks newline-delimited JSON-RPC to the server over stdio, like a real MCP client.
function rpcSession(messages, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'bin.js')], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const responses = [];
    let buffer = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('smoke test timed out')); }, 15000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        responses.push(JSON.parse(line));
        if (responses.length >= messages.filter((m) => m.id !== undefined).length) {
          clearTimeout(timer);
          child.kill();
          resolve(responses);
        }
      }
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    for (const message of messages) {
      child.stdin.write(JSON.stringify(message) + '\n');
    }
  });
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '0.0.0' },
  },
};
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };

test('server initializes and lists all four tools', async () => {
  const responses = await rpcSession([
    INITIALIZE,
    INITIALIZED,
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);
  const init = responses.find((r) => r.id === 1);
  assert.equal(init.result.serverInfo.name, 'gmapsscraper');
  const list = responses.find((r) => r.id === 2);
  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['get_credits', 'get_scrape_results', 'scrape_google_maps', 'start_scrape_job']);
  const scrape = list.result.tools.find((t) => t.name === 'scrape_google_maps');
  assert.ok(scrape.inputSchema.properties.keywords, 'keywords should be in the JSON schema');
});

test('tool call without API key returns a helpful error, not a crash', async () => {
  const env = { ...process.env };
  delete env.GMAPSSCRAPER_API_KEY;
  const responses = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'bin.js')], {
      env: { ...env, GMAPSSCRAPER_API_KEY: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = [];
    let buffer = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('timed out')); }, 15000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        out.push(JSON.parse(line));
        if (out.some((r) => r.id === 3)) { clearTimeout(timer); child.kill(); resolve(out); }
      }
    });
    child.on('error', reject);
    for (const message of [
      INITIALIZE,
      INITIALIZED,
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_credits', arguments: {} } },
    ]) {
      child.stdin.write(JSON.stringify(message) + '\n');
    }
  });
  const call = responses.find((r) => r.id === 3);
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /GMAPSSCRAPER_API_KEY/);
  assert.match(call.result.content[0].text, /gmapsscraper\.io\/dashboard/);
});
