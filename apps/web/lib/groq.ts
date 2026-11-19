import 'server-only';

// Server-only Groq client (D4). Uses the OpenAI-compatible REST API directly — no SDK needed.
const BASE = 'https://api.groq.com/openai/v1';

export const config = {
  key: process.env.GROQ_API_KEY ?? '',
  sttModel: process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo',
  chatModel: process.env.GROQ_CHAT_MODEL ?? '',
  /** Used when the chat model hits a rate limit (per-minute or per-day). Must support tool calls. */
  chatFallback: process.env.GROQ_CHAT_FALLBACK ?? 'openai/gpt-oss-20b',
  ttsModel: process.env.GROQ_TTS_MODEL ?? '',
  ttsVoice: process.env.GROQ_TTS_VOICE ?? '',
  maxAudioBytes: Number(process.env.MAX_AUDIO_BYTES) || 2_000_000,
  maxChatChars: Number(process.env.MAX_CHAT_INPUT_CHARS) || 2000,
};

export class GroqError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/** One retry on 429/5xx (PRD §7 reliability), then surface the error. */
export async function groqFetch(path: string, init: RequestInit): Promise<Response> {
  if (!config.key) throw new GroqError('AI is not configured on this server', 503);
  const send = () =>
    fetch(`${BASE}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${config.key}` } });

  let res = await send();
  if (res.status === 429 || res.status >= 500) {
    // Honour Groq's retry-after (capped), so per-minute token limits recover instead of failing.
    const after = Number(res.headers.get('retry-after'));
    const wait = res.status === 429 && after > 0 ? Math.min(after * 1000, 10_000) : 800;
    await new Promise((r) => setTimeout(r, wait));
    res = await send();
  }
  if (!res.ok) {
    // Never echo request bodies; only the status reaches logs and clients.
    const status = res.status === 429 ? 429 : res.status >= 500 ? 502 : res.status;
    throw new GroqError(res.status === 429 ? 'AI is busy (rate limit)' : `AI request failed (${res.status})`, status);
  }
  return res;
}

export function errorResponse(err: unknown): Response {
  // Tell clients when to try again after a rate limit (the PDF reader waits and retries one page).
  if (err instanceof GroqError && err.status === 429) {
    return Response.json({ error: err.message, fallback: 'typing' }, { status: 429, headers: { 'Retry-After': '8' } });
  }
  // Unexpected errors: log the message only (never request bodies, which can hold personal data).
  if (!(err instanceof GroqError)) console.error('[api] unexpected error:', (err as Error)?.message ?? String(err));
  const status = err instanceof GroqError ? err.status : 500;
  const message = err instanceof GroqError ? err.message : 'Something went wrong';
  return Response.json({ error: message, fallback: 'typing' }, { status });
}

/**
 * A chat completion on the configured model, retried once on the fallback model if the main one is
 * rate-limited (free tiers cap tokens per minute and per day). `body` builds the request for a model.
 */
export async function chatCompletion(body: (model: string) => Record<string, unknown>): Promise<Response> {
  const send = (model: string) => groqFetch('/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body(model)) });
  try {
    return await send(config.chatModel);
  } catch (err) {
    if (!(err instanceof GroqError) || err.status !== 429 || !config.chatFallback || config.chatFallback === config.chatModel) throw err;
    return send(config.chatFallback);
  }
}
