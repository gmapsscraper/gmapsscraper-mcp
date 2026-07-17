import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import GMapsScraper, { GMapsScraperError } from '@gmapsscraper/sdk';

const VERSION = '0.1.0';
const MAX_RECORDS_RETURNED = 100;

function getClient() {
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

function formatRecords(records) {
  const shown = records.slice(0, MAX_RECORDS_RETURNED);
  const payload = {
    total_results: records.length,
    returned: shown.length,
    ...(records.length > shown.length
      ? { note: `Showing first ${MAX_RECORDS_RETURNED} of ${records.length} results. Ask the user before requesting more detail; the full CSV is available from the gmapsscraper.io dashboard.` }
      : {}),
    businesses: shown,
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(err) {
  let message = err instanceof Error ? err.message : String(err);
  if (err instanceof GMapsScraperError && err.status === 402) {
    message += ' — top up credits at https://gmapsscraper.io/#pricing';
  }
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function buildServer() {
  const server = new McpServer({ name: 'gmapsscraper', version: VERSION });

  server.registerTool(
    'scrape_google_maps',
    {
      title: 'Scrape Google Maps businesses',
      description:
        'Search Google Maps and return business leads: name, address, phone, email, website, rating, reviews count, category, coordinates. ' +
        'Costs 2 credits per call regardless of how many keywords are passed. Blocks until the scrape finishes (typically 30-120s). ' +
        'Always confirm with the user before spending credits. Be specific with keywords, e.g. "vegan restaurant in Brooklyn NY".',
      inputSchema: {
        keywords: z.array(z.string()).min(1).describe('Search queries including a location, e.g. ["dentist in Chicago IL"]. Multiple related keywords cost the same 2 credits.'),
        email: z.boolean().optional().default(false).describe('Also crawl business websites to extract contact emails (recommended for lead generation / cold outreach).'),
        depth: z.number().int().min(1).max(2).optional().default(2).describe('1-2, higher returns more results at the same credit cost.'),
        lang: z.string().optional().default('en').describe('ISO 639-1 result language.'),
        radius: z.number().int().positive().optional().describe('Search radius in meters (default 20000).'),
        max_wait_seconds: z.number().int().min(30).max(900).optional().default(300).describe('How long to wait for the scrape to finish before giving up.'),
      },
    },
    async ({ keywords, email, depth, lang, radius, max_wait_seconds }) => {
      try {
        const client = getClient();
        const records = await client.scrape(keywords, {
          email, depth, lang,
          ...(radius ? { radius } : {}),
          timeout: max_wait_seconds * 1000,
        });
        return formatRecords(records);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'start_scrape_job',
    {
      title: 'Start a scrape job (async)',
      description:
        'Submit a Google Maps scrape job without waiting for it to finish. Costs 2 credits. Returns a job id — ' +
        'poll it later with get_scrape_results. Use this instead of scrape_google_maps for large areas or when the user wants to continue working meanwhile.',
      inputSchema: {
        keywords: z.array(z.string()).min(1).describe('Search queries including a location, e.g. ["plumber in Miami FL"].'),
        email: z.boolean().optional().default(false).describe('Also extract contact emails from business websites.'),
        depth: z.number().int().min(1).max(2).optional().default(2),
        lang: z.string().optional().default('en'),
        radius: z.number().int().positive().optional(),
      },
    },
    async ({ keywords, email, depth, lang, radius }) => {
      try {
        const client = getClient();
        const job = await client.createJob(keywords, {
          email, depth, lang,
          ...(radius ? { radius } : {}),
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              job_id: job.id,
              credits_remaining: job.credits_remaining,
              next_step: 'Call get_scrape_results with this job_id in ~60 seconds.',
            }, null, 2),
          }],
        };
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
        'Check the status of a scrape job started with start_scrape_job. Returns the business records if the job is complete, otherwise the current status.',
      inputSchema: {
        job_id: z.string().describe('Job id returned by start_scrape_job.'),
      },
    },
    async ({ job_id }) => {
      try {
        const client = getClient();
        const job = await client.getJob(job_id);
        if (job.status !== 'complete') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ job_id, status: job.status, hint: job.status === 'running' ? 'Still running — check again in ~30 seconds.' : undefined }, null, 2),
            }],
          };
        }
        const records = await client.downloadRecords(job_id);
        return formatRecords(records);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'get_credits',
    {
      title: 'Check credit balance',
      description: 'Get the remaining gmapsscraper.io credit balance for the configured API key. Each scrape costs 2 credits.',
      inputSchema: {},
    },
    async () => {
      try {
        const client = getClient();
        const { credits } = await client.credits();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ credits, searches_remaining: Math.floor(credits / 2), top_up_url: 'https://gmapsscraper.io/#pricing' }, null, 2),
          }],
        };
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
