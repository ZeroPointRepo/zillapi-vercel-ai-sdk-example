import { describe, expect, it } from "vitest";
import { ZillapiClient, ZillapiError, USER_AGENT } from "../src/client";
import { fixtureFetch, type RecordedCall } from "./helpers";

const noSleep = async () => {};

describe("ZillapiClient", () => {
  it("requires an API key", () => {
    const prev = process.env.ZILLAPI_API_KEY;
    delete process.env.ZILLAPI_API_KEY;
    expect(() => new ZillapiClient()).toThrow(/ZILLAPI_API_KEY/);
    if (prev !== undefined) process.env.ZILLAPI_API_KEY = prev;
  });

  it("sends Bearer auth, User-Agent and the search body to POST /v1/search", async () => {
    const calls: RecordedCall[] = [];
    const client = new ZillapiClient({ apiKey: "zk_test", fetch: fixtureFetch(calls) });
    const bbox = { west: -1, south: 1, east: 2, north: 3 };
    const rows = await client.search({ bbox, beds: { min: 3 } }, 3);

    expect(rows).toHaveLength(3);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.toString()).toBe("https://api.zillapi.com/v1/search");
    expect(calls[0].headers.Authorization).toBe("Bearer zk_test");
    expect(calls[0].headers["User-Agent"]).toBe(USER_AGENT);
    expect(calls[0].body).toEqual({ filters: { bbox, beds: { min: 3 } }, maxItems: 3 });
  });

  it("hits the documented property endpoints", async () => {
    const calls: RecordedCall[] = [];
    const client = new ZillapiClient({ apiKey: "zk_test", fetch: fixtureFetch(calls) });
    await client.getProperty("123", "zpid,price");
    await client.getPropertyByUrl("https://www.zillow.com/homedetails/123_zpid/");
    await client.getPropertyByAddress("1 Main St, Austin, TX 78701");
    await client.getZestimate("123");
    await client.getComparables("123");

    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "GET /v1/properties/123",
      "GET /v1/properties/by-url",
      "GET /v1/properties/by-address",
      "GET /v1/properties/123/zestimate",
      "GET /v1/properties/123/nearby",
    ]);
    expect(calls[0].url.searchParams.get("fields")).toBe("zpid,price");
    expect(calls[1].url.searchParams.get("url")).toBe("https://www.zillow.com/homedetails/123_zpid/");
    expect(calls[2].url.searchParams.get("address")).toBe("1 Main St, Austin, TX 78701");
    expect(calls[2].url.searchParams.get("status")).toBe("FOR_SALE");
  });

  it("maps the error envelope to ZillapiError", async () => {
    const client = new ZillapiClient({
      apiKey: "zk_test",
      fetch: fixtureFetch([], {
        "POST /v1/search": () =>
          new Response(JSON.stringify({ error: { code: "invalid_filters", message: "bbox required", request_id: "req_1" } }), {
            status: 400,
          }),
      }),
    });
    const err = await client.search({ bbox: { west: 0, south: 0, east: 0, north: 0 } }).catch((e) => e);
    expect(err).toBeInstanceOf(ZillapiError);
    expect(err).toMatchObject({ status: 400, code: "invalid_filters", requestId: "req_1" });
  });

  it("retries on 429 then succeeds", async () => {
    let n = 0;
    const calls: RecordedCall[] = [];
    const base = fixtureFetch(calls);
    const client = new ZillapiClient({
      apiKey: "zk_test",
      sleep: noSleep,
      fetch: async (input, init) =>
        n++ === 0
          ? new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow down" } }), { status: 429 })
          : base(input, init),
    });
    const z = await client.getZestimate("1");
    expect(z.zestimate).toBe(395000);
    expect(n).toBe(2);
  });

  it("gives up after maxRetries", async () => {
    let n = 0;
    const client = new ZillapiClient({
      apiKey: "zk_test",
      sleep: noSleep,
      maxRetries: 1,
      fetch: async () => {
        n++;
        return new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow down" } }), { status: 429 });
      },
    });
    await expect(client.getZestimate("1")).rejects.toMatchObject({ code: "rate_limited" });
    expect(n).toBe(2);
  });
});
