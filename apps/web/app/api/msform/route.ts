import { extractMicrosoftApiUrl, MS_FORM_HOSTS, parseMicrosoftForm, parseMicrosoftFormUrl, type MicrosoftFormJson } from '@awaazform/core';
import { z } from 'zod';
import { rateLimit, tooMany } from '@/lib/rate-limit';
import { guard, preflight, withCors } from '@/lib/guard';

export const runtime = 'nodejs';

// Reads a public Microsoft Form's questions. Only the form is fetched, never anything about the user.
// Hosts are allow-listed and each redirect hop is checked (no SSRF).

const Input = z.object({ url: z.string().min(10).max(2000) });
const MAX_BYTES = 4_000_000;
const fail = (error: string, status = 400) => Response.json({ error }, { status });

const get = (url: string, json = false) =>
  fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AwaazForm/1.0)', 'Accept-Language': 'en', ...(json ? { Accept: 'application/json' } : {}) },
  });

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

const signIn = (u: URL) => /login\.microsoftonline\.com|login\.live\.com|login\.microsoft\.com/.test(u.hostname);

async function handlePost(req: Request): Promise<Response> {
  if (!rateLimit(req, 'msform', 20)) return tooMany();
  const parsed = Input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail('Please paste a Microsoft Forms link.');
  const link = parseMicrosoftFormUrl(parsed.data.url);
  if (!link) return fail('This doesn’t look like a Microsoft Forms link. It should start with forms.office.com or forms.microsoft.com.');
  if (link.kind === 'edit') return fail('This is the form’s editing link. Use the link you’d send to people who fill it in (Collect responses → Copy link).');

  try {
    let url = link.kind === 'short' ? link.url : `https://${link.host}/Pages/ResponsePage.aspx?id=${encodeURIComponent(link.formId)}`;
    let res: Response | null = null;
    for (let hop = 0; hop < 5; hop++) {
      res = await get(url);
      if (res.status < 300 || res.status >= 400) break;
      const to = new URL(res.headers.get('location') ?? '', url);
      if (signIn(to)) return fail('This form only accepts people signed in to an organisation, so AwaazForm can’t read it. Fill it on Microsoft Forms directly.', 422);
      if (to.protocol !== 'https:' || !MS_FORM_HOSTS.includes(to.hostname)) return fail('Microsoft redirected this form somewhere unexpected.', 422);
      url = to.toString();
      res = null;
    }
    if (!res) return fail('Microsoft redirected this form too many times.', 422);
    if (!res.ok) return fail(res.status === 404 ? 'No form was found at this link. Check that it’s complete.' : `Microsoft Forms returned an error (${res.status}).`, res.status === 404 ? 404 : 502);

    const final = parseMicrosoftFormUrl(url);
    if (final?.kind !== 'form') return fail('AwaazForm couldn’t work out this form’s address.', 422);
    const html = await readCapped(res);
    if (html === null) return fail('This form is too large to read.', 413);
    const api = extractMicrosoftApiUrl(html);
    if (!api) return fail('AwaazForm couldn’t read the questions on this form. It may need a sign-in.', 422);

    const apiRes = await get(api, true);
    if (apiRes.status === 401 || apiRes.status === 403) return fail('This form only accepts people signed in to an organisation, so AwaazForm can’t read it.', 422);
    if (!apiRes.ok) return fail(`Microsoft Forms returned an error (${apiRes.status}). Try again in a moment.`, 502);
    const body = await readCapped(apiRes);
    if (body === null) return fail('This form is too large to read.', 413);
    const json = JSON.parse(body) as MicrosoftFormJson & { status?: string };
    if (json.status && json.status !== 'Active') return fail('This form is no longer accepting responses.', 422);
    const form = parseMicrosoftForm(json, final.formId, final.host);
    if (form.questions.length === 0) return fail('This form has no questions to fill.', 422);
    return Response.json({ formId: final.formId, platform: 'microsoft', ...form });
  } catch (err) {
    const timeout = (err as Error).name === 'TimeoutError';
    return fail(timeout ? 'Microsoft Forms took too long to respond. Try again.' : 'AwaazForm couldn’t reach Microsoft Forms. Try again.', 502);
  }
}

/** Same-origin pages and the AwaazForm extension only (lib/guard.ts). */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.response;
  return withCors(await handlePost(req), g);
}

export const OPTIONS = preflight;
