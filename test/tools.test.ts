import { describe, expect, it } from "vitest";
import { ZillapiClient } from "../src/client";
import { compactRow, createZillapiTools } from "../src/tools";
import { runAgent } from "../src/agent";
import { fixtureFetch, NEARBY_ROWS, scriptedModel, SEARCH_ROWS, type RecordedCall } from "./helpers";

const ctx = { toolCallId: "t", messages: [] } as never;

function setup(overrides = {}) {
  const calls: RecordedCall[] = [];
  const client = new ZillapiClient({ apiKey: "zk_test", fetch: fixtureFetch(calls, overrides) });
  return { calls, tools: createZillapiTools({ client }) };
}

describe("compactRow", () => {
  it("keeps the useful fields and absolutizes the Zillow link", () => {
    expect(compactRow(SEARCH_ROWS[0] as never)).toMatchObject({
      zpid: "1000001",
      price: 449000,
      beds: 3,
      sqft: 1520,
      zestimate: 452300,
      url: "https://www.zillow.com/homedetails/1000001_zpid/",
    });
  });
});

describe("compactRow with detail-style rows", () => {
  it("formats an address object and reads bedrooms/bathrooms/hdpUrl", () => {
    expect(compactRow(NEARBY_ROWS[0] as never).address).toBe("404 Demo Ave, Austin, TX 78745");
    expect(compactRow(NEARBY_ROWS[1] as never)).toMatchObject({
      price: 410000,
      beds: 3,
      baths: 2,
      sqft: 1144,
      status: "RECENTLY_SOLD",
      url: "https://www.zillow.com/homedetails/1000005_zpid/",
    });
  });
});

describe("tools", () => {
  it("getComparables compacts nearby rows", async () => {
    const { tools } = setup();
    const out = await tools.getComparables.execute!({ zpid: "1000001" }, ctx);
    expect(out).toMatchObject({ count: 2, comparables: [{ zpid: "1000004" }, { beds: 3 }] });
  });


  it("exposes five tools with descriptions and schemas", () => {
    const { tools } = setup();
    expect(Object.keys(tools).sort()).toEqual(
      ["getComparables", "getProperty", "getPropertyByAddress", "getZestimate", "searchListings"].sort(),
    );
    for (const t of Object.values(tools)) {
      expect(t.description).toBeTruthy();
      expect(t.inputSchema).toBeTruthy();
    }
  });

  it("searchListings maps flat inputs to ZillAPI filters", async () => {
    const { calls, tools } = setup();
    const out = await tools.searchListings.execute!(
      {
        bbox: { west: -97.94, south: 30.1, east: -97.56, north: 30.52 },
        status: "for_sale",
        bedsMin: 3,
        bedsMax: 3,
        priceMax: 500000,
        maxItems: 3,
      },
      ctx,
    );
    expect(calls[0].body).toEqual({
      filters: {
        status: "for_sale",
        bbox: { west: -97.94, south: 30.1, east: -97.56, north: 30.52 },
        price: { max: 500000 },
        beds: { min: 3, max: 3 },
      },
      maxItems: 3,
    });
    expect(out).toMatchObject({ count: 3 });
  });

  it("getProperty uses zpid or url with a field projection", async () => {
    const { calls, tools } = setup();
    await tools.getProperty.execute!({ zpid: "1000001" }, ctx);
    await tools.getProperty.execute!({ url: "https://www.zillow.com/homedetails/1000001_zpid/" }, ctx);
    expect(calls[0].url.pathname).toBe("/v1/properties/1000001");
    expect(calls[0].url.searchParams.get("fields")).toContain("zestimate");
    expect(calls[1].url.pathname).toBe("/v1/properties/by-url");
    const missing = await tools.getProperty.execute!({}, ctx);
    expect(missing).toMatchObject({ error: { code: "missing_input" } });
  });

  it("returns API errors to the model instead of throwing", async () => {
    const { tools } = setup({
      "GET /v1/properties/999/zestimate": () =>
        new Response(JSON.stringify({ error: { code: "not_found", message: "no such zpid" } }), { status: 404 }),
    });
    const out = await tools.getZestimate.execute!({ zpid: "999" }, ctx);
    expect(out).toEqual({ error: { code: "not_found", message: "no such zpid" } });
  });

  it("rejects non-numeric zpids at the schema level", () => {
    const { tools } = setup();
    const schema = tools.getZestimate.inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ zpid: "abc" }).success).toBe(false);
    expect(schema.safeParse({ zpid: "123" }).success).toBe(true);
  });
});

describe("agent loop with a stub model", () => {
  it("streams tool calls and a final answer that uses the tool data", async () => {
    const { calls, tools } = setup();
    let out = "";
    await runAgent({ model: scriptedModel(), tools, write: (s) => (out += s) });

    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "POST /v1/search",
      "GET /v1/properties/1000002/zestimate",
    ]);
    expect(out).toContain("[tool] searchListings");
    expect(out).toContain("[tool] getZestimate");
    expect(out).toContain("| 202 Sample Dr, Austin, TX 78744 | $389,900 | 3/2 | 1340 | $395,000 |");
    expect(out).toContain("$452,300");
  });
});
