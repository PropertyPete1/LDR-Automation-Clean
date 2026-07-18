/**
 * llm.ts — Anthropic-direct LLM client.
 *
 * All agent-bot LLM calls hit https://api.anthropic.com/v1/messages with
 * model `claude-sonnet-4-6`, authenticated via ANTHROPIC_API_KEY. The
 * previous third-party LLM proxy is no longer used for LLM calls.
 *
 * The OpenAI-style interface (invokeLLM + choices[0].message.content) is
 * kept so existing callers (botEngineIntro) work unchanged. JSON response
 * formats are emulated with a strict system instruction + fence stripping.
 */
import { ENV } from "./env";

export const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 2048;

export type Role = "system" | "user" | "assistant";

export type TextContent = { type: "text"; text: string };
export type MessageContent = string | TextContent;

export type Message = {
  role: Role;
  content: MessageContent | MessageContent[];
};

export type JsonSchema = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JsonSchema };

export type InvokeParams = {
  messages: Message[];
  maxTokens?: number;
  max_tokens?: number;
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  outputSchema?: JsonSchema;
  output_schema?: JsonSchema;
  model?: string;
  temperature?: number;
};

export type InvokeResult = {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: Role; content: string };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

const contentToText = (content: MessageContent | MessageContent[]): string => {
  const parts = Array.isArray(content) ? content : [content];
  return parts.map(p => (typeof p === "string" ? p : p.text)).join("\n");
};

const assertApiKey = () => {
  if (!ENV.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
};

type AnthropicResponse = {
  id: string;
  model: string;
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string | null;
  usage?: { input_tokens: number; output_tokens: number };
};

/** Strip markdown code fences Claude sometimes wraps around JSON output. */
const stripCodeFences = (text: string): string => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .split("\n")
    .slice(1)
    .filter(l => l.trim() !== "```")
    .join("\n")
    .trim();
};

export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  assertApiKey();

  const {
    messages, maxTokens, max_tokens, responseFormat, response_format,
    outputSchema, output_schema, model, temperature,
  } = params;

  // Anthropic takes the system prompt as a top-level param, not a message.
  let systemText = "";
  const chatMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of messages) {
    const text = contentToText(m.content);
    if (m.role === "system") {
      systemText = systemText ? `${systemText}\n\n${text}` : text;
    } else {
      chatMessages.push({ role: m.role === "assistant" ? "assistant" : "user", content: text });
    }
  }
  if (chatMessages.length === 0) chatMessages.push({ role: "user", content: "Please respond." });

  // Emulate OpenAI-style JSON response formats with a strict instruction.
  const format = responseFormat ?? response_format;
  const schema = outputSchema ?? output_schema ??
    (format && format.type === "json_schema" ? format.json_schema : undefined);
  const wantsJson = !!schema || (format ? format.type !== "text" : false);
  if (schema) {
    systemText += `${systemText ? "\n\n" : ""}Respond ONLY with valid JSON matching this schema (no prose, no code fences):\n${JSON.stringify(schema.schema)}`;
  } else if (wantsJson) {
    systemText += `${systemText ? "\n\n" : ""}Respond ONLY with a valid JSON object (no prose, no code fences).`;
  }

  const payload: Record<string, unknown> = {
    model: model ?? ANTHROPIC_MODEL,
    max_tokens: max_tokens ?? maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: chatMessages,
  };
  if (systemText) payload.system = systemText;
  if (typeof temperature === "number") payload.temperature = temperature;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ENV.anthropicApiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `LLM invoke failed: ${response.status} ${response.statusText} – ${errorText}`
    );
  }

  const data = (await response.json()) as AnthropicResponse;
  const rawText = (data.content ?? [])
    .filter(b => b.type === "text" && typeof b.text === "string")
    .map(b => b.text as string)
    .join("");
  const text = wantsJson ? stripCodeFences(rawText) : rawText;

  return {
    id: data.id,
    created: Math.floor(Date.now() / 1000),
    model: data.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: data.stop_reason ?? null,
      },
    ],
    usage: data.usage
      ? {
          prompt_tokens: data.usage.input_tokens,
          completion_tokens: data.usage.output_tokens,
          total_tokens: data.usage.input_tokens + data.usage.output_tokens,
        }
      : undefined,
  };
}
