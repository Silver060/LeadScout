import Anthropic from "@anthropic-ai/sdk";
import { withRetry } from "./retry.js";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

// Override in .env with MODEL_QUALITY / MODEL_TRIAGE if you want different models.
export const MODELS = {
  triage: process.env.MODEL_TRIAGE || "claude-haiku-4-5-20251001",
  quality: process.env.MODEL_QUALITY || "claude-sonnet-5",
};

// Ask Claude for JSON; parses the first JSON block in the reply.
export async function askJSON(model, system, user, maxTokens = 3000) {
  return withRetry(async () => {
    const msg = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = msg.content.map((b) => b.text || "").join("");
    const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) throw new Error("No JSON in model reply");
    return JSON.parse(match[0]);
  }, { label: `claude:${model}` });
}
