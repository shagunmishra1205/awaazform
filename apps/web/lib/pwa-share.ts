'use client';

export interface SharedContent { file?: File; url?: string; text?: string; title?: string; error?: string }

export async function sharedContent(type: 'READ_SHARE' | 'DELETE_SHARE', id: string): Promise<SharedContent> {
  if (!('serviceWorker' in navigator)) throw new Error('unavailable');
  const worker = navigator.serviceWorker.controller;
  if (!worker) throw new Error('unavailable');
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => { channel.port1.close(); reject(new Error('unavailable')); }, 8000);
    channel.port1.onmessage = ({ data }: MessageEvent<SharedContent>) => {
      clearTimeout(timeout);
      channel.port1.close();
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    };
    worker.postMessage({ type, id }, [channel.port2]);
  });
}

/** Extract a supported form link without fetching anything or trusting a shared title. */
export function sharedFormUrl(content: SharedContent): string | null {
  const candidates = `${content.url || ''} ${content.text || ''}`.match(/https:\/\/[^\s<>"']+/gi) || [];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate.replace(/[),.;]+$/, ''));
      if (url.username || url.password || (url.port && url.port !== '443')) continue;
      if ((url.hostname === 'docs.google.com' && url.pathname.startsWith('/forms/')) || url.hostname === 'forms.gle' ||
        ['forms.office.com', 'forms.microsoft.com', 'forms.cloud.microsoft'].includes(url.hostname)) return url.href;
    } catch { /* Ignore malformed shared text. */ }
  }
  return null;
}
