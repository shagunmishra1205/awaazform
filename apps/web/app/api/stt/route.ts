import { LANGUAGES } from '@awaazform/core';
import { config, errorResponse, groqFetch } from '@/lib/groq';
import { rateLimit, tooMany } from '@/lib/rate-limit';
import { guard, preflight, withCors } from '@/lib/guard';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Speech-to-text. Audio is forwarded to Groq and never written to disk (§9.4).
async function handlePost(req: Request): Promise<Response> {
  if (!rateLimit(req, 'stt')) return tooMany();
  try {
    const len = Number(req.headers.get('content-length') ?? 0);
    if (len > config.maxAudioBytes + 10_000) return Response.json({ error: 'Recording is too long' }, { status: 413 });

    const form = await req.formData();
    const audio = form.get('audio');
    const language = form.get('language');
    if (!(audio instanceof Blob) || audio.size === 0) return Response.json({ error: 'No audio' }, { status: 400 });
    if (audio.size > config.maxAudioBytes) return Response.json({ error: 'Recording is too long' }, { status: 413 });

    const body = new FormData();
    body.set('file', audio, 'answer.webm');
    body.set('model', config.sttModel);
    // verbose_json gives per-segment confidence, so silence and noise can be dropped (see below).
    body.set('response_format', 'verbose_json');
    body.set('temperature', '0');
    if (typeof language === 'string' && (LANGUAGES as readonly string[]).includes(language)) body.set('language', language);
    // Context for Whisper: the question being answered (no personal data), capped well under its limit.
    const prompt = form.get('prompt');
    if (typeof prompt === 'string' && prompt.trim()) body.set('prompt', prompt.slice(0, 600));

    const res = await groqFetch('/audio/transcriptions', { method: 'POST', body });
    const json = (await res.json()) as { text?: string; segments?: Segment[] };
    return Response.json({ text: cleanTranscript(json) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Same-origin pages and the AwaazForm extension only (lib/guard.ts). */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.response;
  return withCors(await handlePost(req), g);
}

export const OPTIONS = preflight;

interface Segment { text?: string; no_speech_prob?: number; avg_logprob?: number; compression_ratio?: number }

// What Whisper "hears" in silence, breathing or room noise. Dropped when the whole clip is just this.
const HALLUCINATIONS = /^(thank you( for watching)?|thanks( for watching)?|bye|you|okay|subtitles? by .*|please subscribe.*|धन्यवाद|शुक्रिया|सब्सक्राइब.*|नमस्ते|ধন্যবাদ|நன்றி|ధన్యవాదాలు|ಧನ್ಯವಾದ|നന്ദി|ਧੰਨਵਾਦ|شکریہ)[.!। ]*$/iu;

/**
 * Live Mode sends whatever the room sounded like. Whisper turns silence into its language tag
 * (<|hi|>) or stock phrases, which then arrived as if the user had said them. Keep only segments it
 * is reasonably sure are speech, strip special tokens, and drop known silence phrases.
 */
function cleanTranscript(json: { text?: string; segments?: Segment[] }): string {
  const segs = json.segments?.length ? json.segments : null;
  const kept = segs
    ? segs.filter((s) => (s.no_speech_prob ?? 0) < 0.6 && (s.avg_logprob ?? 0) > -1.2 && (s.compression_ratio ?? 1) < 2.6).map((s) => s.text ?? '').join(' ')
    : json.text ?? '';
  const text = kept.replace(/<\|[^|>]{1,20}\|>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(text) || HALLUCINATIONS.test(text)) return '';
  return text;
}
