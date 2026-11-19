'use client';

import { buildReport, reportToMarkdown, type ReadinessReport, type ReportItem } from '@awaazform/core';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Reveal } from '@/components/Motion';
import { localizeMessage } from '@/lib/i18n';
import { loadLastSession } from '@/lib/session-store';
import { useSettings } from '@/lib/settings';

// FR-20 / FR-21: Submission Readiness Report with export, copy and print.
export default function ReportPage() {
  const { t } = useSettings();
  const r = t.report;
  const [report, setReport] = useState<ReadinessReport | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [base, setBase] = useState('/form');

  useEffect(() => {
    void loadLastSession().then((s) => {
    setReport(s ? buildReport(s) : null);
    const kind = s?.questions[0]?.source.kind;
    if (kind?.startsWith('pdf')) setBase('/pdf');
    else if (kind === 'docx') setBase('/docx');
    else if (kind === 'dom') setBase('/extension');
    });
  }, []);

  if (report === undefined) return null;
  if (report === null) {
    return (
      <div className="container-x py-16 text-center">
        <h1 className="text-3xl">{r.none_title}</h1>
        <p className="mt-2 text-muted">{r.none_body}</p>
        <Link href="/form" className="btn mt-6">{r.none_cta}</Link>
      </div>
    );
  }

  const md = reportToMarkdown(report);
  const download = () => {
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'awaazform-report.md' });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="container-x max-w-3xl py-12">
      <Reveal>
        <p className="text-sm text-muted">{r.eyebrow}</p>
        <h1 className="text-[clamp(1.75rem,3vw,2.5rem)]">{report.formTitle}</h1>
      </Reveal>
      <Reveal delay={0.08}>
        <p role="status" className="mt-4 rounded-[var(--r-16)] border p-4 font-medium"
          style={report.ready
            ? { borderColor: 'var(--green-600)', background: 'var(--green-100)', color: 'var(--green-600)' }
            : { borderColor: 'var(--amber-700)', background: 'var(--amber-100)', color: 'var(--amber-700)' }}>
          {report.ready
            ? r.ready
            : r.not_ready}
        </p>
      </Reveal>

      <div className="mt-6 flex flex-wrap gap-2 print:hidden">
        <button type="button" className="btn" onClick={download}>{r.export}</button>
        <button type="button" className="btn btn-ghost" onClick={async () => { await navigator.clipboard.writeText(md); setCopied(true); }}>
          {copied ? t.common.copied : r.copy}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => window.print()}>{r.print}</button>
        <Link href={base} className="btn btn-ghost">{r.back}</Link>
      </div>

      <div className="mt-10 grid gap-8">
        <Group id="missing" title={r.missing} items={report.missing} tone="warn" base={base} />
        <Group id="invalid" title={r.invalid} items={report.invalid} tone="warn" base={base} />
        <Group id="manual" title={r.manual} items={report.manualReview} tone="warn" base={base} />
        <Group id="unsupported" title={r.unsupported} items={report.unsupported} tone="info" base={base} />
        <Group id="completed" title={r.completed} items={report.completed} tone="ok" base={base} />
      </div>
    </div>
  );
}

function Group({ id, title, items, tone, base }: { id: string; title: string; items: ReportItem[]; tone: 'ok' | 'warn' | 'info'; base: string }) {
  const { t } = useSettings();
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={`h-${id}`}>
      <h2 id={`h-${id}`} className="mb-3 flex items-center gap-2 text-xl">
        {title} <span className={`chip ${tone === 'ok' ? 'chip-ok' : tone === 'warn' ? 'chip-warn' : ''}`}>{items.length}</span>
      </h2>
      <ul className="card divide-y divide-[var(--border)] p-0">
        {items.map((i) => (
          <li key={i.questionId} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
            <span>
              <span className="font-medium">Q{i.index + 1}. {i.label}</span>
              {i.value && <span className="text-muted"> · {i.value}</span>}
              {i.note && <span className="block text-xs text-muted">{localizeMessage(t, i.note)}</span>}
            </span>
            {tone !== 'ok' && <Link href={base === '/form' ? `/form?q=${i.index}` : base} className="text-sm underline underline-offset-4 print:hidden">{t.report.goto}</Link>}
          </li>
        ))}
      </ul>
    </section>
  );
}
