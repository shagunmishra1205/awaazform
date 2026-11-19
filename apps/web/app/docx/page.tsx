'use client';

import { createSession, type FieldType, type FormQuestion, type Session } from '@awaazform/core';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { DocxSurface } from '@/components/docx/DocxSurface';
import { Reveal, Wave } from '@/components/Motion';
import { SessionWorkspace } from '@/components/SessionWorkspace';
import { db } from '@/lib/db';
import { DocxDoc, docxQuestions, MAX_DOCX_BYTES } from '@/lib/docx';
import { discardSession, DOCX_KEY, loadSession } from '@/lib/session-store';
import { fmt, localizeMessage, Rich } from '@/lib/i18n';
import { getFile, putFile } from '@/lib/secure-store';
import { useSettings } from '@/lib/settings';
import type { SurfaceHandle } from '@/lib/surface';

const FILE_ID = 'current-docx';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** What the user decided in review; kept with the file so a reload restores the same questions. */
interface DocxChoices { keep: string[]; labels: Record<string, string>; types: Record<string, FieldType> }

type Step =
  | { s: 'upload'; error?: string }
  | { s: 'reading'; name: string }
  | { s: 'review'; bytes: ArrayBuffer; doc: DocxDoc; choices: DocxChoices }
  | { s: 'fill'; bytes: ArrayBuffer; doc: DocxDoc; questions: FormQuestion[]; session: Session; resumed: boolean };

const TYPES: FieldType[] = ['text', 'paragraph', 'number', 'date', 'email', 'phone'];

function questionsFor(doc: DocxDoc, c: DocxChoices): FormQuestion[] {
  return docxQuestions(doc.plan, new Set(c.keep)).map((q) => ({
    ...q,
    label: c.labels[q.id]?.trim() || q.label,
    type: q.options ? q.type : c.types[q.id] ?? q.type,
  }));
}

