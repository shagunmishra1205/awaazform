import { canonicalFormId, extractGoogleFormData, googleFormUrl, parseGoogleForm, parseGoogleFormUrl } from '@awaazform/core';
import { z } from 'zod';
import { rateLimit, tooMany } from '@/lib/rate-limit';
import { guard, preflight, withCors } from '@/lib/guard';

export const runtime = 'nodejs';

// Reads a public Google Form's questions from its responder page. Only the form itself is fetched,
// never anything about the user. Hosts are allow-listed and each redirect hop is checked (no SSRF).

const Input = z.object({ url: z.string().min(10).max(2000) });
const MAX_BYTES = 4_000_000;
const fail = (error: string, status = 400) => Response.json({ error }, { status });

async function get(url: string) {
  return fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AwaazForm/1.0)', 'Accept-Language': 'en' },
  });
}

async function readCapped(res: Response): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handlePost(req: Request): Promise<Response> {
  if (!rateLimit(req, 'gform', 20)) return tooMany();
  const parsed = Input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail('Please paste a Google Form link.');

  const link = parseGoogleFormUrl(parsed.data.url);
  if (!link) return fail('This doesn’t look like a Google Form link. It should start with docs.google.com/forms or forms.gle.');
  try {
    // Follow redirects one hop at a time, only between Google Forms hosts (forms.gle → docs.google.com …).
    let url = link.kind === 'short' ? link.url : googleFormUrl(link.kind === 'form' ? link.formId : `d/${link.docId}`);
    let res: Response | null = null;
    for (let hop = 0; hop < 5; hop++) {
      res = await get(url);
      if (res.status < 300 || res.status >= 400) break;
      const to = new URL(res.headers.get('location') ?? '', url);
      if (/^accounts\.google\.com$/.test(to.hostname) || /ServiceLogin/.test(to.pathname)) {
        return fail(link.kind === 'doc' && link.edit
          ? 'This is the form’s editing link. Use the link you’d send to people who fill it in (Send → link).'
          : 'This form needs a Google sign-in, so AwaazForm can’t read it. Fill it on Google Forms directly.', 422);
      }
      if (to.protocol !== 'https:' || !['docs.google.com', 'forms.gle'].includes(to.hostname)) return fail('Google redirected this form somewhere unexpected.', 422);
      url = to.toString();
      res = null;
    }
    if (!res) return fail('Google redirected this form too many times.', 422);
    if (res.status === 404) return fail('No form was found at this link. Check that it’s complete.', 404);
    if (!res.ok) return fail(`Google Forms returned an error (${res.status}). Try again in a moment.`, 502);

    const html = await readCapped(res);
    if (html === null) return fail('This form is too large to read.', 413);
    const data = extractGoogleFormData(html);
    if (!data) {
      if (/no longer accepting responses|closedform/i.test(html)) return fail('This form is no longer accepting responses.', 422);
      return fail('AwaazForm couldn’t read the questions on this form.', 422);
    }
    const final = parseGoogleFormUrl(url);
    const formId = canonicalFormId(data) ?? (final?.kind === 'form' ? final.formId : final?.kind === 'doc' ? `d/${final.docId}` : null);
    if (!formId) return fail('AwaazForm couldn’t work out this form’s address.', 422);
    const form = parseGoogleForm(data, formId);
    if (form.questions.length === 0) return fail('This form has no questions to fill.', 422);
    return Response.json({ formId, ...form });
  } catch (err) {
    const timeout = (err as Error).name === 'TimeoutError';
    return fail(timeout ? 'Google Forms took too long to respond. Try again.' : 'AwaazForm couldn’t reach Google Forms. Try again.', 502);
  }
}

/** Same-origin pages and the AwaazForm extension only (lib/guard.ts). */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.response;
  return withCors(await handlePost(req), g);
}

export const OPTIONS = preflight;
