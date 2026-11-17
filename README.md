# Zillow data in the Vercel AI SDK (ZillAPI example)

Give a Vercel AI SDK agent live Zillow property data: listing search, property details, Zestimates, Rent Zestimates and comps, as five typed tools powered by [ZillAPI](https://zillapi.com).

```ts
import { streamText, isStepCount } from "ai";
import { openai } from "@ai-sdk/openai";
import { createZillapiTools } from "./src/tools";

const result = streamText({
  model: openai("gpt-5.4-mini"),
  tools: createZillapiTools(), // reads ZILLAPI_API_KEY
  stopWhen: isStepCount(8),
  prompt: "Find 3-bed homes for sale in Austin under $500k and give me their Zestimates",
});
for await (const text of result.textStream) process.stdout.write(text);
```

Built and tested with `ai@7.0.173` (AI SDK 7), `zod` 4 and Node 22.

## Tools

| Tool | ZillAPI endpoint | Credits |
|---|---|---|
| `searchListings` | `POST /v1/search` (bounding box + price, beds, baths, home type) | 1 per row returned (capped by `maxItems`, default 5) |
| `getProperty` | `GET /v1/properties/{zpid}` or `GET /v1/properties/by-url` | 1 |
| `getPropertyByAddress` | `GET /v1/properties/by-address` | 3 |
| `getZestimate` | `GET /v1/properties/{zpid}/zestimate` | 1 |
| `getComparables` | `GET /v1/properties/{zpid}/nearby` | 1 |

Notes that matter for agents:

- **Search needs a bounding box.** ZillAPI does not accept a bare city name for search. The tool description tells the model to estimate the bbox itself (models are good at this), for example Austin, TX is roughly `{west:-97.94, south:30.10, east:-97.56, north:30.52}`.
- **Property lookups are projected** with `?fields=` so the model gets about 15 useful fields instead of the full 300+ field record. Edit `PROPERTY_FIELDS` in `src/tools.ts` to add price history, schools, agent contact and more.
- **Errors go back to the model** as `{ error: { code, message } }` so it can explain or retry instead of crashing the run. 429 and 5xx responses are retried with backoff.
- Search rows do not always include a Zestimate. The system prompt tells the model to call `getZestimate` for those rows.

## Setup

```bash
git clone https://github.com/ZeroPointRepo/zillapi-vercel-ai-sdk-example
cd zillapi-vercel-ai-sdk-example
npm install
cp .env.example .env   # then fill in the two keys
```

You need:

1. `ZILLAPI_API_KEY`: [sign up free](https://zillapi.com/signup) for 100 credits, no card required. Plans and top-ups: [zillapi.com/pricing](https://zillapi.com/pricing/).
2. A model provider key. The example uses `OPENAI_API_KEY` via `@ai-sdk/openai`, but any AI SDK provider works (Anthropic, Google, AI Gateway and others). Swap the model in `src/agent.ts`.

## Run

```bash
# Full agent, streaming (uses your model key + a few ZillAPI credits)
node --env-file=.env --import tsx src/agent.ts "Find 3-bed homes for sale in Austin under $500k and give me their Zestimates"

# Just the tools, no LLM (2 API calls, at most 4 credits)
node --env-file=.env --import tsx scripts/tools-demo.ts

# Whole agent loop offline: stub model + mocked ZillAPI (no keys, no cost)
npm run mock-agent

# Tests (mocked HTTP, no network)
npm test
```

## Sample output

`npm run tools-demo` against the live API on 2026-11-17 (street addresses, ZIP codes and zpids masked):

```text
searchListings -> {
  "count": 3,
  "results": [
    { "zpid": "339xxxxxx", "address": "[masked], Austin, TX", "price": 498000, "beds": 3, "baths": 2,
      "sqft": 1438, "homeType": "SINGLE_FAMILY", "status": "FOR_SALE", "zestimate": null, "daysOnZillow": 7, ... },
    { "zpid": "644xxxxx", "address": "[masked], Austin, TX", "price": 325000, "beds": 3, "baths": 3,
      "sqft": 2170, "homeType": "SINGLE_FAMILY", "status": "FOR_SALE", "zestimate": null, "daysOnZillow": 147, ... },
    { "zpid": "294xxxxx", "address": "[masked], Austin, TX", "price": 375000, "beds": 3, "baths": 1,
      "sqft": 1296, "homeType": "SINGLE_FAMILY", "status": "FOR_SALE", "zestimate": null, "daysOnZillow": 66, ... }
  ]
}
getZestimate -> {
  "zpid": "339xxxxxx",
  "zestimate": 489500,
  "rent_zestimate": 2345,
  "tax_assessed_value": 422241,
  "last_sold_price": null,
  "currency": "USD"
}
```

`npm run mock-agent` (stub model, synthetic data) shows how the agent streams tool calls and the answer:

```text
[tool] searchListings({"bbox":{"west":-97.94,"south":30.1,"east":-97.56,"north":30.52},"status":"for_sale","location":"Austin, TX","priceMax":500000,"bedsMin":3,"bedsMax":3,"maxItems":3})
[tool] searchListings -> {"count":3,"results":[{"zpid":"1000001","address":"101 Example Ln, Austin, TX 78745","price":449000,...

[tool] getZestimate({"zpid":"1000002"})
[tool] getZestimate -> {"zpid":"1000002","zestimate":395000,"rent_zestimate":2200,"tax_assessed_value":351000,"last_sold_price":310000,"currency":"USD"}

Here are 3 3-bed homes for sale in Austin under $500k:

| Address | List price | Beds/Baths | Sqft | Zestimate | Link |
|---|---|---|---|---|---|
| 101 Example Ln, Austin, TX 78745 | $449,000 | 3/2 | 1520 | $452,300 | https://www.zillow.com/homedetails/1000001_zpid/ |
| 202 Sample Dr, Austin, TX 78744 | $389,900 | 3/2 | 1340 | $395,000 | https://www.zillow.com/homedetails/1000002_zpid/ |
| 303 Placeholder Ct, Austin, TX 78748 | $495,000 | 3/2.5 | 1810 | $488,100 | https://www.zillow.com/homedetails/1000003_zpid/ |
```

## Prefer MCP? Use the hosted ZillAPI MCP server

If you would rather not maintain tool code, ZillAPI also runs a hosted MCP server at `https://api.zillapi.com/mcp` (streamable HTTP, same API key). With `@ai-sdk/mcp`:

```ts
import { createMCPClient } from "@ai-sdk/mcp";

const mcp = await createMCPClient({
  transport: {
    type: "http",
    url: "https://api.zillapi.com/mcp",
    headers: { Authorization: `Bearer ${process.env.ZILLAPI_API_KEY}` },
  },
});
const tools = await mcp.tools(); // pass to streamText / generateText, then await mcp.close()
```

The custom tools in this repo give you tighter control over cost (`maxItems`, field projection) and output shape; MCP gives you zero code and the same tools in Claude, ChatGPT, Cursor and Claude Code. Setup guides: [zillapi.com/blog](https://zillapi.com/blog/).

## Project layout

```text
src/client.ts       typed ZillAPI REST client (fetch, retries, error codes)
src/tools.ts        the five AI SDK tools (zod schemas)
src/agent.ts        streamText agent + CLI
scripts/            tools-demo (live, no LLM) and mock-agent (offline)
test/               vitest suite with mocked HTTP and a scripted stub model
```

## Links

- ZillAPI: [zillapi.com](https://zillapi.com) · [Sign up free (100 credits)](https://zillapi.com/signup) · [Pricing](https://zillapi.com/pricing/)
- Docs: [zillapi.com/docs](https://zillapi.com/docs) · [OpenAPI spec](https://zillapi.com/openapi.json) · [llms.txt](https://zillapi.com/llms.txt)
- Other integrations: [MCP server](https://github.com/ZeroPointRepo/zillow-mcp) · [Agent skills](https://github.com/ZeroPointRepo/zillow-skills) · [OpenAI Agents SDK example](https://github.com/ZeroPointRepo/zillapi-openai-agents-example) · [YouTube](https://www.youtube.com/@zillapi)

## License

MIT. See [LICENSE](LICENSE).

ZillAPI is an independent service and is not affiliated with or endorsed by Zillow Group.
