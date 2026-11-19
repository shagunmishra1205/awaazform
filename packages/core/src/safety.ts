// Responsible-AI rules enforced in code — PRD §9.1 and §9.3.
import type { CanonicalKey, FieldType, FormQuestion, SupportStatus } from './types';

/** Labels for fields AwaazForm must never fill (passwords, payments, auth). */
const NEVER_FILL = [
  /pass\s?word|passcode|\bpin\b(?! ?code)|\botp\b|one[- ]time|captcha|verification code|security code/i,
  /card number|credit card|debit card|\bcvv\b|\bcvc\b|expiry|upi\s?(pin|id)|net\s?banking/i,
  /पासवर्ड|पिन(?! ?कोड)|ओटीपी/,
];

/** Labels for data AwaazForm must never save to a profile (§9.3). */
const NEVER_SAVE = [
  ...NEVER_FILL,
  /bank account|account (no|number)|ifsc/i,
  /aadha+r|\bpan\b|pan card|passport|driving licen[cs]e|\bdl\b|voter\s?id|epic no|ssn|social security|national id/i,
  /health|medical|diagnos|disease|disabilit|blood group|medication|allerg/i,
  /religio|caste|sexual|orientation|political|party affiliation|immigration|visa status|citizenship status/i,
  /आधार|पैन|पासपोर्ट|धर्म|जाति|बीमारी|स्वास्थ्य|खाता संख्या/,
];

/** Submit-like controls the filler must never touch (§9.1). */
export const SUBMIT_TEXT = /^(submit|send|done|finish|प्रस्तुत करें|जमा करें|सबमिट करें?)$/i;

export function isNeverFill(label: string): boolean {
  return NEVER_FILL.some((r) => r.test(label));
}

export function isSensitive(label: string): boolean {
  return NEVER_SAVE.some((r) => r.test(label));
}

/** Raw control kinds a scanner may report, before mapping to FieldType. */
export type RawControl =
  | FieldType | 'grid' | 'checkbox-grid' | 'file' | 'signature' | 'password' | 'unknown';

/** Support classification (FR-02 – FR-04). */
export function classifySupport(label: string, control: RawControl): { support: SupportStatus; reason?: string } {
  if (control === 'password' || isNeverFill(label)) {
    return { support: 'unsupported', reason: 'Passwords, payments, OTPs and verification codes are never filled' };
  }
  if (control === 'file') return { support: 'unsupported', reason: 'File uploads must be done by hand' };
  if (control === 'signature') return { support: 'unsupported', reason: 'Signatures must be done by hand' };
  if (control === 'unknown') return { support: 'unsupported', reason: 'AwaazForm does not recognise this control' };
  if (control === 'grid' || control === 'checkbox-grid') {
    return { support: 'limited', reason: 'Grid questions are filled row by row and may need manual review' };
  }
  if (/aadha+r|\bpan\b|passport|voter\s?id|driving licen[cs]e|आधार|पैन/i.test(label)) {
    // Government IDs may be answered by the user, but the value is filled only, never saved or offered.
    return { support: 'manual', reason: 'Government ID numbers: please check this one yourself' };
  }
  return { support: 'supported' };
}

/** Suggests a canonical key for a question. The user confirms the mapping once (FR-32). */
// Which saved detail (if any) a question asks for. It must be the person's OWN detail: “Father's name”,
// “Name of event”, “Company email”, “Emergency contact number” and “State your reason” are not.
// Wrong guesses put saved data in the wrong place, so this errs on the side of offering nothing.

/** Someone or something other than the person filling the form. */
const SOMEONE_ELSE = /father|mother|guardian|parent|spouse|husband|wife|nominee|referee|reference|emergency|child|son\b|daughter|sibling|brother|sister|manager|supervisor|teacher|principal|doctor|witness|landlord|employer|company|organi[sz]ation|institut|school|college|university|event|team|project|product|business|shop|office|department|course|program|bank|branch|hospital|vehicle|pet|friend|relative|contact person|पिता|माता|पति|पत्नी|अभिभावक|संस्था|कंपनी|स्कूल|कॉलेज/i;
const QUESTION_LIKE = /\?|\b(why|how|what|which|when|describe|explain|tell us|reason|comment|feedback|suggest)\b/i;

export function suggestCanonicalKey(q: Pick<FormQuestion, 'label' | 'type'>): CanonicalKey | null {
  const raw = q.label.trim();
  const l = raw.toLowerCase().replace(/[*:：]+\s*$/u, '').trim();
  if (isSensitive(raw) || l.length > 70 || SOMEONE_ELSE.test(l)) return null;
  // Long free-text questions and choices are never a saved detail (a state or country list is, below).
  if (q.type === 'paragraph' || q.type === 'checkbox' || q.type === 'multichoice' || q.type === 'yesno' || q.type === 'scale' || q.type === 'file' || q.type === 'signature') return null;
  const own = /^(your|my|applicant'?s?|candidate'?s?|student'?s?|participant'?s?|employee'?s?|customer'?s?|patient'?s?|आपका|आपकी|अपना)\s+/i;
  const core = l.replace(own, '').replace(/\s*\((.*?)\)\s*/g, ' ').trim();
  const choiceOk = q.type === 'choice' || q.type === 'dropdown';

  if (!choiceOk && (q.type === 'email' || /^(e-?mail|email address|email id|mail id|ईमेल)(\s+address)?$/.test(core))) return 'email';
  if (!choiceOk && (q.type === 'phone' || /^(phone|mobile|cell|whatsapp|contact)(\s+(no\.?|number|num))?$|^(phone|mobile) number$|^(फ़ोन|फोन|मोबाइल)(\s+नंबर)?$/.test(core))) return 'phone';
  if (!choiceOk && /^(date of birth|dob|birth ?date|birthday|जन्म तिथि|जन्मतिथि|जन्म की तारीख)$/.test(core)) return 'date_of_birth';
  if (!choiceOk && (q.type === 'text') && /^((full|complete|legal)\s+)?name(\s+in\s+(full|english|block letters|capital letters))?$|^name of (the )?(applicant|candidate|student|participant|person|respondent)$|^(नाम|पूरा नाम)$/.test(core)) return 'full_name';
  if (!choiceOk && /^(address line 2|address 2|apartment, suite.*)$/.test(core)) return 'address_line2';
  if (!choiceOk && /^((home|residential|current|permanent|postal|mailing)\s+)?address(\s+line\s*1)?$|^(पता|घर का पता)$/.test(core)) return 'address_line1';
  if (/^(city|town|city\s*\/\s*town|शहर)$/.test(core)) return 'city';
  if (/^(state|state\s*\/\s*(province|ut)|province|राज्य)$/.test(core)) return 'state';
  if (!choiceOk && /^(pin ?code|pin|postal code|postcode|zip( code)?|पिन कोड|पिनकोड)$/.test(core)) return 'postal_code';
  if (/^(country|देश)$/.test(core)) return 'country';
  if (QUESTION_LIKE.test(l)) return null;
  return null;
}
