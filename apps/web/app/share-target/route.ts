// An installed app's service worker handles this POST locally, including offline.
// If it is unavailable, do not read, persist or process an uploaded document on the server.
export function POST(request: Request) {
  return Response.redirect(new URL('/share?error=unavailable', request.url), 303);
}
