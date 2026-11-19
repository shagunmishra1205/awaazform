'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Bolu } from '@/components/Bolu';
import { Reveal } from '@/components/Motion';
import { fmt, Rich } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';

const ZIP = '/downloads/awaazform-extension.zip';

/** Download and install the AwaazForm browser extension. */
export default function ExtensionPage() {
  const { t } = useSettings();
  const E = t.ext;
  const [info, setInfo] = useState<{ version: string; size: string } | null | 'missing'>(null);
  useEffect(() => {
    fetch('/downloads/extension.json').then((r) => (r.ok ? r.json() : null)).then((j: { version: string; bytes: number } | null) => {
      setInfo(j ? { version: j.version, size: `${Math.max(1, Math.round(j.bytes / 1024))} KB` } : 'missing');
    }).catch(() => setInfo('missing'));
  }, []);
  const steps = [[E.i1_t, E.i1_b], [E.i2_t, E.i2_b], [E.i3_t, E.i3_b], [E.i4_t, E.i4_b]];
  return (
    <div className="container-x max-w-4xl py-12 md:py-16">
      <div className="grid items-center gap-10 md:grid-cols-[1.1fr_1fr]">
        <Reveal className="grid gap-4 text-center md:text-start">
          <p className="text-xs font-medium tracking-wide text-muted uppercase">{E.eyebrow}</p>
          <h1 className="text-[clamp(2rem,4vw,2.75rem)]"><Rich text={E.title} /></h1>
          <p className="text-muted">{E.lead}</p>
          <div className="grid justify-items-center gap-2 md:justify-items-start">
            {info === 'missing' ? <p className="text-sm text-muted">{E.download_missing}</p> : (
            <a className="btn btn-lg" href={ZIP} download aria-disabled={!info}>
              <svg aria-hidden width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
              {E.download}
            </a>
            )}
            {info && info !== 'missing' && <span className="text-xs text-muted">{fmt(E.download_note, info)}</span>}
          </div>
        </Reveal>
        <Reveal delay={0.1}><WidgetPreview /></Reveal>
      </div>

      <ol className="mt-14 grid gap-4 sm:grid-cols-2">
        {steps.map(([title, body], i) => (
          <Reveal as="li" key={i} delay={0.05 * i} className="card grid grid-cols-[auto_1fr] items-start gap-4 p-6">
            <span className="chip chip-accent">{i + 1}</span>
            <div><p className="font-semibold">{title}</p><p className="mt-1 text-sm text-muted"><Rich text={body ?? ''} /></p></div>
          </Reveal>
        ))}
      </ol>
      <div className="mt-8 grid gap-3 rounded-[var(--r-16)] border border-line p-5 text-sm">
        <p className="font-semibold">{E.good}</p>
        <ul className="grid list-disc gap-1 ps-5 text-muted">
          {[E.g1, E.g2, E.g3, E.g4].map((g, i) => <li key={i}><Rich text={g ?? ""} /></li>)}
        </ul>
      </div>
      <p className="mt-8 text-center text-sm text-muted">{E.no_ext} <Link href="/form" className="underline underline-offset-4">{E.paste_instead}</Link>.</p>
    </div>
  );
}

/** A static picture of the widget, built from the same pieces, so it always matches the theme. */
function WidgetPreview() {
  const { t } = useSettings();
  return (
    <figure aria-label={t.ext.preview_alt} className="mx-auto grid w-full max-w-[320px] gap-3 rounded-[var(--r-24)] p-4 shadow-[var(--shadow-lg),0_30px_60px_rgba(98,77,227,0.25)]"
      style={{ background: 'var(--ink-950)', color: 'var(--white)' }}>
      <div className="flex items-center gap-2 text-xs">
        <span className="grid h-8 w-8 place-items-center overflow-hidden rounded-full" style={{ background: 'var(--ink-700)' }}><Bolu size={30} state="idle" head /></span>
        <span className="rounded-full px-2.5 py-1" style={{ background: 'var(--ink-700)' }}>हिन्दी</span>
        <span className="ms-auto font-mono opacity-70">01:12</span>
      </div>
      <div className="grid justify-items-center gap-1 py-2">
        <Bolu size={120} state="listening" />
        <span className="text-sm font-semibold">{t.live.listening}</span>
      </div>
      <div className="grid gap-2 rounded-[var(--r-16)] p-3" style={{ background: 'var(--ink-700)' }}>
        <span className="text-xs opacity-70">{fmt(t.widget.question, { n: 3, total: 9 })}</span>
        <span className="text-sm font-semibold">Favourite colour · <span style={{ color: 'var(--violet-300)' }}>Blue</span></span>
        <span className="grid grid-cols-2 gap-2 text-xs font-semibold">
          <span className="rounded-[var(--r-12)] py-2 text-center" style={{ background: 'var(--violet-500)' }}>✓ {t.widget.yes_fill}</span>
          <span className="rounded-[var(--r-12)] py-2 text-center" style={{ background: 'var(--ink-900)' }}>{t.widget.change}</span>
        </span>
      </div>
    </figure>
  );
}
