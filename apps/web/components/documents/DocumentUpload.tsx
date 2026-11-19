'use client';

import { useRef, useState, type DragEvent } from 'react';
import { Reveal, Wave } from '@/components/Motion';
import { fmt, localizeMessage, Rich } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';

export const DOCUMENT_ACCEPT = '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** One drop zone for every document AwaazForm fills: PDFs (fillable or printed) and Word files. */
export function DocumentUpload({ reading, error, onFile }: { reading: string | null; error?: string; onFile: (f: File) => void }) {
  const { t } = useSettings();
  const D = t.documents;
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
          className="mt-10 grid justify-items-center gap-4 rounded-[var(--r-24)] border-2 border-dashed p-8 text-center transition-colors md:p-10"
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
              <input ref={inputRef} type="file" accept={DOCUMENT_ACCEPT} className="sr-only" aria-label={D.choose}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
              <p className="text-xs text-muted">{D.limit}</p>
            </>
          )}
        </div>
      </Reveal>

      {error && <p role="alert" className="mt-4 rounded-[var(--r-12)] p-4 text-sm font-medium" style={{ background: 'var(--amber-100)', color: 'var(--amber-700)' }}>{localizeMessage(t, error)}</p>}

      <ul className="mt-10 grid gap-4 sm:grid-cols-2">
        {[[D.k1_t, D.k1_b, 'chip-ok'], [D.k2_t, D.k2_b, 'chip-warn'], [D.k3_t, D.k3_b, 'chip-ok'], [D.k4_t, D.k4_b, '']].map(([title, b, c], i) => (
          <Reveal as="li" key={i} delay={0.1 + i * 0.05} className="card grid content-start gap-2 p-5">
            <span className={`chip w-fit ${c}`}>{title}</span>
            <p className="text-sm text-muted">{b}</p>
          </Reveal>
        ))}
      </ul>
      <p className="mt-6 text-center text-xs text-muted">{D.groq_note}</p>
    </div>
  );
}
