import { Fragment, type ReactNode } from 'react';
import { fmt } from './core';

export * from './core';
export { loadStrings } from './load';

/**
 * Renders the small markup translations may carry: <b>, <code> and <br/>. Anything else is shown as
 * plain text, so a translation can never inject HTML.
 */
export function Rich({ text, params }: { text: string; params?: Record<string, string | number> }): ReactNode {
  const s = params ? fmt(text, params) : text;
  const out: ReactNode[] = [];
  const re = /<b>([\s\S]*?)<\/b>|<code>([\s\S]*?)<\/code>|<br\s*\/?>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(<Fragment key={i++}>{s.slice(last, m.index)}</Fragment>);
    if (m[1] !== undefined) out.push(<b key={i++}>{m[1]}</b>);
    else if (m[2] !== undefined) out.push(<code key={i++} className="font-mono">{m[2]}</code>);
    else out.push(<br key={i++} />);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(<Fragment key={i++}>{s.slice(last)}</Fragment>);
  return <>{out}</>;
}

