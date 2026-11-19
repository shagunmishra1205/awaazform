'use client';

import { useSettings } from '@/lib/settings';

export default function OfflinePage() {
  const { t } = useSettings();
  return (
    <div className="container-x max-w-xl py-16">
      <img src="/icons/icon-192.png" width="64" height="64" alt="" className="mb-5 rounded-[var(--r-16)]" />
      <h1 className="text-3xl">{t.pwa.offline_title}</h1>
      <p className="mt-4 text-muted">{t.pwa.offline_body}</p>
      <div className="mt-6 flex flex-wrap gap-3">
        <button type="button" className="btn" onClick={() => location.reload()}>{t.common.retry}</button>
        <a href="/documents" className="btn btn-ghost">{t.nav.documents}</a>
        <a href="/profiles" className="btn btn-ghost">{t.nav.profiles}</a>
      </div>
    </div>
  );
}
