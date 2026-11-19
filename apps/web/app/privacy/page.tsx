'use client';

import type { ReactNode } from 'react';
import { Reveal } from '@/components/Motion';
import { Rich } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';

// PRD §7, §9.2, §9.4. Keep this page in step with the actual data flows.
export default function PrivacyPage() {
  const { t } = useSettings();
  const P = t.privacy;
  const items = (...xs: string[]) => xs.map((x, i) => <li key={i}><Rich text={x} /></li>);
  return (
    <div className="container-x max-w-3xl py-12">
      <Reveal><h1 className="text-[clamp(1.75rem,3vw,2.5rem)]">{P.title}</h1></Reveal>
      <p className="mt-3 text-muted">{P.lead}</p>
      <Section title={P.stored_title}>{items(P.stored_1, P.stored_2, P.stored_3, P.stored_4)}</Section>
      <Section title={P.never_title}>{items(P.never_1, P.never_2, P.never_3, P.never_4)}</Section>
      <Section title={P.groq_title}>
        {items(P.groq_1, P.groq_2, P.groq_3, P.groq_4, P.groq_5)}
        <li><a className="underline" href="https://groq.com/privacy-policy/" rel="noreferrer">{P.groq_policy}</a></li>
      </Section>
      <Section title={P.security_title}>{items(P.security_1, P.security_2, P.security_3, P.security_4, P.security_5)}</Section>
      <Section title={P.server_title}>{items(P.server_1, P.server_2, P.server_3, P.server_4)}</Section>
      <Section title={P.live_title}>{items(P.live_1)}</Section>
      <Section title={P.ext_title}>{items(P.ext_1)}</Section>
      <Section title={P.delete_title}>{items(P.delete_1)}</Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="mb-3 text-xl">{title}</h2>
      <ul className="grid list-disc gap-2 ps-5 text-sm leading-relaxed">{children}</ul>
    </section>
  );
}
