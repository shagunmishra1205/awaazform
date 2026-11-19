# AwaazForm on Android

Use Chrome or Edge over HTTPS (localhost also works for development). The bottom invitation on Home and Settings opens the browser's native installer when available. Otherwise it explains the browser menu action. Dismissing it hides the invitation for seven days; Settings always offers installation help. Installed windows and embedded panels do not show the invitation. The banner reserves its height, respects safe areas, and supports large text, high contrast and RTL.

## Included

- Stable app identity, standalone window, Android splash metadata and launcher icons.
- Separate 192px/512px regular and full-bleed maskable icons, plus an Apple touch icon. Regenerate from the existing SVG with `pnpm --filter web icons`.
- Launcher shortcuts for online forms, documents and profiles.
- Offline app pages, scripts, fonts and PDF worker. Existing encrypted document sessions and profiles remain local; session retention is still 24 hours.
- Android share target for one PDF or DOCX (up to 10 MB), or a Google/Microsoft Forms link. Shared items require confirmation before opening. Links are placed in the input for review before scanning.
- Shared payloads are intercepted by the service worker, encrypted in IndexedDB using non-extractable AES-GCM keys, and never uploaded by this handler. Pending shares expire after one hour and are removed on access/worker activation; the inbox is bounded. Opening or cancelling deletes the pending share. Forget-all also deletes the inbox.
- Native file sharing of completed documents where supported, with the existing Download action as fallback. Prepare the latest export, then tap Share file to open the device's share sheet.
- Screen wake lock while recording or using Live Mode, released when finished. Battery and browser policy can decline the request.
- Updates download in the background and wait. Home/Settings offers Reload to update; active forms are never automatically reloaded. One previous cache is retained for other tabs.
- Offline status and an offline fallback page for uncached routes. The browser can reclaim storage; persistence is requested on installation as a best effort.

Voice transcription, AI, translation requests and fetching new online forms need internet. This does not queue or replay form/API requests. Installed apps have the same browser permissions and safety rules as the website. The bottom install invitation does not require notification permission; no remote push service is configured. New PWA copy uses the existing locale system and its English fallback for untranslated keys.

## Build and test

```sh
pnpm --filter web build
pnpm --filter web start
BROWSER_CHANNEL= pnpm --filter web test:pwa
```

The build runs `scripts/build-pwa.mjs` after Next finishes. It creates ignored `public/sw.js` with a unique build version and the exact generated JS/CSS/font paths. Deploy using this package's build script, not a bare `next build`. Service workers are only registered in production so development assets are never cached. Do not commit generated `sw.js`.

The browser test checks install events, dismissal, fallback help, manifest/icon sizes, offline reload/resume, share validation and encryption, cache privacy, narrow layouts and axe accessibility. Screenshots go to `/tmp/awaazform-pwa/`.

On a physical Android device, verify the OS-specific parts: install from HTTPS, launch from the icon, inspect the splash and long-press shortcuts, share a PDF/Word file from Files and a form link from Chrome, export to another app, and relaunch with airplane mode enabled. Browser automation simulates install events; it cannot install an Android WebAPK or verify an OEM launcher.

## Implementation references

Follows [Next.js's PWA integration](https://nextjs.org/docs/app/guides/progressive-web-apps) and [Chrome's Web Share Target](https://developer.chrome.com/docs/capabilities/web-apis/web-share-target) model. API responses, RSC payloads, document bytes, shared query strings and external requests are excluded from Cache Storage. Only public build resources and allow-listed app shells are precached.
