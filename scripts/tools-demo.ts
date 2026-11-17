/**
 * Calls the ZillAPI tools directly, with no LLM, so you can check your key and see the data shapes.
 * Uses 2 API calls: one search (maxItems=3, so at most 3 credits) and one Zestimate lookup (1 credit).
 *
 *   ZILLAPI_API_KEY=zk_... npm run tools-demo
 */
import { createZillapiTools } from "../src/tools";

const tools = createZillapiTools();
const ctx = { toolCallId: "demo", messages: [] } as never;

const search = await tools.searchListings.execute!(
  {
    bbox: { west: -97.94, south: 30.1, east: -97.56, north: 30.52 },
    status: "for_sale",
    location: "Austin, TX",
    bedsMin: 3,
    bedsMax: 3,
    priceMax: 500_000,
    maxItems: 3,
  },
  ctx,
);
console.log("searchListings ->", JSON.stringify(search, null, 2));

const first = "results" in search ? search.results[0] : undefined;
if (first) {
  const z = await tools.getZestimate.execute!({ zpid: first.zpid }, ctx);
  console.log("getZestimate ->", JSON.stringify(z, null, 2));
}
