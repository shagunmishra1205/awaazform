'use client';

import type { CanonicalKey, Profile } from '@awaazform/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { Dialog } from '@/components/Dialog';
import { Reveal } from '@/components/Motion';
import { createProfile, db, deleteProfile, ensureDefaultProfile, forgetAll, forgetProfileValues, forgetValue, renameProfile } from '@/lib/db';
import { fmt, localizeMessage, Rich } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';
import { passkeysSupported } from '@/lib/passkey';
import { enrolPasskey, forgetPasskey, hasPasskey, isUnlocked, lock, onVaultChange, readValues, removePassphrase, setPassphrase, unlock, unlockWithPasskey } from '@/lib/vault';

// FR-30 – FR-36: profiles, saved values with sources, per-item delete, forget everything, passphrase lock.
export default function ProfilesPage() {
  const { t } = useSettings();
  const P = t.profiles;
  useEffect(() => void ensureDefaultProfile(), []);
  const profiles = useLiveQuery(() => db.profiles.orderBy('createdAt').toArray(), []);
  const [newLabel, setNewLabel] = useState('');
  const [, tick] = useState(0);
  useEffect(() => onVaultChange(() => tick((n) => n + 1)), []);

  return (
    <div className="container-x max-w-3xl py-12">
      <Reveal>
        <h1 className="text-[clamp(1.75rem,3vw,2.5rem)]">{P.title}</h1>
        <p className="mt-2 max-w-xl text-muted">{P.lead}</p>
      </Reveal>

      <form className="composer mt-8" onSubmit={async (e) => { e.preventDefault(); if (newLabel.trim()) { await createProfile(newLabel); setNewLabel(''); } }}>
        <label htmlFor="new-profile" className="sr-only">{P.new_label}</label>
        <input id="new-profile" placeholder={P.new_placeholder} value={newLabel} onChange={(e) => setNewLabel(e.target.value)} maxLength={60} />
        <button className="btn flex-none" type="submit" disabled={!newLabel.trim()}>{P.add}</button>
      </form>

      <div className="mt-8 grid gap-6">
        {profiles?.map((p) => <ProfileCard key={p.id} p={p} />)}
      </div>

      <section className="mt-12 flex flex-wrap items-center justify-between gap-4 rounded-[var(--r-16)] border p-5" style={{ borderColor: 'var(--red-600)' }} aria-labelledby="forget-h">
        <div>
          <h2 id="forget-h" className="text-lg">{P.forget_all_title}</h2>
          <p className="mt-1 text-sm text-muted">{P.forget_all_body}</p>
        </div>
        <button type="button" className="btn btn-danger"
          onClick={async () => { if (confirm(P.forget_all_confirm)) { await forgetAll(); await ensureDefaultProfile(); } }}>
          {P.forget_all_title}
        </button>
      </section>
    </div>
  );
}

