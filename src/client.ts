/**
 * Minimal, dependency-free ZillAPI REST client.
 *
 * Docs: https://zillapi.com/docs  ·  OpenAPI: https://zillapi.com/openapi.json
 * Auth: `Authorization: Bearer zk_...`  ·  Base URL: https://api.zillapi.com
 */

export const DEFAULT_BASE_URL = "https://api.zillapi.com";
export const USER_AGENT = "zillapi-vercel-ai-sdk-example/1.0 (+https://zillapi.com)";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ZillapiClientOptions {
  /** Your ZillAPI key (zk_...). Defaults to process.env.ZILLAPI_API_KEY. */
  apiKey?: string;
  baseUrl?: string;
  /** Inject a fetch implementation (tests use this to mock HTTP). */
  fetch?: FetchLike;
  /** Retries on 429 / 5xx. Default 2. */
  maxRetries?: number;
  /** Override the sleep used between retries (tests set this to a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

/** Thrown for any non-2xx response. `code` is the stable ZillAPI error code. */
export class ZillapiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ZillapiError";
  }
}

export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface SearchFilters {
  status?: "for_sale" | "for_rent" | "sold";
  bbox: BoundingBox;
  location?: string;
  price?: { min?: number; max?: number };
  beds?: { min?: number; max?: number };
  baths?: { min?: number; max?: number };
  sqft?: { min?: number; max?: number };
  homeTypes?: Array<"house" | "condo" | "townhouse" | "multi_family" | "manufactured" | "lot" | "apartment">;
}

/** A search row (compact card). Not the same shape as a full Property record. */
export interface SearchRow {
  zpid: string;
  address?: string | null;
  addressCity?: string | null;
  addressState?: string | null;
  addressZipcode?: string | null;
  price?: string | null;
  unformattedPrice?: number | null;
  beds?: number | null;
  baths?: number | null;
  area?: number | null;
  statusType?: string | null;
  homeType?: string | null;
  detailUrl?: string | null;
  hdpData?: { homeInfo?: Record<string, unknown> };
  [key: string]: unknown;
}

export interface Zestimate {
  zestimate: number | null;
  rent_zestimate: number | null;
  tax_assessed_value: number | null;
  last_sold_price: number | null;
  currency?: string;
}

export type Property = Record<string, unknown> & { zpid: string };

interface Envelope<T> {
  data: T;
  request_id?: string;
  meta?: { count?: number };
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ZillapiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: ZillapiClientOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.ZILLAPI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Missing ZillAPI key. Set ZILLAPI_API_KEY (free key with 100 credits: https://zillapi.com/signup).",
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (opts.baseUrl ?? process.env.ZILLAPI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.maxRetries = opts.maxRetries ?? 2;
    this.sleep = opts.sleep ?? sleepReal;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    { query, body }: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<Envelope<T>> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }

    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      if (res.ok) return (await res.json()) as Envelope<T>;

      const retryable = res.status === 429 || res.status === 502 || res.status === 504;
      if (retryable && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
        await this.sleep(backoff + Math.floor(Math.random() * 250));
        continue;
      }

      let payload: { error?: { code?: string; message?: string; request_id?: string } } = {};
      try {
        payload = await res.json();
      } catch {
        /* non-JSON error body */
      }
      const err = payload.error ?? {};
      throw new ZillapiError(
        err.message ?? `ZillAPI request failed with HTTP ${res.status}`,
        res.status,
        err.code ?? "http_error",
        err.request_id,
      );
    }
  }

  /** POST /v1/search. A bounding box is required. 1 credit per row returned. */
  async search(filters: SearchFilters, maxItems = 5): Promise<SearchRow[]> {
    const res = await this.request<SearchRow[]>("POST", "/v1/search", {
      body: { filters, maxItems },
    });
    return res.data;
  }

  /** GET /v1/properties/{zpid}. Full record (300+ fields); use `fields` to project. 1 credit. */
  async getProperty(zpid: string, fields?: string): Promise<Property> {
    return (await this.request<Property>("GET", `/v1/properties/${encodeURIComponent(zpid)}`, { query: { fields } })).data;
  }

  /** GET /v1/properties/by-url. 1 credit per record. */
  async getPropertyByUrl(url: string, fields?: string): Promise<Property> {
    return (await this.request<Property>("GET", "/v1/properties/by-url", { query: { url, fields } })).data;
  }

  /** GET /v1/properties/by-address. Full street address with city, state and ZIP. 3 credits. */
  async getPropertyByAddress(
    address: string,
    status: "FOR_SALE" | "RECENTLY_SOLD" | "FOR_RENT" = "FOR_SALE",
    fields?: string,
  ): Promise<Property> {
    return (await this.request<Property>("GET", "/v1/properties/by-address", { query: { address, status, fields } }))
      .data;
  }

  /** GET /v1/properties/{zpid}/zestimate. 1 credit. */
  async getZestimate(zpid: string): Promise<Zestimate> {
    return (await this.request<Zestimate>("GET", `/v1/properties/${encodeURIComponent(zpid)}/zestimate`)).data;
  }

  /** GET /v1/properties/{zpid}/nearby. Comparable nearby homes. 1 credit. */
  async getComparables(zpid: string): Promise<SearchRow[]> {
    return (await this.request<SearchRow[]>("GET", `/v1/properties/${encodeURIComponent(zpid)}/nearby`)).data;
  }
}
