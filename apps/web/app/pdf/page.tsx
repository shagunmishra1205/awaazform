'use client';

import { createSession, type Session } from '@awaazform/core';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Reveal, Wave } from '@/components/Motion';
import { BoxEditor } from '@/components/pdf/BoxEditor';
import { PdfSurface } from '@/components/pdf/PdfSurface';
import { SessionWorkspace } from '@/components/SessionWorkspace';
import { db } from '@/lib/db';
import {
  aiCandidates, analyzePdf, flatPlan, heuristicCandidates, MAX_PDF_BYTES, PdfFiller, placeBoxes,
  type Candidate, type PageSize, type PdfLayout, type PdfPlan, type TextItem,
} from '@/lib/pdf';
import { discardSession, loadSession, PDF_KEY } from '@/lib/session-store';
import { fmt, localizeMessage, Rich } from '@/lib/i18n';
import { getFile, putFile } from '@/lib/secure-store';
import { useSettings } from '@/lib/settings';
import type { SurfaceHandle } from '@/lib/surface';

const FILE_ID = 'current-pdf';

type Step =
  | { s: 'upload'; error?: string }
  | { s: 'reading'; name: string }
  | { s: 'review'; bytes: ArrayBuffer; fileName: string; title: string; pages: PageSize[]; items: TextItem[]; candidates: Candidate[]; boxes: PdfLayout['boxes']; via: 'ai' | 'heuristic'; aiError?: string }
  | { s: 'fill'; bytes: ArrayBuffer; plan: PdfPlan; filler: PdfFiller; session: Session; resumed: boolean };