export default function DocxPage() {
  const { settings, t } = useSettings();
  const W = t.docx;
  const [step, setStep] = useState<Step>({ s: 'upload' });
  const surfaceRef = useRef<SurfaceHandle | null>(null);

  // FR-22: resume a Word session stored in this browser.
  useEffect(() => {
    (async () => {
      const stored = await getFile(FILE_ID);
      const saved = await loadSession(DOCX_KEY);
      if (!stored || !saved) return;
      const doc = DocxDoc.open(stored.bytes, stored.name);
      const questions = questionsFor(doc, stored.plan as DocxChoices);
      setStep({ s: 'fill', bytes: stored.bytes, doc, questions, session: saved, resumed: Object.values(saved.answers).some((a) => a.status !== 'pending') });
    })().catch(() => {});
  }, []);

  const onFile = async (file: File) => {
    if (!/\.docx$/i.test(file.name) && file.type !== DOCX_MIME) {
      return setStep({ s: 'upload', error: /\.doc$/i.test(file.name) ? W.old_doc : W.not_docx });
    }
    if (file.size > MAX_DOCX_BYTES) return setStep({ s: 'upload', error: W.too_big });
    setStep({ s: 'reading', name: file.name });
    const bytes = await file.arrayBuffer();
    try {
      const doc = DocxDoc.open(bytes, file.name);
      if (doc.plan.slots.length === 0) {
        return setStep({ s: 'upload', error: W.none_found });
      }
      setStep({ s: 'review', bytes, doc, choices: { keep: doc.plan.slots.map((x) => x.id), labels: {}, types: {} } });
    } catch (err) {
      setStep({ s: 'upload', error: localizeMessage(t, (err as Error).message) });
    }
  };

  const startFill = async (bytes: ArrayBuffer, doc: DocxDoc, choices: DocxChoices) => {
    // Re-open from the original bytes so the session starts from a clean document.
    const fresh = DocxDoc.open(bytes, doc.plan.fileName);
    const questions = questionsFor(fresh, choices);
    const session = createSession({ id: crypto.randomUUID(), formTitle: fresh.plan.title, questions, language: settings.language });
    discardSession(DOCX_KEY);
    await putFile({ id: FILE_ID, name: fresh.plan.fileName, bytes, plan: choices, createdAt: new Date().toISOString() });
    setStep({ s: 'fill', bytes, doc: fresh, questions, session, resumed: false });
  };

  if (step.s === 'fill') {
    const download = () => {
      const out = step.doc.export();
      const url = URL.createObjectURL(new Blob([out as BlobPart], { type: DOCX_MIME }));
      const a = Object.assign(document.createElement('a'), { href: url, download: step.doc.plan.fileName.replace(/\.docx$/i, '') + '-filled.docx' });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    return (
      <SessionWorkspace
        key={step.session.id}
        initial={step.session}
        storageKey={DOCX_KEY}
        startImmediately={step.resumed}
        sourceLabel={W.source}
        surfaceLabel={W.surface}
        surfaceRef={surfaceRef}
        surface={<DocxSurface handleRef={surfaceRef} doc={step.doc} questions={step.questions} />}
        actions={<button type="button" className="btn" onClick={download}>{W.download}</button>}
        intro={
          <p className="rounded-[var(--r-12)] px-3 py-2 text-sm" style={{ background: 'var(--violet-100)', color: 'var(--accent-text)' }}>
            {W.intro}
          </p>
        }
        onDiscard={async () => { discardSession(DOCX_KEY); await db.files.delete(FILE_ID); setStep({ s: 'upload' }); }}
      />
    );
  }

  if (step.s === 'review') {
    const { doc, choices } = step;
    const set = (patch: Partial<DocxChoices>) => setStep({ ...step, choices: { ...choices, ...patch } });
    return (
      <div className="container-x max-w-3xl py-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-medium tracking-wide text-muted uppercase">{W.review_eyebrow}</p>
            <h1 className="text-[clamp(1.5rem,3vw,2rem)]">{W.review_title}</h1>
            <p className="mt-1 max-w-2xl text-muted">{fmt(W.review_body, { n: doc.plan.slots.length, title: doc.plan.title })}</p>
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn btn-ghost" onClick={() => setStep({ s: 'upload' })}>{t.common.choose_another}</button>
            <button type="button" className="btn" disabled={choices.keep.length === 0} onClick={() => void startFill(step.bytes, doc, choices)}>
              {fmt(W.start, { n: choices.keep.length })}
            </button>
          </div>
        </div>
        <ol className="grid gap-2">
          {doc.plan.slots.map((x, i) => {
            const on = choices.keep.includes(x.id);
            return (
              <li key={x.id} className="card grid gap-3 p-4 sm:grid-cols-[auto_1fr_auto] sm:items-center">
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input type="checkbox" className="h-5 w-5" checked={on} onChange={() => set({ keep: on ? choices.keep.filter((k) => k !== x.id) : [...choices.keep, x.id] })} />
                  <span className="sr-only">{fmt(W.fill_place, { n: i + 1 })}</span><span aria-hidden className="text-muted">{i + 1}</span>
                </label>
                <label className="grid gap-1">
                  <span className="sr-only">{fmt(W.question_n, { n: i + 1 })}</span>
                  <input className="field-input" value={choices.labels[x.id] ?? x.label} disabled={!on}
                    onChange={(e) => set({ labels: { ...choices.labels, [x.id]: e.target.value } })} />
                  {x.options && <span className="text-xs text-muted">{fmt(t.pdf.options, { list: x.options.join(' · ') })}</span>}
                </label>
                {!x.options && (
                  <label className="grid gap-1 text-sm">
                    <span className="sr-only">{fmt(W.type_for, { n: i + 1 })}</span>
                    <select className="field-input !min-h-11" value={choices.types[x.id] ?? x.type} disabled={!on}
                      onChange={(e) => set({ types: { ...choices.types, [x.id]: e.target.value as FieldType } })}>
                      {TYPES.map((v) => <option key={v} value={v}>{t.types[v]}</option>)}
                    </select>
                  </label>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    );
  }

  return <UploadView reading={step.s === 'reading' ? step.name : null} error={step.s === 'upload' ? step.error : undefined} onFile={onFile} />;
}

function UploadView({ reading, error, onFile }: { reading: string | null; error?: string; onFile: (f: File) => void }) {
  const { t } = useSettings();
  const W = t.docx;
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  };
  return (
    <div className="container-x max-w-3xl py-12 md:py-16">
      <Reveal className="text-center">
        <p className="text-xs font-medium tracking-wide text-muted uppercase">{W.eyebrow}</p>
        <h1 className="mt-2 text-[clamp(2rem,4vw,2.75rem)]"><Rich text={W.title} /></h1>
        <p className="mx-auto mt-3 max-w-lg text-muted">{W.lead}</p>
      </Reveal>
      <Reveal delay={0.08}>
        <div onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
          className="card mt-10 grid place-items-center gap-4 border-2 border-dashed p-10 text-center transition-colors"
          style={{ borderColor: over ? 'var(--accent)' : 'var(--border)', background: over ? 'var(--violet-100)' : undefined }}>
          {reading ? (
            <p role="status" className="flex items-center gap-3 text-muted"><span style={{ color: 'var(--accent)' }}><Wave bars={6} /></span> {fmt(W.reading, { name: reading })}</p>
          ) : (
            <>
              <p className="font-semibold">{W.drop}</p>
              <button type="button" className="btn btn-lg" onClick={() => inputRef.current?.click()}>{W.choose}</button>
              <input ref={inputRef} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="sr-only"
                aria-label={W.choose} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
              <p className="text-sm text-muted">{W.kinds}</p>
            </>
          )}
          {error && <p role="alert" className="w-full rounded-[var(--r-12)] p-4 text-sm font-medium" style={{ background: 'var(--amber-100)', color: 'var(--amber-700)' }}>{error}</p>}
        </div>
      </Reveal>
    </div>
  );
}
