'use client';

import { useEffect, useState } from 'react';
import { useSettings } from '@/lib/settings';

/** Prepare first so the native share sheet always opens directly from a user gesture. */
export function ShareDocument({ makeFile }: { makeFile: () => File | Promise<File> }) {
  const { t } = useSettings();
  const [supported, setSupported] = useState(false);
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => { setSupported(typeof navigator.share === 'function' && typeof navigator.canShare === 'function'); }, []);
  // A parent re-render can mean answers changed. Never share a stale export.
  useEffect(() => { setFile(undefined); }, [makeFile]);
  if (!supported) return null;
  const prepare = async () => {
    setBusy(true); setError(false);
    try {
      const next = await makeFile();
      if (!navigator.canShare({ files: [next] })) throw new Error('unsupported');
      setFile(next);
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  const share = async () => {
    if (!file) return;
    setBusy(true); setError(false);
    try { await navigator.share({ files: [file] }); }
    catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError')) setError(true); }
    finally { setBusy(false); setFile(undefined); }
  };
  return <div className="grid gap-1">
    <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void (file ? share() : prepare())}>{busy ? t.pwa.share_loading : file ? t.pwa.share_choose_app : t.pwa.share_export}</button>
    {error && <p role="status" className="max-w-xs text-xs text-muted">{t.pwa.share_failed}</p>}
  </div>;
}
