/**
 * Test helpers: synthetic ZillAPI fixtures, a fetch mock, and a scripted stub model.
 * Nothing here talks to the network or to a paid model API.
 */
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { FetchLike } from "../src/client";

// ---------- Synthetic fixtures (shapes follow https://zillapi.com/openapi.json) ----------

export const SEARCH_ROWS = [
  {
    zpid: "1000001",
    address: "101 Example Ln, Austin, TX 78745",
    addressCity: "Austin",
    addressState: "TX",
    unformattedPrice: 449000,
    price: "$449,000",
    beds: 3,
    baths: 2,
    area: 1520,
    statusType: "FOR_SALE",
    detailUrl: "/homedetails/1000001_zpid/",
    hdpData: { homeInfo: { homeStatus: "FOR_SALE", homeType: "SINGLE_FAMILY", zestimate: 452300, daysOnZillow: 12 } },
  },
  {
    zpid: "1000002",
    address: "202 Sample Dr, Austin, TX 78744",
    unformattedPrice: 389900,
    beds: 3,
    baths: 2,
    area: 1340,
    statusType: "FOR_SALE",
    detailUrl: "https://www.zillow.com/homedetails/1000002_zpid/",
    hdpData: { homeInfo: { homeStatus: "FOR_SALE", homeType: "SINGLE_FAMILY", daysOnZillow: 30 } },
  },
  {
    zpid: "1000003",
    address: "303 Placeholder Ct, Austin, TX 78748",
    unformattedPrice: 495000,
    beds: 3,
    baths: 2.5,
    area: 1810,
    statusType: "FOR_SALE",
    detailUrl: "/homedetails/1000003_zpid/",
    hdpData: { homeInfo: { homeStatus: "FOR_SALE", homeType: "TOWNHOUSE", zestimate: 488100, rentZestimate: 2450 } },
  },
];

// Live /nearby rows (Nov 2026) came back with an address OBJECT rather than the documented search-row shape.
export const NEARBY_ROWS = [
  {
    zpid: "1000004",
    address: { streetAddress: "404 Demo Ave", city: "Austin", state: "TX", zipcode: "78745" },
    livingArea: 1350,
    homeType: "SINGLE_FAMILY",
  },
  {
    zpid: "1000005",
    address: { streetAddress: "505 Mock Blvd", city: "Austin", state: "TX", zipcode: "78745" },
    price: 410000,
    bedrooms: 3,
    bathrooms: 2,
    livingArea: 1144,
    homeType: "SINGLE_FAMILY",
    homeStatus: "RECENTLY_SOLD",
    hdpUrl: "/homedetails/1000005_zpid/",
  },
];

export const ZESTIMATE = {
  zestimate: 395000,
  rent_zestimate: 2200,
  tax_assessed_value: 351000,
  last_sold_price: 310000,
  currency: "USD",
};

export const PROPERTY = {
  zpid: "1000001",
  address: { streetAddress: "101 Example Ln", city: "Austin", state: "TX", zipcode: "78745" },
  price: 449000,
  zestimate: 452300,
  rentZestimate: 2390,
  bedrooms: 3,
  bathrooms: 2,
  livingArea: 1520,
  yearBuilt: 1998,
  homeType: "SINGLE_FAMILY",
  homeStatus: "FOR_SALE",
};

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: unknown;
}

