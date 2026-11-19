# AwaazForm browser extension

Bolu, AwaazForm's robot, sits in the corner of the form you're on. Talk to him (or type, or tap an option), check each answer he reads back, and he types your confirmed answers into the real form. Google Forms, Microsoft Forms and ordinary web forms, in English and 12 Indian languages. It never presses Submit and never fills password fields.

## Install

Download it from the website's **Extension** page (`/extension`), or build it yourself:

```bash
pnpm install
node apps/extension/build.mjs            # → apps/extension/dist and apps/web/public/downloads/awaazform-extension.zip
AWAAZ_SERVER=https://your-site node apps/extension/build.mjs   # the server the widget talks to by default
```

Then open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, choose **Load unpacked**, and pick the `awaazform-extension` folder (or `apps/extension/dist`). The web app's `prebuild` runs this build, so the website always offers the matching zip.

## How it works

- `content.js` runs on Google and Microsoft Forms (and on other sites when you click the toolbar button and allow that site). It shows Bolu in a **closed shadow root** and reads and fills fields. Google questions come from each item's `data-params`, which the shared Google parser in `packages/core` reads; Microsoft and other pages are read from the DOM.
- `widget.html` + `src/widget.ts` (bundled to `widget.js`) is the widget: Bolu's animated face, language picker, timer, mute, Start/End, transcript and typing. It runs the same session loop as the website (`packages/core` plus `apps/web/lib/{assistant,live,voice,bolu,page-questions}`): every answer is read back, and only the Yes button or a spoken “yes” (matched in code, in any supported language) fills it.
- `background.js` relays between the widget and the page using the extension's own messaging, so the page's scripts can neither read nor fake those messages.
- Answers live in `chrome.storage.session` (memory only, cleared when the browser closes). The privacy shield hides emails, phone and ID numbers from the AI.
- The server (`/api/chat`, `/api/stt`, `/api/tts`) accepts extension origins; set `AWAAZ_EXTENSION_IDS` on the server to allow only your published extension ID.

## Microphone

Extension frames on web pages can't always show the microphone prompt themselves. The first time, open the widget's settings (⚙) and choose **Allow microphone**; a tab opens where you press Allow once. Typing and tapping work without it.

## Tests

- `pnpm --filter web exec node e2e/extension-content.e2e.mjs`: the content script on a live Google Form, a live Microsoft Form and a plain HTML form.
- `pnpm --filter web test:extension`: loads the built extension in Chromium, opens a live Google Form, fills one answer through Bolu and checks it landed (needs Playwright's full Chromium and a running server).
