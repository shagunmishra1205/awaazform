'use client';

import { formatDate, type FormQuestion, type Session, type SessionEvent } from '@awaazform/core';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Block, DocxDoc, Part } from '@/lib/docx';
import { useSettings } from '@/lib/settings';
import type { SurfaceHandle } from '@/lib/surface';

type Visual = 'idle' | 'proposed' | 'written' | 'verified' | 'failed';

/** A plain, readable preview of the Word document, with each fill place marked and filled live. */
export function DocxSurface({ handleRef, doc, questions }: { handleRef: RefObject<SurfaceHandle | null>; doc: DocxDoc; questions: FormQuestion[] }) {
  const { t } = useSettings();
  const scrollRef = useRef<HTMLDivElement>(null);
  const reduceRef = useRef(false);
  const [active, setActive] = useState<string | null>(null);
  const [visual, setVisual] = useState<Record<string, Visual>>({});
  const [ghost, setGhost] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, string>>({});
  const kept = new Set(questions.map((q) => q.id));
  const show = (q: FormQuestion | undefined, v: string) => (q?.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? formatDate(v) : v);
  const qById = (id: string) => questions.find((q) => q.id === id);

  const scrollTo = (id: string) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-qid="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ block: 'center', behavior: reduceRef.current ? 'auto' : 'smooth' });
  };

  useEffect(() => {
    const writeOne = (q: FormQuestion, v: string) => {
      doc.write(q.id, v);
      setShown((m) => ({ ...m, [q.id]: show(q, doc.read(q.id) ?? v) }));
      setGhost((g) => ({ ...g, [q.id]: '' }));
      setVisual((m) => ({ ...m, [q.id]: 'written' }));
    };
    handleRef.current = {
      write: async (q, v) => writeOne(q, v),
      read: async (q) => doc.read(q.id),
      onEvent: (e: SessionEvent) => {
        if (e.type === 'question.presented') { setActive(e.questionId); scrollTo(e.questionId); }
        if (e.type === 'fill.proposed') {
          setActive(e.questionId);
          scrollTo(e.questionId);
          setGhost((g) => ({ ...g, [e.questionId]: show(qById(e.questionId), e.value) }));
          setVisual((m) => ({ ...m, [e.questionId]: 'proposed' }));
        }
        if (e.type === 'fill.verified') setVisual((m) => ({ ...m, [e.questionId]: e.ok ? 'verified' : 'failed' }));
      },
      focus: (q) => { setActive(q.id); scrollTo(q.id); },
      sync: (s: Session, reduce: boolean) => {
        reduceRef.current = reduce;
        // Restore verified answers into the document (e.g. after reload).
        for (const a of Object.values(s.answers)) {
          const q = qById(a.questionId);
          if (!q || a.status !== 'verified' || !a.normalized) continue;
          try {
            writeOne(q, a.normalized);
            setVisual((m) => ({ ...m, [q.id]: 'verified' }));
          } catch { /* leave it for the user to redo */ }
        }
      },
      setReduceMotion: (r) => { reduceRef.current = r; },
    };
    return () => { handleRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, questions]);

  const slot = (p: Extract<Part, { slot: string }>, key: string) => {
    if (!kept.has(p.slot)) return <span key={key} className="docx-blank" aria-hidden>{p.option !== undefined ? '☐' : ' '.repeat(12)}</span>;
    const vis = visual[p.slot] ?? 'idle';
    const isActive = active === p.slot;
    const pending = vis === 'proposed';
    const value = pending ? ghost[p.slot] ?? '' : shown[p.slot] ?? '';
    if (p.option !== undefined) {
      const on = value.split(', ').includes(p.option);
      return <span key={key} data-qid={p.slot} className="docx-box" data-active={isActive} data-pending={pending && on}>{on ? '☒' : '☐'}</span>;
    }
    return (
      <span key={key} data-qid={p.slot} className="docx-slot" data-active={isActive} data-state={vis} title={qById(p.slot)?.label}>
        {value || ' '.repeat(12)}
        {vis === 'verified' && <span aria-label={t.session.st_verified} className="docx-check">✓</span>}
      </span>
    );
  };
  const parts = (ps: Part[], k: string) => ps.map((p, i) => ('slot' in p ? slot(p, `${k}-${i}`) : <span key={`${k}-${i}`}>{p.text}</span>));

  return (
    <div ref={scrollRef} className="h-[min(76vh,760px)] overflow-auto p-4" style={{ background: 'var(--bg-subtle)', scrollbarWidth: 'thin' }}>
      <article className="docx-page" aria-label={t.docx.preview}>
        {doc.plan.blocks.map((b: Block, i) =>
          b.kind === 'p' ? (
            b.heading ? <h3 key={i} className="docx-h">{parts(b.parts, `p${i}`)}</h3> : <p key={i} className="docx-p">{parts(b.parts, `p${i}`)}</p>
          ) : (
            <table key={i} className="docx-table">
              <tbody>
                {b.rows.map((row, r) => (
                  <tr key={r}>{row.map((cell, c) => <td key={c}>{parts(cell, `t${i}-${r}-${c}`)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          ),
        )}
      </article>
    </div>
  );
}
