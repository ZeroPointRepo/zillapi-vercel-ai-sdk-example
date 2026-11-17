/**
 * Runs the full agent loop with a scripted stub model (no LLM key, no model cost) and a mocked ZillAPI.
 * Good for seeing exactly how tool calls and streaming fit together.
 *
 *   npm run mock-agent
 */
import { runAgent } from "../src/agent";
import { createZillapiTools } from "../src/tools";
import { ZillapiClient } from "../src/client";
import { scriptedModel, fixtureFetch } from "../test/helpers";

const client = new ZillapiClient({ apiKey: "zk_demo", fetch: fixtureFetch() });
await runAgent({ model: scriptedModel(), tools: createZillapiTools({ client }) });
