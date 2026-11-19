import { config, errorResponse, groqFetch } from '@/lib/groq';
import { rateLimit, tooMany } from '@/lib/rate-limit';
import { guard, preflight, withCors } from '@/lib/guard';

export const runtime = 'nodejs';

// Text-to-speech. If no TTS model is configured, the client falls back to speechSynthesis.
async function handlePost(req: Request): Promise<Response> {
  if (!rateLimit(req, 'tts', 60)) return tooMany();
  if (!config.ttsModel) return Response.json({ error: 'TTS not configured', fallback: 'speechSynthesis' }, { status: 501 });
  try {
    const { text } = (await req.json()) as { text?: unknown };
    if (typeof text !== 'string' || !text.trim()) return Response.json({ error: 'No text' }, { status: 400 });
    if (text.length > 600) return Response.json({ error: 'Text too long' }, { status: 413 });

    const res = await groqFetch('/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.ttsModel, voice: config.ttsVoice || undefined, input: text, response_format: 'wav' }),
    });
    return new Response(res.body, { headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' } });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Capability check, so clients don't have to probe with a failing POST. */
function handleGet(): Response {
  return Response.json({ available: !!config.ttsModel });
}

/** Same-origin pages and the AwaazForm extension only (lib/guard.ts). */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.response;
  return withCors(await handlePost(req), g);
}

export const OPTIONS = preflight;

export function GET(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.response;
  return withCors(handleGet(), g);
}
