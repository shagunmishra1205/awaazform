import 'server-only';

// Who may call the API. Same-origin pages and the AwaazForm extension only, so other websites can't spend
// our AI quota or post data through it. Set AWAAZ_EXTENSION_IDS (comma-separated) in production to pin
// the extension's ID; without it, any browser extension origin is accepted (handy in development).

const EXT = /^(chrome|moz)-extension:\/\/([a-z0-9-]+)$/i;

function allowedExtension(origin: string): boolean {
  const m = origin.match(EXT);
  if (!m) return false;
  const ids = (process.env.AWAAZ_EXTENSION_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length === 0 || ids.includes(m[2]!);
}

export type Guard = { ok: true; headers: Record<string, string> } | { ok: false; response: Response };

export function guard(req: Request): Guard {
  const origin = req.headers.get('origin');
  const site = req.headers.get('sec-fetch-site');
  const self = new URL(req.url).origin;
  if (!origin || origin === self || site === 'same-origin') return { ok: true, headers: {} };
  if (allowedExtension(origin)) {
    return { ok: true, headers: { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } };
  }
  return { ok: false, response: Response.json({ error: 'Not allowed from this site' }, { status: 403 }) };
}

/** CORS preflight for the extension. */
export function preflight(req: Request): Response {
  const g = guard(req);
  if (!g.ok) return g.response;
  return new Response(null, {
    status: 204,
    headers: { ...g.headers, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' },
  });
}

/** Adds the CORS headers a guarded request needs to its response. */
export function withCors(res: Response, g: Guard): Response {
  if (!g.ok) return g.response;
  for (const [k, v] of Object.entries(g.headers)) res.headers.set(k, v);
  return res;
}
