import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import GMapsScraper, { GMapsScraperError } from '@gmapsscraper/sdk';

const require = createRequire(import.meta.url);
const { version: VERSION } = require('../package.json');

const MAX_RECORDS_RETURNED = 100;

const keywordsSchema = z.array(
  z.string().refine((s) => s.trim().length > 0, { message: 'keywords must be non-empty strings' })
).min(1);

function defaultCreateClient() {
  const apiKey = process.env.GMAPSSCRAPER_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GMAPSSCRAPER_API_KEY environment variable is not set. ' +
      'Get a free API key (10 credits, no credit card) at https://gmapsscraper.io/dashboard ' +
      'and add it to this MCP server\'s env config.'
    );
  }
  return new GMapsScraper(apiKey);
}

function jsonResult(payload, { isError = false } = {}) {
  return { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function formatRecords(records) {
  const shown = records.slice(0, MAX_RECORDS_RETURNED);
  return jsonResult({
    total_results: records.length,
    returned: shown.length,
    ...(records.length > shown.length
      ? { note: `Showing first ${MAX_RECORDS_RETURNED} of ${records.length} results. The full CSV is available from the gmapsscraper.io dashboard.` }
      : {}),
    businesses: shown,
  });
}

function errorResult(err) {
  let message = err instanceof Error ? err.message : String(err);
  if (err instanceof GMapsScraperError && err.status === 402) {
    message += ' — top up credits at https://gmapsscraper.io/#pricing';
  }
  return { isError: true, content: [{ type: 'text', text: message }] };
}

const SPEND_WARNING =
  'Costs 2 credits per call — every call bills again (NOT idempotent, do not retry on your own). ' +
  'Always confirm with the user before spending credits.';

export function buildServer({ createClient = defaultCreateClient } = {}) {
  const server = new McpServer({ name: 'gmapsscraper', version: VERSION });

  server.registerTool(
    'scrape_google_maps',
    {
      title: 'Scrape Google Maps businesses',
      description:
        'Search Google Maps and return business leads: name, address, phone, email, website, rating, reviews count, category, coordinates. ' +
        `${SPEND_WARNING} Multiple related keywords in one call cost the same 2 credits. ` +
        'Blocks until the scrape finishes (typically 30-120s). Be specific with keywords, e.g. "vegan restaurant in Brooklyn NY".',
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
      inputSchema: {
        keywords: keywordsSchema.describe('Search queries including a location, e.g. ["dentist in Chicago IL"]. Multiple related keywords cost the same 2 credits.'),
        email: z.boolean().optional().default(false).describe('Also crawl business websites to extract contact emails (recommended for lead generation / cold outreach).'),
        depth: z.number().int().min(1).max(2).optional().default(2).describe('1-2, higher returns more results at the same credit cost.'),
        lang: z.string().optional().default('en').describe('ISO 639-1 result language, e.g. "en", "es", "de".'),
        radius: z.number().int().positive().optional().describe('Search radius in meters (default 20000).'),
        max_wait_seconds: z.number().int().min(30).max(900).optional().default(300).describe('How long to wait for the scrape to finish before handing back a job id to poll.'),
      },
    },
    async ({ keywords, email, depth, lang, radius, max_wait_seconds }) => {
      let client;
      try { client = createClient(); } catch (err) { return errorResult(err); }
      let job;
      try {
        job = await client.createJob(keywords.map((k) => k.trim()), {
          email, depth, lang,
          ...(radius ? { radius } : {}),
        });
      } catch (err) {
        return errorResult(err); // nothing was billed if job creation failed
      }
      try {
        await client.waitForJob(job.id, { timeout: max_wait_seconds * 1000 });
        return formatRecords(await client.downloadRecords(job.id));
      } catch (err) {
        // The job exists and credits are already spent — hand the model a
        // recovery path instead of a bare error so it never re-runs the scrape.
        const jobFailed = err instanceof GMapsScraperError && err.body?.status === 'failed';
        if (jobFailed) {
          return jsonResult({
            job_id: job.id,
            status: 'failed',
            error: err.message,
            note: 'Do NOT simply re-run the same scrape. Zero-result jobs are refunded automatically; for other failures check the dashboard at https://gmapsscraper.io/dashboard or adjust the keywords/location.',
          }, { isError: true });
        }
        const timedOut = /Timed out/i.test(err?.message ?? '');
        return jsonResult({
          job_id: job.id,
          status: timedOut ? 'running' : 'unknown',
          ...(timedOut ? {} : { error: String(err?.message ?? err) }),
          credits_already_spent: true,
          next_step: `Do NOT re-run the scrape (credits are already spent). Call get_scrape_results with job_id "${job.id}"${timedOut ? ' in ~60 seconds' : ' to fetch the results'}.`,
        });
      }
    }
  );

  server.registerTool(
    'start_scrape_job',
    {
      title: 'Start a scrape job (async)',
      description:
        'Submit a Google Maps scrape job without waiting for it to finish. ' +
        `${SPEND_WARNING} Returns a job id — poll it later with get_scrape_results. ` +
        'Use this instead of scrape_google_maps for large areas or when the user wants to continue working meanwhile.',
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
      inputSchema: {
        keywords: keywordsSchema.describe('Search queries including a location, e.g. ["plumber in Miami FL"]. Multiple related keywords cost the same 2 credits.'),
        email: z.boolean().optional().default(false).describe('Also crawl business websites to extract contact emails (recommended for lead generation / cold outreach).'),
        depth: z.number().int().min(1).max(2).optional().default(2).describe('1-2, higher returns more results at the same credit cost.'),
        lang: z.string().optional().default('en').describe('ISO 639-1 result language, e.g. "en", "es", "de".'),
        radius: z.number().int().positive().optional().describe('Search radius in meters (default 20000).'),
      },
    },
    async ({ keywords, email, depth, lang, radius }) => {
      try {
        const client = createClient();
        const job = await client.createJob(keywords.map((k) => k.trim()), {
          email, depth, lang,
          ...(radius ? { radius } : {}),
        });
        return jsonResult({
          job_id: job.id,
          credits_remaining: job.credits_remaining,
          next_step: 'Call get_scrape_results with this job_id in ~60 seconds.',
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'get_scrape_results',
    {
      title: 'Get scrape job results',
      description:
        'Check the status of a scrape job and fetch the business records once it is complete. ' +
        'Does not spend credits — safe to call repeatedly.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        job_id: z.string().min(1).describe('Job id returned by start_scrape_job or scrape_google_maps.'),
      },
    },
    async ({ job_id }) => {
      try {
        const client = createClient();
        const job = await client.getJob(job_id);
        if (job.status === 'failed') {
          return jsonResult({
            job_id,
            status: 'failed',
            note: 'Do NOT simply re-run the same scrape. Zero-result jobs are refunded automatically; for other failures check https://gmapsscraper.io/dashboard or adjust the keywords/location.',
          }, { isError: true });
        }
        if (job.status !== 'complete') {
          return jsonResult({ job_id, status: job.status, hint: 'Still running — check again in ~30 seconds. This call is free.' });
        }
        return formatRecords(await client.downloadRecords(job_id));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'get_credits',
    {
      title: 'Check credit balance',
      description:
        'Get the remaining gmapsscraper.io credit balance for the configured API key. ' +
        'Each scrape costs 2 credits. Free to call.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {},
    },
    async () => {
      try {
        const client = createClient();
        const { credits } = await client.credits();
        return jsonResult({ credits, searches_remaining: Math.floor(credits / 2), top_up_url: 'https://gmapsscraper.io/#pricing' });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  return server;
}

export async function main() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`gmapsscraper MCP server v${VERSION} running on stdio`);
}
