'use client';

import { useEffect, useState } from 'react';
import { useSettings } from '@/lib/settings';
import { sharedContent, sharedFormUrl, type SharedContent } from '@/lib/pwa-share';
import { putFile } from '@/lib/secure-store';

export default function SharePage() {
  const { t } = useSettings();
  const P = t.pwa;
  const [content, setContent] = useState<SharedContent>();
  const [error, setError] = useState('');
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const key = params.get('id');
    if (!key) { setError(params.get('error') || 'type'); return; }
    setId(key);
    void sharedContent('READ_SHARE', key).then(setContent).catch(() => setError('unavailable'));
  }, []);
  const url = content && sharedFormUrl(content);
  const file = content?.file instanceof File ? content.file : undefined;
  const unsupported = !!content && !file && !url;
  const message = error === 'large' ? P.share_large : error === 'multiple' ? P.share_multiple : error === 'type' || unsupported ? P.share_type : P.share_unavailable;
  const open = async () => {
    setBusy(true);
    try {
      if (file) {
        await putFile({ id: `shared-${id}`, name: file.name, bytes: await file.arrayBuffer(), plan: { type: file.type }, createdAt: new Date().toISOString() });
      }
      await sharedContent('DELETE_SHARE', id);
      location.replace(file ? `/documents?shared=${id}` : `/form?shared=${encodeURIComponent(url!)}`);
    } catch { setError('unavailable'); setBusy(false); }
  };
  return (
    <div className="container-x max-w-xl py-12">
      <img src="/icons/icon-192.png" width="64" height="64" alt="" className="mb-5 rounded-[var(--r-16)]" />
      <h1 className="text-3xl">{P.share_title}</h1>
      <p className="mt-3 text-muted">{P.share_note}</p>
      {error || unsupported ? <p role="alert" className="mt-6">{message}</p> : !content ? <p role="status" className="mt-6">{P.share_loading}</p> : (
        <div className="mt-6 grid gap-4">
          <p className="rounded-[var(--r-12)] border border-line p-4 font-medium break-all">{file?.name || url}</p>
          <p className="text-sm text-muted">{P.share_review}</p>
          <button type="button" className="btn w-fit" disabled={busy} onClick={() => void open()}>{busy ? P.share_loading : P.share_open}</button>
        </div>
      )}
      <button type="button" className="btn-quiet mt-4" disabled={busy} onClick={() => {
        setBusy(true);
        void (id ? sharedContent('DELETE_SHARE', id).catch(() => {}) : Promise.resolve()).then(() => location.replace('/'));
      }}>{t.common.cancel}</button>
    </div>
  );
}
