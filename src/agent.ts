/**
 * Runs a Vercel AI SDK agent with ZillAPI tools and streams the answer to stdout.
 *
 *   npm start -- "Find 3-bed homes for sale in Austin under $500k and give me their Zestimates"
 */
import { isStepCount, streamText, type LanguageModel } from "ai";
import { createZillapiTools, type ZillapiTools } from "./tools";

export const SYSTEM_PROMPT = `You are a real estate research assistant with live Zillow property data via ZillAPI tools.
- Listing search needs a bounding box. Estimate the bbox for the city or neighborhood the user names.
- Keep searches small (maxItems 3 to 5) because every row costs a credit.
- If a search row has no Zestimate, call getZestimate with its zpid.
- Answer with a short table: address, list price, beds/baths, sqft, Zestimate, and the Zillow link.
- Never invent numbers. If a tool returns an error, say so.`;

export const DEFAULT_PROMPT = "Find 3-bed homes for sale in Austin, TX under $500k and give me their Zestimates. Show 3.";

export async function runAgent({
  model,
  prompt = DEFAULT_PROMPT,
  tools = createZillapiTools(),
  write = (s: string) => process.stdout.write(s),
}: {
  model: LanguageModel;
  prompt?: string;
  tools?: ZillapiTools;
  write?: (s: string) => void;
}) {
  const result = streamText({
    model,
    system: SYSTEM_PROMPT,
    prompt,
    tools,
    stopWhen: isStepCount(8),
  });

  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta":
        write(part.text);
        break;
      case "tool-call":
        write(`\n[tool] ${part.toolName}(${JSON.stringify(part.input)})\n`);
        break;
      case "tool-result":
        write(`[tool] ${part.toolName} -> ${summarize(part.output)}\n\n`);
        break;
      case "error":
        write(`\n[error] ${String(part.error)}\n`);
        break;
    }
  }
  write("\n");
  return result;
}

function summarize(output: unknown): string {
  const s = JSON.stringify(output);
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const { openai } = await import("@ai-sdk/openai");
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY (or swap in any AI SDK provider in src/agent.ts).");
    process.exit(1);
  }
  const prompt = process.argv.slice(2).join(" ") || DEFAULT_PROMPT;
  await runAgent({ model: openai(process.env.OPENAI_MODEL ?? "gpt-5.4-mini"), prompt });
}
