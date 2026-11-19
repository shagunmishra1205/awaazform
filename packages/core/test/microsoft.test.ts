import { describe, expect, it } from 'vitest';
import { createSession, extractMicrosoftApiUrl, microsoftPrefillUrl, parseMicrosoftForm, parseMicrosoftFormUrl, sessionReducer, type Session } from '../src';

const FORM_ID = '4AbrgWRFKUK8KfglTe6GEh_Bkf8tG6RKibFubrLcMHpURTdDRThGVlBQWTVEUEIzWkhMWVhaWlhNWi4u';
const qid = (n: number) => `r${String(n).padStart(32, '0')}`;
const choice = (...labels: string[]) => labels.map((Description) => ({ Description }));

// Shapes copied from a real runtimeForms payload (Nov 2026), with made-up content.
const JSON_FORM = {
  title: 'Workshop  registration',
  description: 'Sign up',
  settings: JSON.stringify({ IsAnonymous: true, AllowPrefill: true }),
  questions: [
    { id: qid(2), order: 2, title: 'Email address', type: 'Question.TextField', required: true, questionInfo: '{"Multiline":false}' },
    { id: qid(1), order: 1, title: 'Your name', type: 'Question.TextField', required: true, questionInfo: '{"Multiline":false}' },
    { id: qid(3), order: 3, title: 'Tell us more', type: 'Question.TextField', required: false, questionInfo: '{"Multiline":true}' },
    { id: qid(4), order: 4, title: 'Role', type: 'Question.Choice', required: true, questionInfo: JSON.stringify({ ChoiceType: 1, Choices: choice('Student', 'Teacher') }) },
    { id: qid(5), order: 5, title: 'Sessions', type: 'Question.Choice', required: false, questionInfo: JSON.stringify({ ChoiceType: 2, Choices: choice('AI', 'Web', 'Design') }) },
    { id: qid(6), order: 6, title: 'First time?', type: 'Question.Choice', required: false, questionInfo: JSON.stringify({ ChoiceType: 1, Choices: choice('Yes', 'No') }) },
    { id: qid(7), order: 7, title: 'Date', type: 'Question.DateTime', required: false, questionInfo: '{"Date":true,"Time":false}' },
    { id: qid(8), order: 8, title: 'Rate us', type: 'Question.Rating', required: false, questionInfo: '{"Length":5}' },
    { id: qid(9), order: 9, title: 'Upload ID', type: 'Question.Upload', required: false, questionInfo: '{}' },
    { id: qid(10), order: 10, title: 'Age', type: 'Question.TextField', required: false, questionInfo: '{"Multiline":false,"Restriction":1}' },
  ],
};

describe('parseMicrosoftFormUrl', () => {
  it('accepts short, responder and scheme-less links on Microsoft hosts', () => {
    expect(parseMicrosoftFormUrl('https://forms.office.com/r/ZS8SNWCRCG')).toEqual({ kind: 'short', url: 'https://forms.office.com/r/ZS8SNWCRCG' });
    expect(parseMicrosoftFormUrl('forms.office.com/e/AbC123')).toEqual({ kind: 'short', url: 'https://forms.office.com/e/AbC123' });
    expect(parseMicrosoftFormUrl(`https://forms.office.com/pages/responsepage.aspx?id=${FORM_ID}&route=shorturl`)).toEqual({ kind: 'form', formId: FORM_ID, host: 'forms.office.com' });
    expect(parseMicrosoftFormUrl(`Fill: https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=${FORM_ID}`)).toEqual({ kind: 'form', formId: FORM_ID, host: 'forms.cloud.microsoft' });
  });
  it('flags editor links and rejects other hosts', () => {
    expect(parseMicrosoftFormUrl(`https://forms.office.com/Pages/DesignPageV2.aspx?id=${FORM_ID}`)).toEqual({ kind: 'edit' });
    for (const bad of ['https://forms.office.com.evil.com/r/abc', 'https://evil.com/Pages/ResponsePage.aspx?id=x', 'nothing here']) {
      expect(parseMicrosoftFormUrl(bad), bad).toBeNull();
    }
  });
});

describe('extractMicrosoftApiUrl', () => {
  it('reads an allow-listed runtime API address only', () => {
    const ok = '"prefetchFormUrl":"https://forms.cloud.microsoft/formapi/api/t/users/u/light/runtimeForms(\\u0027X\\u0027)?$expand=questions($expand=choices)"';
    expect(extractMicrosoftApiUrl(ok)).toContain("runtimeForms('X')");
    expect(extractMicrosoftApiUrl('"prefetchFormUrl":"https://evil.com/formapi/api/x"')).toBeNull();
  });
});

describe('parseMicrosoftForm', () => {
  const form = parseMicrosoftForm(JSON_FORM, FORM_ID);
  const by = (label: string) => form.questions.find((q) => q.label === label)!;
  it('orders questions and maps their types', () => {
    expect(form.title).toBe('Workshop registration');
    expect(form.questions.map((q) => q.label).slice(0, 2)).toEqual(['Your name', 'Email address']);
    expect(by('Email address').type).toBe('email');
    expect(by('Tell us more').type).toBe('paragraph');
    expect(by('Role')).toMatchObject({ type: 'choice', options: ['Student', 'Teacher'] });
    expect(by('Sessions')).toMatchObject({ type: 'checkbox', options: ['AI', 'Web', 'Design'] });
    expect(by('First time?').type).toBe('yesno');
    expect(by('Date').type).toBe('date');
    expect(by('Rate us')).toMatchObject({ type: 'scale', options: ['1', '2', '3', '4', '5'] });
    expect(by('Upload ID').support).toBe('unsupported');
    expect(by('Age').type).toBe('number');
  });
  it('builds a pre-filled link from verified answers only, when the form allows it', () => {
    let s: Session = createSession({ id: 's', formTitle: form.title, questions: form.questions });
    const verify = (label: string, v: string) => {
      const id = by(label).id;
      for (const a of [{ type: 'propose', questionId: id, raw: v, normalized: v, source: 'typed' }, { type: 'confirm', questionId: id }, { type: 'written', questionId: id }, { type: 'verified', questionId: id, ok: true }] as const) s = sessionReducer(s, a);
    };
    verify('Your name', 'Asha Rao');
    verify('Sessions', 'AI, Design');
    s = sessionReducer(s, { type: 'propose', questionId: by('Role').id, raw: 'Student', normalized: 'Student', source: 'typed' });
    const u = new URL(microsoftPrefillUrl(s)!);
    expect(u.searchParams.get('id')).toBe(FORM_ID);
    expect(u.searchParams.get(qid(1))).toBe('Asha Rao');
    expect(JSON.parse(u.searchParams.get(qid(5))!)).toEqual(['AI', 'Design']);
    expect(u.searchParams.has(qid(4))).toBe(false);

    const closed = parseMicrosoftForm({ ...JSON_FORM, settings: '{}' }, FORM_ID);
    expect(microsoftPrefillUrl(createSession({ id: 't', formTitle: 'x', questions: closed.questions }))).toBeNull();
  });
});
