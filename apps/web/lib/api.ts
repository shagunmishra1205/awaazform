// Where the AwaazForm API lives. Empty on the website (same origin); the browser extension sets it to the
// server the user chose, so the same assistant and voice code runs in both.
let base = '';

export function setApiBase(url: string) {
  base = url.replace(/\/+$/, '');
}

export const apiUrl = (path: string) => `${base}${path}`;
