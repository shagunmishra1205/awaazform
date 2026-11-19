'use client';

import { LANGUAGES, type Language } from '@awaazform/core';
import { useEffect, useState } from 'react';
import { Reveal } from '@/components/Motion';
import { fmt, LANGUAGE_META } from '@/lib/i18n';
import { useSettings, type Settings } from '@/lib/settings';
import { speak } from '@/lib/voice';

// FR-28, FR-47 – FR-49.
export default function SettingsPage() {
  const { settings, update, t } = useSettings();
  const S = t.settings;
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const lang = LANGUAGE_META[settings.language];

  useEffect(() => {
    if (typeof speechSynthesis === 'undefined') return;
    const load = () => setVoices(speechSynthesis.getVoices());
    load();
    speechSynthesis.addEventListener('voiceschanged', load);
    return () => speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);
  const prefix = settings.language;
  const own = voices.filter((v) => v.lang.toLowerCase().startsWith(prefix));
  const listed = own.length ? own : voices.filter((v) => /^(en|hi)/i.test(v.lang));

  return (
    <div className="container-x max-w-2xl py-12">
      <Reveal><h1 className="text-[clamp(1.75rem,3vw,2.5rem)]">{S.title}</h1></Reveal>
      <p className="mt-2 text-muted">{S.lead}</p>

      <div className="mt-8 grid gap-6">
        <fieldset className="card grid gap-3 p-6">
          <legend className="px-1 text-lg font-semibold">{S.language}</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {LANGUAGES.map((l) => (
              <label key={l} lang={l} className={`chip !min-h-12 cursor-pointer !justify-start !px-4 !text-base ${settings.language === l ? 'chip-accent' : ''}`}>
                <input type="radio" name="language" value={l} checked={settings.language === l} onChange={() => update({ language: l as Language })} className="h-4 w-4" />
                <span>{LANGUAGE_META[l].native}</span>
                {l !== 'en' && <span className="text-xs text-muted" lang="en">{LANGUAGE_META[l].english}</span>}
              </label>
            ))}
          </div>
          <p className="text-sm text-muted">{S.language_hint}</p>
        </fieldset>
        <Choice legend={S.contrast} value={settings.contrast} onChange={(v) => update({ contrast: v as Settings['contrast'] })}
          options={[['normal', S.standard], ['high', S.high]]} />
        <Choice legend={S.text} value={settings.text} onChange={(v) => update({ text: v as Settings['text'] })}
          options={[['normal', S.standard], ['large', S.large]]} />
        <Choice legend={S.motion} value={settings.motion} onChange={(v) => update({ motion: v as Settings['motion'] })}
          options={[['system', S.follow], ['reduce', S.reduce]]} hint={S.motion_hint} />

        <Choice legend={S.confirm_title} value={settings.confirmMode} onChange={(v) => update({ confirmMode: v as Settings['confirmMode'] })}
          options={[['end', S.confirm_end], ['each', S.confirm_each]]} hint={S.confirm_hint} />

        <fieldset className="card grid gap-3 p-6">
          <legend className="px-1 text-lg font-semibold">{S.privacy}</legend>
          <label className="flex min-h-11 items-start gap-3">
            <input type="checkbox" className="mt-1 h-5 w-5 flex-none" checked={settings.privacyShield} onChange={(e) => update({ privacyShield: e.target.checked })} />
            <span className="grid gap-1"><span className="font-medium">{S.shield}</span><span className="text-sm text-muted">{S.shield_hint}</span></span>
          </label>
          <p className="text-sm text-muted">{S.storage_hint}</p>
        </fieldset>

        <fieldset className="card grid gap-4 p-6">
          <legend className="px-1 text-lg font-semibold">{S.voice}</legend>
          <label className="grid gap-2 text-sm">
            <span className="font-medium">{fmt(S.speed, { rate: settings.speechRate.toFixed(1) })}</span>
            <input type="range" min={0.6} max={1.6} step={0.1} value={settings.speechRate} onChange={(e) => update({ speechRate: Number(e.target.value) })} className="h-11" />
          </label>
          <label className="grid gap-2 text-sm">
            <span className="font-medium">{S.browser_voice}</span>
            <select className="field-input" value={settings.voiceURI} onChange={(e) => update({ voiceURI: e.target.value })}>
              <option value="">{S.automatic}</option>
              {listed.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>)}
            </select>
            {own.length === 0 && settings.language !== 'en' && (
              <span role="note" className="rounded-[var(--r-12)] p-3 text-xs" style={{ background: 'var(--amber-100)', color: 'var(--amber-700)' }}>
                {fmt(S.no_voices, { language: lang.native })}
              </span>
            )}
          </label>
          <button type="button" className="btn btn-ghost w-fit"
            onClick={() => speak(S.test_phrase, { language: settings.language, rate: settings.speechRate, voiceURI: settings.voiceURI })}>
            {S.test}
          </button>
        </fieldset>
      </div>
    </div>
  );
}

function Choice({ legend, value, onChange, options, hint }: { legend: string; value: string; onChange: (v: string) => void; options: [string, string][]; hint?: string }) {
  return (
    <fieldset className="card grid gap-3 p-6">
      <legend className="px-1 text-lg font-semibold">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map(([v, l]) => (
          <label key={v} className={`chip !min-h-11 cursor-pointer !px-4 !text-sm ${value === v ? 'chip-accent' : ''}`}>
            <input type="radio" name={legend} value={v} checked={value === v} onChange={() => onChange(v)} className="h-4 w-4" /> {l}
          </label>
        ))}
      </div>
      {hint && <p className="text-sm text-muted">{hint}</p>}
    </fieldset>
  );
}