export default function PdfPage() {
  const { settings, t } = useSettings();
  const D = t.pdf;
  const [step, setStep] = useState<Step>({ s: 'upload' });
  const surfaceRef = useRef<SurfaceHandle | null>(null);

  // FR-22: resume a PDF session stored in this browser.
  useEffect(() => {
    (async () => {
      const stored = await getFile(FILE_ID);
      const saved = await loadSession(PDF_KEY);
      if (!stored || !saved) return;
      const plan = stored.plan as PdfPlan;
      const filler = await PdfFiller.create(stored.bytes, plan);
      setStep({ s: 'fill', bytes: stored.bytes, plan, filler, session: saved, resumed: Object.values(saved.answers).some((a) => a.status !== 'pending') });
    })().catch(() => {});
  }, []);

  const startFill = async (bytes: ArrayBuffer, plan: PdfPlan) => {
    const filler = await PdfFiller.create(bytes, plan);
    const session = createSession({ id: crypto.randomUUID(), formTitle: plan.title, questions: plan.questions, language: settings.language });
    discardSession(PDF_KEY);
    await putFile({ id: FILE_ID, name: plan.fileName, bytes, plan, createdAt: new Date().toISOString() });
    setStep({ s: 'fill', bytes, plan, filler, session, resumed: false });
  };

  const onFile = async (file: File) => {
    if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) return setStep({ s: 'upload', error: D.not_pdf });
    if (file.size > MAX_PDF_BYTES) return setStep({ s: 'upload', error: localizeMessage(t, 'This PDF is larger than 10 MB.') });
    setStep({ s: 'reading', name: file.name });
    const bytes = await file.arrayBuffer();
    const a = await analyzePdf(bytes, file.name);
    if (a.kind === 'unsupported') return setStep({ s: 'upload', error: localizeMessage(t, a.reason) });
    if (a.kind === 'acroform') return startFill(bytes, a.plan);

    // Flat PDF: ask AI to find questions; fall back to a simple heuristic.
    let candidates: Candidate[];
    let via: 'ai' | 'heuristic' = 'ai';
    let aiError: string | undefined;
    try {
      candidates = await aiCandidates(a.items, a.pages);
      if (candidates.length === 0) throw new Error('AI found no questions');
    } catch (err) {
      candidates = heuristicCandidates(a.items);
      via = 'heuristic';
      aiError = (err as Error).message;
    }
    setStep({ s: 'review', bytes, fileName: a.fileName, title: a.title, pages: a.pages, items: a.items, candidates, boxes: placeBoxes(candidates, a.items, a.pages), via, aiError });
  };

  if (step.s === 'fill') {
    const download = async () => {
      const out = await step.filler.export();
      const url = URL.createObjectURL(new Blob([out as BlobPart], { type: 'application/pdf' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: step.plan.fileName.replace(/\.pdf$/i, '') + '-filled.pdf' });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    return (
      <SessionWorkspace
        key={step.session.id}
        initial={step.session}
        storageKey={PDF_KEY}
        startImmediately={step.resumed}
        sourceLabel={step.plan.kind === 'acroform' ? D.fillable : D.printed}
        surfaceLabel={D.surface}
        surfaceRef={surfaceRef}
        surface={<PdfSurface handleRef={surfaceRef} bytes={step.bytes} plan={step.plan} filler={step.filler} />}
        actions={<button type="button" className="btn" onClick={download}>{D.download}</button>}
        intro={step.plan.kind === 'flat' ? (
          <p className="rounded-[var(--r-12)] px-3 py-2 text-sm" style={{ background: 'var(--amber-100)', color: 'var(--amber-700)' }}>
            {D.printed_note}
          </p>
        ) : undefined}
        onDiscard={async () => { discardSession(PDF_KEY); await db.files.delete(FILE_ID); setStep({ s: 'upload' }); }}
      />
    );
  }

  if (step.s === 'review') {
    const included = step.candidates.filter((c) => c.include).length;
    return (
      <div className="container-x py-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-medium tracking-wide text-muted uppercase">{D.review_eyebrow}</p>
            <h1 className="text-[clamp(1.5rem,3vw,2rem)]">{D.review_title}</h1>
            <p className="mt-1 max-w-2xl text-muted">
              {fmt(step.via === 'ai' ? D.review_ai : step.aiError ? D.review_rules_err : D.review_rules,
                { n: step.candidates.length, title: step.title, error: localizeMessage(t, step.aiError) })}
            </p>
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn btn-ghost" onClick={() => setStep({ s: 'upload' })}>{t.common.choose_another}</button>
            <button type="button" className="btn" disabled={included === 0}
              onClick={() => startFill(step.bytes, flatPlan(step.fileName, step.title, step.pages, step.candidates, step.boxes, step.items))}>
              {fmt(D.start, { n: included })}
            </button>
          </div>
        </div>
        <BoxEditor bytes={step.bytes} pages={step.pages} candidates={step.candidates} boxes={step.boxes}
          onChange={(candidates) => setStep({ ...step, candidates })} onBoxes={(boxes) => setStep({ ...step, boxes })} />
      </div>
    );
  }

  return <UploadView reading={step.s === 'reading' ? step.name : null} error={step.s === 'upload' ? step.error : undefined} onFile={onFile} />;
}

function UploadView({ reading, error, onFile }: { reading: string | null; error?: string; onFile: (f: File) => void }) {
  const { t } = useSettings();
  const D = t.pdf;
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
        <p className="text-xs font-medium tracking-wide text-muted uppercase">{D.eyebrow}</p>
        <h1 className="mt-2 text-[clamp(2rem,4vw,2.75rem)]"><Rich text={D.title} /></h1>
        <p className="mx-auto mt-3 max-w-lg text-muted">{D.lead}</p>
      </Reveal>

      <Reveal delay={0.08}>
        <div
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
          className="mt-10 grid justify-items-center gap-4 rounded-[var(--r-24)] border-2 border-dashed p-10 text-center transition-colors"
          style={{ borderColor: over ? 'var(--violet-500)' : 'var(--border)', background: over ? 'var(--violet-100)' : 'var(--gradient-panel)' }}>
          {reading ? (
            <div className="grid justify-items-center gap-3" role="status">
              <span style={{ color: 'var(--accent)' }}><Wave bars={10} /></span>
              <p className="font-medium">{fmt(D.reading, { name: reading })}</p>
              <p className="text-sm text-muted">{D.reading_sub}</p>
            </div>
          ) : (
            <>
              <span aria-hidden className="grid h-14 w-14 place-items-center rounded-[var(--r-16)] text-2xl" style={{ background: 'var(--violet-100)', color: 'var(--accent-text)' }}>⇪</span>
              <div>
                <p className="text-lg font-semibold">{D.drop}</p>
                <p className="text-sm text-muted">{t.common.or}</p>
              </div>
              <button type="button" className="btn btn-lg" onClick={() => inputRef.current?.click()}>{D.choose}</button>
              <input ref={inputRef} type="file" accept="application/pdf,.pdf" className="sr-only" aria-label={D.choose} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
              <p className="text-xs text-muted">{t.common.up_to_10mb}</p>
            </>
          )}
        </div>
      </Reveal>

      {error && <p role="alert" className="mt-4 rounded-[var(--r-12)] p-4 text-sm font-medium" style={{ background: 'var(--amber-100)', color: 'var(--amber-700)' }}>{localizeMessage(t, error)}</p>}

      <ul className="mt-10 grid gap-4 md:grid-cols-3">
        {[[D.k1_t, D.k1_b, 'chip-ok'], [D.k2_t, D.k2_b, 'chip-warn'], [D.k3_t, D.k3_b, '']].map(([title, b, c], i) => (
          <Reveal as="li" key={i} delay={0.1 + i * 0.06} className="card grid content-start gap-2 p-5">
            <span className={`chip w-fit ${c}`}>{title}</span>
            <p className="text-sm text-muted">{b}</p>
          </Reveal>
        ))}
      </ul>
      <p className="mt-6 text-center text-xs text-muted">{D.groq_note}</p>
    </div>
  );
}
