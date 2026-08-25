import { chatCompletion as openrouterChatCompletion, type ChatMessage } from './openrouter.js';
import { groqChatCompletion } from './groqChat.js';

export type { ChatMessage };

export type LlmProvider = 'openrouter' | 'groq';

/**
 * Which provider the crew and conversation loop think through.
 *
 * Explicit `LLM_PROVIDER` wins. Otherwise it's inferred from which key is
 * present, preferring OpenRouter when both are set: OpenRouter has the wider
 * model selection *and* embeddings, so it's the better default whenever it's
 * funded. Groq is the free-tier path -- rate-limited but with no balance to
 * exhaust, which is what makes it the right fallback when OpenRouter runs dry.
 */
export function getProvider(): LlmProvider {
  const configured = process.env.LLM_PROVIDER?.toLowerCase();
  if (configured === 'groq' || configured === 'openrouter') return configured;

  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (process.env.GROQ_API_KEY) return 'groq';
  return 'openrouter';
}

/** The model id in play, for logging and for the audit trail. */
export function getModelId(): string {
  return (getProvider() === 'groq' ? process.env.GROQ_MODEL : process.env.OPENROUTER_MODEL) ?? 'unset';
}

export async function chatCompletion(messages: ChatMessage[]): Promise<string> {
  return getProvider() === 'groq'
    ? groqChatCompletion(messages)
    : openrouterChatCompletion(messages);
}

/**
 * Whether semantic memory is available at all.
 *
 * Groq serves no embeddings endpoint, so on that provider `embedText()` cannot
 * work and vector retrieval is simply off. Callers check this rather than
 * catching a failure per call, so the degraded path is a deliberate branch
 * instead of an exception handler that quietly swallows real errors too.
 */
export function isEmbeddingsAvailable(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}