function ProfileCard({ p }: { p: Profile }) {
  const { t } = useSettings();
  const P = t.profiles;
  const [label, setLabel] = useState(p.label);
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Partial<Record<CanonicalKey, string>> | null>(null);
  const [dialog, setDialog] = useState<null | 'set' | 'unlock' | 'passkey'>(null);
  const [pkError, setPkError] = useState<string | null>(null);
  const [canPasskey, setCanPasskey] = useState(false);
  useEffect(() => setCanPasskey(passkeysSupported()), []);
  const unlocked = isUnlocked(p);
  const fields = Object.values(p.fields).filter(Boolean);

  useEffect(() => {
    let live = true;
    readValues(p).then((v) => live && setValues(v));
    return () => { live = false; };
  }, [p, unlocked]);

  return (
    <section aria-labelledby={`p-${p.id}`} className="card grid gap-5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {editing ? (
          <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); await renameProfile(p.id, label); setEditing(false); }}>
            <label htmlFor={`rn-${p.id}`} className="sr-only">{P.name}</label>
            <input id={`rn-${p.id}`} className="field-input !min-h-11 !w-48 !py-1" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} autoFocus />
            <button type="submit" className="btn">{t.common.save}</button>
          </form>
        ) : (
          <h2 id={`p-${p.id}`} className="flex items-center gap-2 text-xl">
            <span aria-hidden className="grid h-9 w-9 place-items-center rounded-full text-sm font-semibold text-white" style={{ background: 'linear-gradient(135deg, var(--violet-500), var(--magenta-500))' }}>
              {p.label.slice(0, 1).toUpperCase()}
            </span>
            {p.label}
            {p.encrypted && <span className={`chip ${unlocked ? 'chip-ok' : 'chip-accent'}`}>{unlocked ? P.unlocked : P.locked}</span>}
          </h2>
        )}
        <div className="flex flex-wrap gap-1">
          {!editing && <button type="button" className="btn-quiet" onClick={() => setEditing(true)}>{P.rename}</button>}
          {!p.encrypted && <button type="button" className="btn-quiet" onClick={() => setDialog('set')}>{P.add_pass}</button>}
          {p.encrypted && !unlocked && hasPasskey(p) && (
            <button type="button" className="btn" onClick={async () => { setPkError(null); try { if (!(await unlockWithPasskey(p))) setPkError(P.passkey_failed); } catch { setPkError(P.passkey_failed); } }}>{P.passkey_unlock}</button>
          )}
          {p.encrypted && !unlocked && <button type="button" className={hasPasskey(p) ? 'btn btn-ghost' : 'btn'} onClick={() => setDialog('unlock')}>{P.unlock}</button>}
          {p.encrypted && unlocked && (
            <>
              <button type="button" className="btn-quiet" onClick={() => lock(p.id)}>{P.lock_now}</button>
              {canPasskey && !hasPasskey(p) && <button type="button" className="btn-quiet" onClick={() => setDialog('passkey')}>{P.passkey_add}</button>}
              {hasPasskey(p) && (
                <button type="button" className="btn-quiet" onClick={async () => { if (confirm(fmt(P.passkey_remove_confirm, { name: p.label }))) await forgetPasskey(p); }}>{P.passkey_remove}</button>
              )}
              <button type="button" className="btn-quiet" onClick={async () => { if (confirm(fmt(P.remove_pass_confirm, { name: p.label }))) await removePassphrase(p); }}>{P.remove_pass}</button>
            </>
          )}
        </div>
      </div>

      {pkError && <p role="alert" className="text-sm font-medium" style={{ color: 'var(--red-600)' }}>{pkError}</p>}
      {p.encrypted && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {hasPasskey(p) && <span className="chip chip-ok">{P.passkey_on}</span>}
          {P.auto_lock}
        </p>
      )}
      {fields.length === 0 ? (
        <p className="rounded-[var(--r-12)] p-4 text-sm text-muted" style={{ background: 'var(--bg-subtle)' }}>
          {P.empty}
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-[var(--r-16)] border border-line bg-surface">
          {fields.map((f) => f && (
            <li key={f.key} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-xs text-muted capitalize">{t.keys[f.key]}</p>
                <p className="font-medium break-all">{values ? values[f.key] : '••••••••'}</p>
                <p className="text-xs text-muted">{fmt(P.from, { sources: f.sources.join(', '), date: new Date(f.confirmedAt).toLocaleDateString() })}</p>
              </div>
              <button type="button" className="btn-quiet flex-none" onClick={() => forgetValue(p.id, f.key as CanonicalKey)} aria-label={fmt(P.delete_saved, { key: t.keys[f.key] })}>{t.common.delete}</button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-1 border-t border-line pt-3">
        <button type="button" className="btn-quiet" disabled={fields.length === 0}
          onClick={async () => { if (confirm(fmt(P.forget_for_confirm, { name: p.label }))) await forgetProfileValues(p.id); }}>
          {fmt(P.forget_for, { name: p.label })}
        </button>
        {p.id !== 'me' && (
          <button type="button" className="btn-quiet" style={{ color: 'var(--red-600)' }} onClick={async () => { if (confirm(fmt(P.delete_profile_confirm, { name: p.label }))) await deleteProfile(p.id); }}>
            {P.delete_profile}
          </button>
        )}
      </div>

      <PassphraseDialog mode={dialog} profile={p} onClose={() => setDialog(null)} />
    </section>
  );
}

function PassphraseDialog({ mode, profile, onClose }: { mode: null | 'set' | 'unlock' | 'passkey'; profile: Profile; onClose: () => void }) {
  const { t } = useSettings();
  const P = t.profiles;
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => { setA(''); setB(''); setError(null); onClose(); };

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      if (mode === 'set') {
        if (a.length < 8) return setError(P.too_short);
        if (a !== b) return setError(P.mismatch);
        await setPassphrase(profile, a);
        close();
      } else if (mode === 'unlock') {
        if (await unlock(profile, a)) close();
        else setError(P.wrong);
      } else if (mode === 'passkey') {
        await enrolPasskey(profile, a);
        close();
      }
    } catch (err) {
      setError(mode === 'passkey' ? `${P.passkey_failed} ${localizeMessage(t, (err as Error).message)}` : localizeMessage(t, (err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={mode !== null} onClose={close} title={fmt(mode === 'set' ? P.pass_set_title : mode === 'passkey' ? P.passkey_title : P.pass_unlock_title, { name: profile.label })}
      footer={<>
        <button type="button" className="btn btn-ghost" onClick={close}>{t.common.cancel}</button>
        <button type="button" className="btn" onClick={submit} disabled={busy || !a}>{mode === 'set' ? P.protect : mode === 'passkey' ? P.passkey_continue : P.unlock}</button>
      </>}>
      {mode === 'set' && <p><Rich text={P.pass_set_body} /></p>}
      {mode === 'passkey' && <p>{P.passkey_body}</p>}
      <label className="grid gap-1.5">
        <span className="font-medium">{P.passphrase}</span>
        <input type="password" className="field-input" value={a} onChange={(e) => setA(e.target.value)} autoComplete={mode === 'set' ? 'new-password' : 'current-password'}
          onKeyDown={(e) => e.key === 'Enter' && mode !== 'set' && void submit()} aria-invalid={!!error} aria-describedby={error ? `pp-err-${profile.id}` : undefined} />
      </label>
      {mode === 'set' && (
        <label className="grid gap-1.5">
          <span className="font-medium">{P.again}</span>
          <input type="password" className="field-input" value={b} onChange={(e) => setB(e.target.value)} autoComplete="new-password" onKeyDown={(e) => e.key === 'Enter' && void submit()} />
        </label>
      )}
      {error && <p id={`pp-err-${profile.id}`} role="alert" className="font-medium" style={{ color: 'var(--red-600)' }}>{error}</p>}
    </Dialog>
  );
}
