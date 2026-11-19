// Turns what the extension's content script finds on a page into session questions. No React, so the
// extension widget bundles it too.
import { classifySupport, guessFieldType, parseGoogleForm, type FieldType, type FormQuestion, type RawControl } from '@awaazform/core';

export interface ScanResult {
  platform: 'google' | 'microsoft' | 'other';
  title: string;
  url: string;
  formId?: string;
  items?: unknown[];
  /** Google's own “collect email” field is on the page. */
  collectEmail?: boolean;
  questions?: { key: string; label: string; required: boolean; control: string; options?: string[] }[];
}

const isYesNo = (o: string[]) => o.length === 2 && /^(yes|हाँ|हां|हो)$/i.test(o[0]!) && /^(no|नहीं|नाही)$/i.test(o[1]!);

export function toQuestions(r: ScanResult): FormQuestion[] {
  if (r.platform === 'google' && (r.items?.length || r.collectEmail)) {
    const settings = [null, null, null, null, null, null, r.collectEmail ? 3 : 1];
    return parseGoogleForm([null, [null, r.items ?? [], null, null, null, null, null, null, r.title, null, settings]], r.formId || 'page').questions;
  }
  return (r.questions ?? []).map((x) => {
    const control: Record<string, FieldType | RawControl> = {
      radio: x.options && isYesNo(x.options) ? 'yesno' : 'choice', checkbox: 'checkbox', select: 'dropdown', date: 'date', time: 'time',
      textarea: 'paragraph', number: 'number', email: 'email', tel: 'phone', yesno: 'yesno', unknown: 'unknown',
    };
    const c = (control[x.control] ?? guessFieldType(x.label)) as RawControl;
    const { support, reason } = classifySupport(x.label, c);
    const type: FieldType = c === 'unknown' || c === 'file' || c === 'password' || c === 'grid' || c === 'checkbox-grid' || c === 'signature' ? 'text' : c;
    return {
      id: `e-${x.key}`, label: x.label.slice(0, 200), type, required: x.required, options: x.options?.length ? x.options : undefined,
      support: c === 'unknown' ? 'unsupported' : support, supportReason: c === 'unknown' ? 'Answer this one on the page itself' : reason,
      source: { kind: 'dom', url: r.url, key: x.key, platform: r.platform },
    };
  });
}

/** The form's address without query or hash, to recognise the same form across pages and reloads. */
export const formKey = (url: string) => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return url; } };