/** A fetch mock that routes by path and records every request. */
export function fixtureFetch(calls: RecordedCall[] = [], overrides: Record<string, () => Response> = {}): FetchLike {
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

  return async (input, init) => {
    const url = new URL(input);
    calls.push({
      method: init?.method ?? "GET",
      url,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    if (overrides[key]) return overrides[key]();

    if (key === "POST /v1/search") return json({ data: SEARCH_ROWS, meta: { count: 3 }, request_id: "req_test" });
    if (/^GET \/v1\/properties\/\d+\/zestimate$/.test(key)) return json({ data: ZESTIMATE, request_id: "req_test" });
    if (/^GET \/v1\/properties\/\d+\/nearby$/.test(key)) return json({ data: NEARBY_ROWS, request_id: "req_test" });
    if (key === "GET /v1/properties/by-address" || key === "GET /v1/properties/by-url" || /^GET \/v1\/properties\/\d+$/.test(key))
      return json({ data: PROPERTY, request_id: "req_test" });
    return json({ error: { code: "not_found", message: `No fixture for ${key}`, request_id: "req_test" } }, 404);
  };
}

// ---------- Scripted stub model ----------

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

type Part = LanguageModelV4StreamPart;

function toolCallStream(calls: Array<{ toolName: string; input: unknown }>) {
  const parts: Part[] = [{ type: "stream-start", warnings: [] }];
  calls.forEach((c, i) =>
    parts.push({ type: "tool-call", toolCallId: `call_${c.toolName}_${i}`, toolName: c.toolName, input: JSON.stringify(c.input) }),
  );
  parts.push({ type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage });
  return { stream: convertArrayToReadableStream(parts) };
}

function textStream(text: string) {
  const words = text.split(/(?<= )/);
  return {
    stream: convertArrayToReadableStream<Part>([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      ...words.map((w) => ({ type: "text-delta" as const, id: "t1", delta: w })),
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
    ]),
  };
}

/** Pull tool results out of the prompt the SDK sends back to the model. */
function toolResults(prompt: unknown): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const msg of prompt as Array<{ role: string; content: unknown }>) {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    for (const p of msg.content as Array<{ type: string; toolName: string; output: { type: string; value: unknown } }>) {
      if (p.type !== "tool-result") continue;
      (out[p.toolName] ??= []).push(p.output?.value);
    }
  }
  return out;
}

const usd = (n: unknown) => (typeof n === "number" ? `$${n.toLocaleString("en-US")}` : "n/a");

/**
 * A deterministic stand-in for an LLM that behaves like a good tool-calling model:
 * step 1 searches Austin, step 2 fetches missing Zestimates, step 3 writes the table.
 */
export function scriptedModel() {
  return new MockLanguageModelV4({
    provider: "stub",
    modelId: "scripted-zillapi-agent",
    doStream: async ({ prompt }) => {
      const results = toolResults(prompt);
      const search = results.searchListings?.[0] as
        | { results: Array<{ zpid: string; address: string; price: number; beds: number; baths: number; sqft: number; zestimate: number | null; url: string }> }
        | undefined;

      if (!search) {
        return toolCallStream([
          {
            toolName: "searchListings",
            input: {
              bbox: { west: -97.94, south: 30.1, east: -97.56, north: 30.52 },
              status: "for_sale",
              location: "Austin, TX",
              bedsMin: 3,
              bedsMax: 3,
              priceMax: 500000,
              maxItems: 3,
            },
          },
        ]);
      }

      const missing = search.results.filter((r) => r.zestimate == null);
      if (missing.length && !results.getZestimate) {
        return toolCallStream(missing.map((r) => ({ toolName: "getZestimate", input: { zpid: r.zpid } })));
      }

      const zByZpid = new Map(
        ((results.getZestimate ?? []) as Array<{ zpid: string; zestimate: number }>).map((z) => [z.zpid, z.zestimate]),
      );
      const lines = search.results.map(
        (r) =>
          `| ${r.address} | ${usd(r.price)} | ${r.beds}/${r.baths} | ${r.sqft} | ${usd(r.zestimate ?? zByZpid.get(r.zpid))} | ${r.url} |`,
      );
      return textStream(
        [
          `Here are ${search.results.length} 3-bed homes for sale in Austin under $500k:`,
          "",
          "| Address | List price | Beds/Baths | Sqft | Zestimate | Link |",
          "|---|---|---|---|---|---|",
          ...lines,
        ].join("\n"),
      );
    },
  });
}
