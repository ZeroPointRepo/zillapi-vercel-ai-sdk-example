/**
 * ZillAPI tools for the Vercel AI SDK (`ai` package).
 *
 *   import { createZillapiTools } from "./tools";
 *   const result = streamText({ model, tools: createZillapiTools(), stopWhen: stepCountIs(8), prompt });
 */
import { tool } from "ai";
import { z } from "zod";
import { ZillapiClient, ZillapiError, type SearchRow, type ZillapiClientOptions } from "./client";

/** Fields projected on property lookups so the model gets a compact record instead of 200+ fields. */
export const PROPERTY_FIELDS = [
  "zpid",
  "address",
  "price",
  "zestimate",
  "rentZestimate",
  "bedrooms",
  "bathrooms",
  "livingArea",
  "lotSize",
  "yearBuilt",
  "homeType",
  "homeStatus",
  "latitude",
  "longitude",
].join(",");

const zpidSchema = z.string().regex(/^[0-9]+$/, "zpid must be numeric").describe("Zillow property id (zpid), numeric string");

const num = (v: unknown) => (typeof v === "number" ? v : null);
const first = <T>(...values: T[]) => values.find((v) => v !== undefined && v !== null && v !== "") ?? null;

function oneLineAddress(addr: unknown): string | null {
  if (addr && typeof addr === "object") {
    // detail-style address object
    const a = addr as Record<string, string | undefined>;
    const tail = [a.state, a.zipcode].filter(Boolean).join(" ");
    return [a.streetAddress, a.city, tail].filter(Boolean).join(", ") || null;
  }
  return typeof addr === "string" ? addr : null;
}

/**
 * Compact a listing row to the fields an LLM actually needs. Handles both the documented search-row shape
 * (unformattedPrice, beds, hdpData.homeInfo) and the detail-style shape (address object, bedrooms, livingArea)
 * that some endpoints return.
 */
export function compactRow(row: SearchRow) {
  const r = row as Record<string, unknown>;
  const info = (row.hdpData?.homeInfo ?? {}) as Record<string, unknown>;
  const link = first(r.detailUrl, r.hdpUrl, r.url) as string | null;
  return {
    zpid: String(row.zpid),
    address: oneLineAddress(r.address),
    price: first(num(r.unformattedPrice), num(r.price), num(info.price)),
    beds: first(r.beds, r.bedrooms, info.bedrooms) as number | null,
    baths: first(r.baths, r.bathrooms, info.bathrooms) as number | null,
    sqft: first(r.area, r.livingArea, info.livingArea) as number | null,
    homeType: first(r.homeType, info.homeType) as string | null,
    status: first(r.statusType, r.homeStatus, info.homeStatus) as string | null,
    zestimate: first(num(r.zestimate), num(info.zestimate)),
    rentZestimate: first(num(r.rentZestimate), num(info.rentZestimate)),
    daysOnZillow: num(info.daysOnZillow),
    url: link ? new URL(link, "https://www.zillow.com").toString() : null,
  };
}

/** Turn API errors into a value the model can read and recover from instead of crashing the run. */
async function safe<T>(fn: () => Promise<T>): Promise<T | { error: { code: string; message: string } }> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ZillapiError) return { error: { code: e.code, message: e.message } };
    throw e;
  }
}

export function createZillapiTools(options: ZillapiClientOptions | { client: ZillapiClient } = {}) {
  const client = "client" in options ? options.client : new ZillapiClient(options);

  return {
    searchListings: tool({
      description:
        "Search Zillow listings (for sale, for rent or sold) inside a bounding box with price, bed, bath and home-type filters. " +
        "A bounding box is REQUIRED; a city name alone is not accepted, so estimate the city's bbox from your own knowledge. " +
        "Returns compact rows with zpid, address, price, beds, baths, sqft and (when available) Zestimate. Costs 1 credit per row.",
      inputSchema: z.object({
        bbox: z
          .object({ west: z.number(), south: z.number(), east: z.number(), north: z.number() })
          .describe("Bounding box in decimal degrees, e.g. Austin TX ~ {west:-97.94,south:30.10,east:-97.56,north:30.52}"),
        status: z.enum(["for_sale", "for_rent", "sold"]).default("for_sale"),
        location: z.string().optional().describe("Optional place label like 'Austin, TX' (a hint only)"),
        priceMin: z.number().int().optional(),
        priceMax: z.number().int().optional(),
        bedsMin: z.number().int().optional(),
        bedsMax: z.number().int().optional(),
        bathsMin: z.number().optional(),
        homeTypes: z
          .array(z.enum(["house", "condo", "townhouse", "multi_family", "manufactured", "lot", "apartment"]))
          .optional(),
        maxItems: z.number().int().min(1).max(20).default(5).describe("Max rows to return (also the credit cap)"),
      }),
      execute: async (input) =>
        safe(async () => {
          const range = (min?: number, max?: number) =>
            min === undefined && max === undefined ? undefined : { min, max };
          const rows = await client.search(
            {
              status: input.status,
              bbox: input.bbox,
              location: input.location,
              price: range(input.priceMin, input.priceMax),
              beds: range(input.bedsMin, input.bedsMax),
              baths: range(input.bathsMin, undefined),
              homeTypes: input.homeTypes,
            },
            input.maxItems,
          );
          return { count: rows.length, results: rows.map(compactRow) };
        }),
    }),

    getProperty: tool({
      description:
        "Get a property's details (price, Zestimate, Rent Zestimate, beds, baths, sqft, year built, home type, status) " +
        "by Zillow zpid OR by a full Zillow URL. Provide exactly one of zpid or url. Costs 1 credit.",
      inputSchema: z.object({
        zpid: zpidSchema.optional(),
        url: z.string().url().optional().describe("Full zillow.com homedetails URL"),
      }),
      execute: async ({ zpid, url }) =>
        safe(async () => {
          if (zpid) return client.getProperty(zpid, PROPERTY_FIELDS);
          if (url) return client.getPropertyByUrl(url, PROPERTY_FIELDS);
          return { error: { code: "missing_input", message: "Provide zpid or url." } };
        }),
    }),

    getPropertyByAddress: tool({
      description:
        "Look up a property by full street address including city, state and ZIP, e.g. '123 Main St, Austin, TX 78701'. " +
        "Returns the same compact details as getProperty. Costs 3 credits, so prefer getProperty when you already have a zpid.",
      inputSchema: z.object({
        address: z.string().min(6),
        status: z.enum(["FOR_SALE", "RECENTLY_SOLD", "FOR_RENT"]).default("FOR_SALE"),
      }),
      execute: async ({ address, status }) => safe(() => client.getPropertyByAddress(address, status, PROPERTY_FIELDS)),
    }),

    getZestimate: tool({
      description:
        "Get the Zestimate (estimated market value), Rent Zestimate, tax-assessed value and last sold price for a zpid. Costs 1 credit.",
      inputSchema: z.object({ zpid: zpidSchema }),
      execute: async ({ zpid }) => safe(async () => ({ zpid, ...(await client.getZestimate(zpid)) })),
    }),

    getComparables: tool({
      description:
        "Get comparable nearby homes (comps, about 12 rows) for a zpid, useful for sanity-checking a price or Zestimate. Costs 1 credit.",
      inputSchema: z.object({ zpid: zpidSchema }),
      execute: async ({ zpid }) =>
        safe(async () => {
          const rows = await client.getComparables(zpid);
          return { zpid, count: rows.length, comparables: rows.map(compactRow) };
        }),
    }),
  };
}

export type ZillapiTools = ReturnType<typeof createZillapiTools>;
