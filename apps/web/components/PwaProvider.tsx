'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useSettings } from '@/lib/settings';

interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
type Platform = 'android' | 'ios' | 'desktop';
interface PwaState {
  installed: boolean; ready: boolean; offline: boolean; platform: Platform; canPrompt: boolean;
  waiting: ServiceWorker | null; installing: boolean; instructions: boolean; error: boolean;
  install(): Promise<void>; update(): void;
}
const Context = createContext<PwaState | null>(null);
const DISMISSED = 'awaazform.installDismissedAt';
const WEEK = 7 * 24 * 60 * 60 * 1000;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || !!(navigator as Navigator & { standalone?: boolean }).standalone;

export function PwaProvider({ children }: { children: ReactNode }) {
  const { t } = useSettings();
  const [installed, setInstalled] = useState(false);
  const [ready, setReady] = useState(false);
  const [offline, setOffline] = useState(false);
  const [platform, setPlatform] = useState<Platform>('desktop');
  const [prompt, setPrompt] = useState<InstallEvent | null>(null);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [installing, setInstalling] = useState(false);
  const [instructions, setInstructions] = useState(false);
  const [error, setError] = useState(false);
  const [dismissed, setDismissed] = useState(true);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const reloadForUpdate = useRef(false);
  const path = usePathname();

  useEffect(() => {
    if (window.top !== window.self) return;
    setInstalled(isStandalone());
    setOffline(!navigator.onLine);
    setPlatform(/android/i.test(navigator.userAgent) ? 'android' : /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'ios' : 'desktop');
    try { setDismissed(Date.now() - Number(localStorage.getItem(DISMISSED) || 0) < WEEK); } catch { setDismissed(false); }
    const online = () => setOffline(!navigator.onLine);
    const beforeInstall = (event: Event) => { event.preventDefault(); setPrompt(event as InstallEvent); };
    const appInstalled = () => {
      setInstalled(true); setPrompt(null); setInstructions(false);
      try { localStorage.removeItem(DISMISSED); } catch { /* Storage may be disabled. */ }
      // Best effort: browser decides whether this origin can keep its existing local data.
      void navigator.storage?.persist?.().catch(() => {});
    };
    const media = matchMedia('(display-mode: standalone)');
    const modeChanged = () => setInstalled(isStandalone());
    window.addEventListener('online', online);
    window.addEventListener('offline', online);
    window.addEventListener('beforeinstallprompt', beforeInstall);
    window.addEventListener('appinstalled', appInstalled);
    media.addEventListener('change', modeChanged);
    let alive = true;
    let registration: ServiceWorkerRegistration | undefined;
    const watchUpdate = () => {
      const worker = registration?.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (!alive || worker.state !== 'installed') return;
        if (navigator.serviceWorker.controller) setWaiting(registration?.waiting ?? null);
        setReady(true);
      });
    };
    const controllerChanged = () => {
      if (reloadForUpdate.current) location.reload();
      else setReady(true);
    };
    const checkUpdate = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void registration?.update().catch(() => {});
    };
    if ('serviceWorker' in navigator && window.isSecureContext && process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.addEventListener('controllerchange', controllerChanged);
      void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then((reg) => {
        if (!alive) return;
        registration = reg;
        setReady(!!reg.active);
        setWaiting(reg.waiting);
        reg.addEventListener('updatefound', watchUpdate);
        watchUpdate();
      }).catch(() => { if (alive) setError(true); });
      document.addEventListener('visibilitychange', checkUpdate);
    }
    return () => {
      alive = false;
      window.removeEventListener('online', online);
      window.removeEventListener('offline', online);
      window.removeEventListener('beforeinstallprompt', beforeInstall);
      window.removeEventListener('appinstalled', appInstalled);
      media.removeEventListener('change', modeChanged);
      navigator.serviceWorker?.removeEventListener('controllerchange', controllerChanged);
      registration?.removeEventListener('updatefound', watchUpdate);
      document.removeEventListener('visibilitychange', checkUpdate);
    };
  }, []);

  const dismiss = () => {
    setDismissed(true); setInstructions(false);
    try { localStorage.setItem(DISMISSED, String(Date.now())); } catch { /* Session-only dismissal still works. */ }
  };
  const install = async () => {
    setError(false);
    if (!prompt) { setInstructions(true); return; }
    setInstalling(true);
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      setPrompt(null);
      if (choice.outcome === 'dismissed') dismiss();
      // appinstalled is the source of truth; accepting a prompt can still fail at OS level.
      else { setDismissed(true); setInstructions(false); }
    } catch { setPrompt(null); setInstructions(true); setError(true); }
    finally { setInstalling(false); }
  };
  const update = () => {
    if (!waiting) return;
    reloadForUpdate.current = true;
    waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
  };
  const value: PwaState = { installed, ready, offline, platform, canPrompt: !!prompt, waiting, installing, instructions, error, install, update };
  const showInstall = !installed && !dismissed && (!!prompt || (ready && platform !== 'desktop'));
  // Keep install invitations out of active filling flows and embedded surfaces.
  const inviteRoute = path === '/' || path === '/settings';
  const showUpdate = !!waiting && !updateDismissed && inviteRoute;
  const banner = path !== '/replica' && (offline || showUpdate || (showInstall && inviteRoute));
  return (
    <Context.Provider value={value}>
      {children}
      {banner && <BottomNotice>
        {offline ? <p role="status" className="text-sm"><strong>{t.pwa.offline_title}</strong><br />{t.pwa.offline_short}</p> : <>
          <img src="/icons/icon-192.png" width="48" height="48" alt="" className="pwa-notice-icon" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{showUpdate ? t.pwa.update_title : t.pwa.install_title}</p>
            <p className="mt-0.5 text-sm text-muted">{showUpdate ? t.pwa.update_body : t.pwa.install_body}</p>
            {!showUpdate && instructions && <p className="mt-2 text-sm" role="status">{installInstructions(platform, t.pwa)}</p>}
          </div>
          <div className="pwa-notice-actions">
            <button type="button" className="btn" disabled={installing} onClick={showUpdate ? update : () => void install()}>
              {showUpdate ? t.pwa.update_action : installing ? t.pwa.installing : t.pwa.install_action}
            </button>
            <button type="button" className="btn-quiet" aria-label={showUpdate ? t.pwa.update_later : t.pwa.install_later}
              onClick={showUpdate ? () => setUpdateDismissed(true) : dismiss}>
              <svg aria-hidden width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>
          </div>
        </>}
      </BottomNotice>}
    </Context.Provider>
  );
}

