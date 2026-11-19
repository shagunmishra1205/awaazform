import type { Language } from '@awaazform/core';
import { en, type Strings } from './en';

type Deep = { [k: string]: unknown };
/** Deep-merges a (possibly partial) translation over English, so missing keys show in English. */
function merge(base: Deep, over: Deep | undefined): Deep {
  if (!over) return base;
  const out: Deep = { ...base };
  for (const [k, v] of Object.entries(base)) {
    const o = over[k];
    if (o === undefined || o === null) continue;
    if (Array.isArray(v)) out[k] = Array.isArray(o) && o.length === v.length ? o : v;
    else if (typeof v === 'object') out[k] = merge(v as Deep, o as Deep);
    else if (typeof o === 'string' && o.trim()) out[k] = o;
  }
  // msgs is keyed by English text and may hold more keys than the source; keep them.
  if (base === (en as unknown as Deep).msgs) Object.assign(out, over);
  return out;
}

const cache: Partial<Record<Language, Strings>> = { en };

/** Loads a language's strings (a separate chunk per language), falling back to English. */
export async function loadStrings(lang: Language): Promise<Strings> {
  if (cache[lang]) return cache[lang]!;
  try {
    const mod = (await import(`./locales/${lang}.json`)) as { default: Deep };
    const merged = merge(en as unknown as Deep, mod.default) as unknown as Strings;
    merged.msgs = { ...en.msgs, ...((mod.default.msgs as Record<string, string>) ?? {}) };
    cache[lang] = merged;
    return merged;
  } catch {
    return en;
  }
}
