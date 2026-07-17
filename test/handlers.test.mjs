import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GMapsScraperError } from '@gmapsscraper/sdk';
import { buildServer } from '../src/index.js';

async function connect(fakeClient) {
  const server = buildServer({ createClient: () => fakeClient });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function parseText(result) {
  return JSON.parse(result.content[0].text);
}

test('scrape timeout returns job_id and recovery path, not a bare error', async () => {
  const fake = {
    createJob: async () => ({ id: 'job_42', credits_remaining: 6 }),
    waitForJob: async () => {
      throw new GMapsScraperError('Timed out after 1ms waiting for job job_42', undefined, { id: 'job_42', status: 'running' });
    },
  };
  const client = await connect(fake);
  const result = await client.callTool({
    name: 'scrape_google_maps',
    arguments: { keywords: ['coffee in Austin TX'], max_wait_seconds: 30 },
  });
  assert.notEqual(result.isError, true, 'timeout is a recoverable state, not an error');
  const payload = parseText(result);
  assert.equal(payload.job_id, 'job_42');
  assert.equal(payload.status, 'running');
  assert.match(payload.next_step, /Do NOT re-run/);
  assert.match(payload.next_step, /get_scrape_results/);
});

test('failed job surfaces failure with do-not-rerun guidance', async () => {
  const fake = {
    createJob: async () => ({ id: 'job_9', credits_remaining: 6 }),
    waitForJob: async () => {
      throw new GMapsScraperError('Job job_9 failed', undefined, { id: 'job_9', status: 'failed' });
    },
  };
  const client = await connect(fake);
  const result = await client.callTool({
    name: 'scrape_google_maps',
    arguments: { keywords: ['x in Nowhere KS'] },
  });
  assert.equal(result.isError, true);
  const payload = parseText(result);
  assert.equal(payload.status, 'failed');
  assert.match(payload.note, /Do NOT simply re-run/);
});

test('get_scrape_results reports failed jobs distinctly', async () => {
  const fake = { getJob: async () => ({ id: 'job_7', status: 'failed' }) };
  const client = await connect(fake);
  const result = await client.callTool({ name: 'get_scrape_results', arguments: { job_id: 'job_7' } });
  assert.equal(result.isError, true);
  assert.equal(parseText(result).status, 'failed');
});

test('successful flow returns capped records with totals', async () => {
  const records = Array.from({ length: 150 }, (_, i) => ({ title: `Biz ${i}` }));
  const fake = {
    createJob: async (kw) => {
      assert.deepEqual(kw, ['pizza in NYC']);
      return { id: 'job_1', credits_remaining: 4 };
    },
    waitForJob: async () => ({ id: 'job_1', status: 'complete' }),
    downloadRecords: async () => records,
  };
  const client = await connect(fake);
  const result = await client.callTool({ name: 'scrape_google_maps', arguments: { keywords: [' pizza in NYC '] } });
  const payload = parseText(result);
  assert.equal(payload.total_results, 150);
  assert.equal(payload.returned, 100);
  assert.match(payload.note, /first 100/);
});

test('whitespace-only keywords are rejected before any credits are spent', async () => {
  let created = false;
  const fake = { createJob: async () => { created = true; return { id: 'x' }; } };
  const client = await connect(fake);
  // The SDK surfaces schema validation either as a thrown McpError or an isError
  // result depending on version — accept both, but the client must never be called.
  let rejected = false;
  try {
    const result = await client.callTool({ name: 'scrape_google_maps', arguments: { keywords: ['   '] } });
    rejected = result.isError === true && /non-empty/.test(result.content[0].text);
  } catch (err) {
    rejected = /non-empty/.test(String(err.message));
  }
  assert.equal(rejected, true, 'whitespace-only keywords should be rejected with a clear message');
  assert.equal(created, false);
});

test('spend tools carry non-idempotent annotations, read tools are read-only', async () => {
  const client = await connect({});
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName.scrape_google_maps.annotations.idempotentHint, false);
  assert.equal(byName.scrape_google_maps.annotations.readOnlyHint, false);
  assert.equal(byName.start_scrape_job.annotations.idempotentHint, false);
  assert.equal(byName.get_scrape_results.annotations.readOnlyHint, true);
  assert.equal(byName.get_credits.annotations.readOnlyHint, true);
  assert.match(byName.start_scrape_job.description, /confirm with the user/);
  assert.match(byName.scrape_google_maps.description, /confirm with the user/);
});
