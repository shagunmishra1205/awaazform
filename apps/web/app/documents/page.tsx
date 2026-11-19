'use client';

import { useEffect, useState } from 'react';
import { DocumentUpload } from '@/components/documents/DocumentUpload';
import { DocxFlow } from '@/components/documents/DocxFlow';
import { PdfFlow } from '@/components/documents/PdfFlow';
import { db } from '@/lib/db';
import { DOCX_KEY, PDF_KEY } from '@/lib/session-store';
import { useSettings } from '@/lib/settings';

type Kind = 'pdf' | 'docx';
type State = { kind: Kind | null; file?: File; error?: string; n: number };

const kindOf = (f: File): Kind | null =>
  /\.pdf$/i.test(f.name) || f.type === 'application/pdf' ? 'pdf'
    : /\.docx$/i.test(f.name) || f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ? 'docx'
    : null;

/** PDFs and Word files in one place: one drop zone, the right filler for each, and resume where you left off. */
export default function DocumentsPage() {
  const { t } = useSettings();
  const [state, setState] = useState<State | null>(null);

  // Resume the document worked on most recently, if its session is still stored.
  useEffect(() => {
    (async () => {
      const [pdf, docx] = await Promise.all([db.files.get('current-pdf'), db.files.get('current-docx')]);
      const has = (k: string) => !!localStorage.getItem(k);
      const candidates = [
        pdf && has(PDF_KEY) ? { kind: 'pdf' as const, at: pdf.createdAt } : null,
        docx && has(DOCX_KEY) ? { kind: 'docx' as const, at: docx.createdAt } : null,
      ].filter(Boolean) as { kind: Kind; at: string }[];
      candidates.sort((a, b) => b.at.localeCompare(a.at));
      setState({ kind: candidates[0]?.kind ?? null, n: 0 });
    })().catch(() => setState({ kind: null, n: 0 }));
  }, []);

  const pick = (f: File) => {
    const kind = kindOf(f);
    if (!kind) {
      const old = /\.doc$/i.test(f.name);
      return setState((s) => ({ kind: null, n: (s?.n ?? 0) + 1, error: old ? t.docx.old_doc : t.documents.wrong_type }));
    }
    setState((s) => ({ kind, file: f, n: (s?.n ?? 0) + 1 }));
  };

  if (!state) return null;
  if (state.kind === 'pdf') return <PdfFlow key={state.n} file={state.file} onPick={pick} />;
  if (state.kind === 'docx') return <DocxFlow key={state.n} file={state.file} onPick={pick} />;
  return <DocumentUpload reading={null} error={state.error} onFile={pick} />;
}