function installInstructions(platform: Platform, t: ReturnType<typeof useSettings>['t']['pwa']) {
  return platform === 'ios' ? t.install_ios : platform === 'android' ? t.install_android : t.install_desktop;
}

function BottomNotice({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => document.documentElement.style.setProperty('--pwa-bottom', `${element.getBoundingClientRect().height + 24}px`);
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    return () => { observer.disconnect(); document.documentElement.style.removeProperty('--pwa-bottom'); };
  }, []);
  return <aside ref={ref} className="pwa-notice" aria-label={useSettings().t.pwa.app}>{children}</aside>;
}

/** Persistent access in Settings even after the bottom invitation has been dismissed. */
export function PwaSettings() {
  const pwa = useContext(Context);
  const { t } = useSettings();
  if (!pwa) return null;
  return (
    <fieldset className="card grid gap-3 p-6">
      <legend className="px-1 text-lg font-semibold">{t.pwa.app}</legend>
      <div className="flex items-start gap-4">
        <img src="/icons/icon-192.png" width="48" height="48" alt="" className="flex-none rounded-[var(--r-12)]" />
        <div className="min-w-0">
          <p className="font-medium">{pwa.installed ? t.pwa.installed : t.pwa.install_title}</p>
          <p className="mt-1 text-sm text-muted">{t.pwa.capabilities}</p>
        </div>
      </div>
      {!pwa.installed && <button type="button" className="btn w-fit" disabled={pwa.installing || pwa.offline} onClick={() => void pwa.install()}>{pwa.installing ? t.pwa.installing : pwa.canPrompt ? t.pwa.install_action : t.pwa.how_install}</button>}
      {!pwa.installed && pwa.instructions && <p role="status" className="text-sm">{installInstructions(pwa.platform, t.pwa)}</p>}
      <p className="text-sm text-muted" role="status">{pwa.error ? t.pwa.setup_error : pwa.ready ? t.pwa.offline_ready : t.pwa.offline_preparing}</p>
      {pwa.waiting && <div className="grid gap-2"><p className="text-sm">{t.pwa.update_body}</p><button type="button" className="btn btn-ghost w-fit" onClick={pwa.update}>{t.pwa.update_action}</button></div>}
    </fieldset>
  );
}
