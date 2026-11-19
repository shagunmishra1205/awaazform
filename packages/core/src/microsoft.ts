// Microsoft Forms by link: read a public form's questions from its runtime API, and hand answers back
// as a pre-filled link (ResponsePage.aspx?id=<form>&r<question>=<value>). The user submits on Microsoft.
import { splitOptions } from './google';
import { classifySupport, type RawControl } from './safety';
import type { FieldType, FormQuestion, Session } from './types';

/** Hosts that serve public Microsoft Forms responder pages and their runtime API. */
export const MS_FORM_HOSTS = ['forms.office.com', 'forms.microsoft.com', 'forms.cloud.microsoft'];

export type MicrosoftFormLink =
  | { kind: 'form'; formId: string; host: string }
  | { kind: 'short'; url: string }
  | { kind: 'edit' };

/** Finds a Microsoft Forms link in pasted text: responder (ResponsePage.aspx?id=…), short (/r/… or /e/…), or editor. */
export function parseMicrosoftFormUrl(input: string): MicrosoftFormLink | null {
  const found = input.trim().match(/(?:https?:\/\/)?(?:forms\.office\.com|forms\.microsoft\.com|forms\.cloud\.microsoft)\/[^\s<>"'`]+/i);
  if (!found) return null;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(found[0]) ? found[0].replace(/^http:/i, 'https:') : `https://${found[0]}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !MS_FORM_HOSTS.includes(host)) return null;
  const path = u.pathname.toLowerCase();
  if (/^\/(r|e)\/[\w-]+\/?$/.test(path)) return { kind: 'short', url: `https://${host}${u.pathname.replace(/\/$/, '')}` };
  if (/designpage|\/pages\/analysis|\/pages\/design/.test(path)) return { kind: 'edit' };
  const id = u.searchParams.get('id');
  if (/^\/(pages\/)?responsepage\.aspx$/.test(path) && id && /^[\w-]{20,200}$/.test(id)) return { kind: 'form', formId: id, host };
  return null;
}

export const microsoftFormUrl = (formId: string, host = 'forms.office.com') =>
  `https://${MS_FORM_HOSTS.includes(host) ? host : 'forms.office.com'}/Pages/ResponsePage.aspx?id=${encodeURIComponent(formId)}`;

/** The runtime API address a responder page asks for (`prefetchFormUrl`), if it points at an allowed host. */
export function extractMicrosoftApiUrl(html: string): string | null {
  const m = html.match(/"prefetchFormUrl"\s*:\s*"([^"]+)"/);
  if (!m) return null;
  let raw: string;
  try {
    raw = JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return null;
  }
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || !MS_FORM_HOSTS.includes(u.hostname) || !u.pathname.startsWith('/formapi/api/')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

interface MsChoice { Description?: string }
interface MsQuestion {
  id?: string;
  title?: string;
  subtitle?: string | null;
  type?: string;
  required?: boolean;
  order?: number;
  questionInfo?: string | null;
}
export interface MicrosoftFormJson {
  id?: string;
  title?: string;
  description?: string;
  questions?: MsQuestion[];
  settings?: string;
}

export interface MicrosoftForm {
  title: string;
  description: string;
  questions: FormQuestion[];
}

const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '');
const isYesNo = (o: string[]) => o.length === 2 && /^(yes|हाँ|हां|हो)$/i.test(o[0]!) && /^(no|नहीं|नाही)$/i.test(o[1]!);

export function parseMicrosoftForm(json: MicrosoftFormJson, formId: string, host?: string): MicrosoftForm {
  const url = microsoftFormUrl(formId, host);
  let prefill = false;
  try {
    prefill = (JSON.parse(json.settings ?? '{}') as { AllowPrefill?: boolean }).AllowPrefill === true;
  } catch { /* no settings: no pre-filled links */ }
  const questions: FormQuestion[] = [];
  const sorted = [...(json.questions ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const raw of sorted) {
    const questionId = clean(raw.id);
    if (!/^r[0-9a-f]{32}$/i.test(questionId)) continue;
    let info: Record<string, unknown> = {};
    try {
      info = JSON.parse(raw.questionInfo ?? '{}') as Record<string, unknown>;
    } catch { /* treat as no extra info */ }
    const label = clean(raw.title) || 'Untitled question';
    const helpText = clean(raw.subtitle) || undefined;
    const required = raw.required === true;
    const id = `m${questionId.slice(1)}`;
    const source = { kind: 'ms-form', url, formId, questionId, prefill } as const;
    const options = Array.isArray(info.Choices) ? (info.Choices as MsChoice[]).map((c) => clean(c.Description)).filter(Boolean) : [];

    const push = (control: RawControl, extra: Partial<FormQuestion> = {}) => {
      const { support, reason } = classifySupport(label, control);
      const type: FieldType = (['grid', 'checkbox-grid', 'file', 'signature', 'password', 'unknown'] as string[]).includes(control) ? 'text' : (control as FieldType);
      questions.push({ id, label, helpText, type, required, support, supportReason: reason, source, ...extra });
    };
    const manual = (reason: string) => questions.push({ id, label, helpText, type: 'text', required, support: 'unsupported', supportReason: reason, source });

    switch (raw.type) {
      case 'Question.TextField': {
        const l = label.length <= 60 ? label.toLowerCase() : '';
        // Restriction 1 = number in Microsoft's text field validation.
        if (info.Restriction === 1 || info.Restriction === '1') push('number');
        else if (info.Multiline === true) push('paragraph');
        else if (/e-?mail|ईमेल/.test(l)) push('email');
        else if (/phone|mobile|whatsapp|contact (no|number)|फ़ोन|फोन|मोबाइल/.test(l)) push('phone');
        else push('text');
        break;
      }
      case 'Question.Choice': {
        const multi = Number(info.ChoiceType) === 2;
        const other = info.AllowOtherAnswer === true ? { supportReason: 'Choose "Other" on the form itself if none of these fit' } : {};
        if (!options.length) manual('This question has no options AwaazForm can read');
        else if (multi) push('checkbox', { options, ...other });
        else if (String(info.OptionDisplayStyle).toLowerCase() === 'dropdown') push('dropdown', { options });
        else push(isYesNo(options) ? 'yesno' : 'choice', { options, ...other });
        break;
      }
      case 'Question.DateTime':
        info.Time === true ? manual('Answer this date and time on the form itself') : push('date');
        break;
      case 'Question.Rating': {
        const n = Number(info.Length) || 5;
        push('scale', { options: Array.from({ length: n }, (_, i) => String(i + 1)) });
        break;
      }
      case 'Question.NPS':
        push('scale', { options: Array.from({ length: 11 }, (_, i) => String(i)), helpText: [helpText, '0 = not at all likely, 10 = extremely likely'].filter(Boolean).join(' · ') });
        break;
      case 'Question.Upload': manual('File uploads must be done on the form itself'); break;
      case 'Question.Ranking': manual('Rank these on the form itself'); break;
      case 'Question.MatrixChoiceGroup':
      case 'Question.MatrixChoice': manual('Answer grid (Likert) questions on the form itself'); break;
      default: manual('AwaazForm does not recognise this question type');
    }
  }
  return { title: clean(json.title) || 'Microsoft Form', description: clean(json.description), questions };
}

/**
 * A pre-filled responder link carrying every verified answer, for forms whose owner allows pre-filled
 * links. Microsoft reads `r<questionId>=value`; multi-select answers go as a JSON array. Returns null
 * when the form doesn't allow pre-filling: the user copies answers across, or uses the extension.
 */
export function microsoftPrefillUrl(s: Session): string | null {
  const first = s.questions.find((q) => q.source.kind === 'ms-form');
  if (!first || first.source.kind !== 'ms-form' || !first.source.prefill) return null;
  const base = new URL(first.source.url);
  for (const q of s.questions) {
    const a = s.answers[q.id];
    if (q.source.kind !== 'ms-form' || a?.status !== 'verified' || !a.normalized) continue;
    const opts = q.options ?? [];
    const value = q.type === 'checkbox' || q.type === 'multichoice'
      ? JSON.stringify(splitOptions(a.normalized, opts))
      : a.normalized;
    base.searchParams.set(q.source.questionId, value);
  }
  return base.toString();
}
