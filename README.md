# gmapsscraper MCP Server

[![npm version](https://img.shields.io/npm/v/%40gmapsscraper%2Fmcp.svg)](https://www.npmjs.com/package/@gmapsscraper/mcp)
[![license](https://img.shields.io/npm/l/%40gmapsscraper%2Fmcp.svg)](./LICENSE)

MCP (Model Context Protocol) server for [gmapsscraper.io](https://gmapsscraper.io) — lets Claude, Cursor, Windsurf and any MCP client **scrape Google Maps business data** in plain conversation: names, addresses, phones, **emails**, websites, ratings, review counts, categories and coordinates.

> "Find 50 dentists in Chicago with their emails" → done, right in your AI chat.

## Tools

| Tool | What it does |
|---|---|
| `scrape_google_maps` | Search Google Maps and return business leads (blocks until done, ~30–120s) |
| `start_scrape_job` | Fire-and-forget version — returns a job id immediately |
| `get_scrape_results` | Fetch results of a previously started job |
| `get_credits` | Check remaining credit balance |

Each scrape costs 2 credits; multiple keywords in one call cost the same. **Free tier: 10 credits** (5 searches, no credit card) — get an API key at [gmapsscraper.io/dashboard](https://gmapsscraper.io/dashboard).

## Setup

### Claude Code

```bash
claude mcp add gmapsscraper -e GMAPSSCRAPER_API_KEY=your_key -- npx -y @gmapsscraper/mcp
```

### Claude Desktop / Cursor / Windsurf

Add to your MCP config (`claude_desktop_config.json`, `.cursor/mcp.json`, etc.):

```json
{
  "mcpServers": {
    "gmapsscraper": {
      "command": "npx",
      "args": ["-y", "@gmapsscraper/mcp"],
      "env": {
        "GMAPSSCRAPER_API_KEY": "your_key"
      }
    }
  }
}
```

Requires Node.js ≥ 18. The server runs locally over stdio and talks to the [gmapsscraper.io API](https://gmapsscraper.io/llms.txt) — no other infrastructure involved.

## Example prompts

- *"Scrape coffee shops in Austin TX with emails and give me a table"*
- *"Find plumbers in Miami, then draft a cold email for the top 5 by rating"*
- *"Start a scrape for 'wedding photographer in Denver CO', I'll check back later"*
- *"How many gmapsscraper credits do I have left?"*

## Data returned per business

`title, address, phone, email, website, rating, reviews_count, category, latitude, longitude, google_maps_url, opening_hours`

Results are capped at 100 businesses per response to keep your context tidy; the full CSV is always available from the [dashboard](https://gmapsscraper.io/dashboard).

## Related

- 📦 [Node.js SDK](https://github.com/gmapsscraper/gmapsscraper-js) — `npm install @gmapsscraper/sdk` (this server is built on it)
- 🐍 [Python SDK](https://github.com/gmapsscraper/gmapsscraper-python) — `pip install gmapsscraper-sdk`
- 🤖 [Claude agent skills](https://github.com/gmapsscraper/google-maps-agent-skills)
- 📘 [API docs / llms.txt](https://gmapsscraper.io/llms.txt)

## License

[MIT](./LICENSE) © [gmapsscraper.io](https://gmapsscraper.io)
