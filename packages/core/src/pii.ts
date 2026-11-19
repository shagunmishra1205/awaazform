// Privacy shield: before text goes to the AI, identifiers it doesn't need to read are swapped for
// placeholders (⟦EMAIL_1⟧, ⟦PHONE_1⟧ …). The model copies placeholders into tool calls; they are
// restored in the browser before anything is validated or filled. Names are left as they are, because
// the model needs to write them in English letters.

const RULES: [string, RegExp][] = [
  ['EMAIL', /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu],
  ['PAN', /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g],
  ['AADHAAR', /\b[2-9][0-9]{3}[\s-]?[0-9]{4}[\s-]?[0-9]{4}\b/g],
  ['PHONE', /(?:\+?\d{1,3}[\s-]?)?(?:\d[\s-]?){9}\d\b/g],
  ['NUMBER', /\b\d{6,}\b/g],
];

export interface Shield {
  /** Text with identifiers replaced. */
  hide(text: string): string;
  /** Puts the real values back (in tool arguments and replies). */
  reveal(text: string): string;
  /** How many values are being held back. */
  readonly size: number;
}

export function createShield(): Shield {
  const byValue = new Map<string, string>();
  const byToken = new Map<string, string>();
  const counts: Record<string, number> = {};
  return {
    hide(text) {
      let out = text;
      for (const [kind, re] of RULES) {
        out = out.replace(re, (m) => {
          const v = m.trim();
          let token = byValue.get(v);
          if (!token) {
            counts[kind] = (counts[kind] ?? 0) + 1;
            token = `⟦${kind}_${counts[kind]}⟧`;
            byValue.set(v, token);
            byToken.set(token, v);
          }
          return m.replace(v, token);
        });
      }
      return out;
    },
    reveal(text) {
      return text.replace(/⟦[A-Z]+_\d+⟧/g, (tk) => byToken.get(tk) ?? tk);
    },
    get size() {
      return byToken.size;
    },
  };
}
