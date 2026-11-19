// AwaazForm content script: reads the questions on the current form page and fills fields the user has
// confirmed in the side panel. It never presses Submit, never touches password fields, and only acts
// when the side panel asks (after the user's confirmation in AwaazForm).
(() => {
  if (window.__awaazform) return;
  window.__awaazform = true;

  const PLATFORM = /docs\.google\.com$/.test(location.hostname) ? 'google'
    : /^forms\.(office\.com|microsoft\.com|cloud\.microsoft)$/.test(location.hostname) ? 'microsoft' : 'other';

  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

  // React and Google's own handlers listen for input events; set the value through the native setter.
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    el.focus();
    setter ? setter.call(el, value) : (el.value = value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isPassword = (el) => el?.type === 'password' || /password|otp|cvv|pin\b/i.test(el?.autocomplete || '');

  // ---- Google Forms ------------------------------------------------------------------------------
  // Each question carries data-params: "%.@.[id,title,help,type,[[entryId,options,required,…]]…]",
  // the same shape as FB_PUBLIC_LOAD_DATA_, so the web app parses it with the shared Google parser.
  function googleItems() {
    const items = [];
    for (const el of document.querySelectorAll('[data-params]')) {
      const raw = el.getAttribute('data-params') || '';
      const i = raw.indexOf('[');
      if (i < 0) continue;
      // Usually "%.@.[item],"i5","i6",…]": an array whose opening bracket was dropped.
      let item = null;
      for (const src of [`[${raw.slice(i)}`, raw.slice(i)]) {
        try {
          const v = JSON.parse(src);
          item = Array.isArray(v?.[0]) ? v[0] : v;
          break;
        } catch { /* try the other shape */ }
      }
      if (Array.isArray(item) && Array.isArray(item[4])) items.push(item);
    }
    return items;
  }
  // Google's own "collect email" field has no data-params.
  const googleEmail = () => [...document.querySelectorAll('input[type="email"]')].find((el) => !el.closest('[data-params]') && visible(el));
  const googleBox = (entryId) => {
    if (entryId === 'emailAddress') return googleEmail()?.closest('[role="listitem"]') || googleEmail() || null;
    for (const el of document.querySelectorAll('[data-params]')) {
      if ((el.getAttribute('data-params') || '').includes(`[[${entryId},`)) return el.closest('[role="listitem"]') || el;
    }
    return null;
  };

  // ---- Microsoft Forms and ordinary pages: read questions from the DOM ------------------------
  function microsoftQuestions() {
    return [...document.querySelectorAll('[data-automation-id="questionItem"]')].map((item, i) => {
      const label = text(item.querySelector('[data-automation-id="questionTitle"]'))
        .replace(/^\d+\.\s*/, '')
        // Screen-reader hints Microsoft appends to the title.
        .replace(/(Single line text|Multi(ple)? line text|Single choice|Multiple choices?|Date|Rating|Ranking|Likert|Net Promoter Score|File upload|Required to answer)\.?\s*$/i, '')
        .replace(/(Single line text|Multi(ple)? line text|Single choice|Multiple choices?|Date|Rating|Ranking|Likert|Net Promoter Score|File upload|Required to answer)\.?\s*$/i, '')
        .replace(/\s*\*\s*$/, '').replace(/\s*\(\d+ points?\)\s*$/, '').trim() || `Question ${i + 1}`;
      const required = !!item.querySelector('[data-automation-id="requiredStar"]');
      const radios = [...item.querySelectorAll('input[type="radio"]')];
      const checks = [...item.querySelectorAll('input[type="checkbox"]')];
      const area = item.querySelector('textarea');
      const date = item.querySelector('[data-automation-id="dateContainer"] input, input[type="date"]');
      const input = item.querySelector('input[data-automation-id="textInput"], input[type="text"], input:not([type])');
      const combo = item.querySelector('[role="combobox"], [role="listbox"]');
      const key = item.querySelector('[aria-labelledby^="QuestionId_"]')?.getAttribute('aria-labelledby')?.split(' ')[0] || `ms-${i}`;
      item.dataset.awaazKey = key;
      const opt = (els) => els.map((e) => e.value || text(e.closest('[data-automation-id="choiceItem"]'))).filter(Boolean);
      if (radios.length) return { key, label, required, control: 'radio', options: opt(radios) };
      if (checks.length) return { key, label, required, control: 'checkbox', options: opt(checks) };
      if (date) return { key, label, required, control: 'date' };
      if (area) return { key, label, required, control: 'textarea' };
      if (input) return { key, label, required, control: input.type === 'number' ? 'number' : 'text' };
      if (combo) return { key, label, required, control: 'unknown' };
      return { key, label, required, control: 'unknown' };
    });
  }

  function labelFor(el) {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return text(l);
    }
    const wrap = el.closest('label');
    if (wrap) return text(wrap);
    const by = el.getAttribute('aria-labelledby');
    if (by) return by.split(' ').map((id) => text(document.getElementById(id))).join(' ');
    return el.getAttribute('aria-label') || el.placeholder || el.name || '';
  }

  function genericQuestions() {
    const out = [];
    const seenRadio = new Set();
    let n = 0;
    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (!visible(el) || el.disabled || el.readOnly) continue;
      const t = (el.type || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image', 'password', 'search'].includes(t)) continue;
      const key = `g-${++n}`;
      if (t === 'file') {
        // A plain file input: the user picks the file in the widget; we attach it after they confirm.
        el.dataset.awaazKey = key;
        const label = labelFor(el).replace(/\s*\*\s*$/, '') || 'File upload';
        out.push({ key, label, required: el.required, control: 'file', accept: el.accept || '' });
        continue;
      }
      if (t === 'radio') {
        if (!el.name || seenRadio.has(el.name)) continue;
        seenRadio.add(el.name);
        const group = [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)];
        const legend = text(el.closest('fieldset')?.querySelector('legend')) || el.name;
        group.forEach((g) => (g.dataset.awaazKey = key));
        out.push({ key, label: legend, required: group.some((g) => g.required), control: 'radio', options: group.map((g) => labelFor(g) || g.value) });
        continue;
      }
      el.dataset.awaazKey = key;
      const label = labelFor(el).replace(/\s*\*\s*$/, '');
      if (!label) continue;
      if (el instanceof HTMLSelectElement) {
        out.push({ key, label, required: el.required, control: 'select', options: [...el.options].filter((o) => o.value).map((o) => text(o)) });
      } else if (t === 'checkbox') {
        out.push({ key, label, required: el.required, control: 'yesno' });
      } else {
        out.push({ key, label, required: el.required, control: el instanceof HTMLTextAreaElement ? 'textarea' : ['email', 'tel', 'number', 'date', 'time'].includes(t) ? t : 'text' });
      }
    }
    return out;
  }

  function scan() {
    const title = text(document.querySelector('[role="heading"][aria-level="1"], [data-automation-id="formTitle"], h1')) || document.title;
    if (PLATFORM === 'google') {
      const items = googleItems();
      const formId = (location.pathname.match(/\/forms\/(?:u\/\d+\/)?d\/e\/([\w-]+)/) || [])[1] || '';
      if (items.length || googleEmail()) return { platform: 'google', title, url: location.href, formId, items, collectEmail: !!googleEmail() };
    }
    if (PLATFORM === 'microsoft') {
      const questions = microsoftQuestions();
      if (questions.length) return { platform: 'microsoft', title, url: location.href, questions };
    }
    return { platform: 'other', title, url: location.href, questions: genericQuestions() };
  }

  // ---- Writing ---------------------------------------------------------------------------------
  const container = (q) => {
    const s = q.source || {};
    if (s.kind === 'google-form') return googleBox(s.entryId);
    if (s.kind === 'dom') return document.querySelector(`[data-awaaz-key="${CSS.escape(s.key)}"]`);
    return null;
  };

  const optionText = (el) => (el.getAttribute('data-value') || el.getAttribute('data-answer-value') || el.getAttribute('aria-label') || el.value || labelFor(el) || '').trim();

  async function writeGoogle(box, q, value) {
    const want = q.type === 'checkbox' ? splitOptions(value, q.options || []) : [value];
    const radios = [...box.querySelectorAll('[role="radio"]')];
    if (radios.length) {
      const r = radios.find((x) => optionText(x) === value);
      if (!r) throw new Error(`Option “${value}” is not on the page`);
      if (r.getAttribute('aria-checked') !== 'true') r.click();
      return;
    }
    const checks = [...box.querySelectorAll('[role="checkbox"]')];
    if (checks.length) {
      for (const c of checks) {
        const on = c.getAttribute('aria-checked') === 'true';
        if (on !== want.includes(optionText(c))) { c.click(); await sleep(60); }
      }
      return;
    }
    const listbox = box.querySelector('[role="listbox"]');
    if (listbox) {
      listbox.click();
      await sleep(250);
      const opt = [...document.querySelectorAll('[role="option"]')].find((o) => optionText(o) === value && visible(o));
      if (!opt) throw new Error(`Option “${value}” is not on the page`);
      opt.click();
      await sleep(250);
      return;
    }
    const date = box.querySelector('input[type="date"]');
    if (date) return setNativeValue(date, value);
    if (q.type === 'time') {
      const [h, m] = value.split(':');
      const nums = [...box.querySelectorAll('input')].filter(visible);
      if (nums.length >= 2) { setNativeValue(nums[0], String(Number(h))); setNativeValue(nums[1], m); return; }
    }
    const field = box.matches('input') ? box : box.querySelector('textarea, input[type="text"], input[type="email"], input[type="number"], input[type="tel"], input[type="url"], input:not([type])');
    if (!field || isPassword(field)) throw new Error('No text field found for this question');
    setNativeValue(field, value);
  }

  /** Attaches a file the user chose in the widget, the way a person picking it would. */
  function attachFile(box, file) {
    const input = box.matches('input[type="file"]') ? box : box.querySelector('input[type="file"]');
    if (!input) throw new Error('No file field found for this question');
    const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], file.name, { type: file.type || 'application/octet-stream', lastModified: Date.now() }));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function writeDom(box, q, value) {
    const want = q.type === 'checkbox' ? splitOptions(value, q.options || []) : [value];
    const radios = box.matches('input[type="radio"]')
      ? [...document.querySelectorAll(`input[type="radio"][data-awaaz-key="${CSS.escape(q.source.key)}"]`)]
      : [...box.querySelectorAll('input[type="radio"]')];
    if (radios.length) {
      const r = radios.find((x) => optionText(x) === value || x.value === value);
      if (!r) throw new Error(`Option “${value}” is not on the page`);
      r.click();
      return;
    }
    const checks = box.matches('input[type="checkbox"]') ? [box] : [...box.querySelectorAll('input[type="checkbox"]')];
    if (checks.length === 1 && q.type === 'yesno') {
      if (checks[0].checked !== (value === 'Yes')) checks[0].click();
      return;
    }
    if (checks.length) {
      for (const c of checks) if (c.checked !== want.includes(optionText(c) || c.value)) { c.click(); await sleep(40); }
      return;
    }
    const select = box.matches('select') ? box : box.querySelector('select');
    if (select) {
      const o = [...select.options].find((x) => text(x) === value || x.value === value);
      if (!o) throw new Error(`Option “${value}” is not in the list`);
      return setNativeValue(select, o.value);
    }
    const field = box.matches('input, textarea') ? box : box.querySelector('textarea, input');
    if (!field || isPassword(field)) throw new Error('No text field found for this question');
    let v = value;
    if (field.type !== 'date' && q.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [y, m, d] = value.split('-');
      // Microsoft's date box takes the form's locale order; US forms read M/D/YYYY.
      v = PLATFORM === 'microsoft' ? `${Number(m)}/${Number(d)}/${y}` : `${d}/${m}/${y}`;
    }
    setNativeValue(field, v);
  }

  function splitOptions(value, options) {
    const out = [];
    let rest = value;
    const byLength = [...options].sort((a, b) => b.length - a.length);
    while (rest) {
      const hit = byLength.find((o) => rest === o || rest.startsWith(`${o}, `));
      if (!hit) return value.split(', ');
      out.push(hit);
      rest = rest.slice(hit.length).replace(/^, /, '');
    }
    return out;
  }

  // ---- Reading back (verification) ----------------------------------------------------------
  function read(q) {
    const box = container(q);
    if (!box) return null;
    if (q.type === 'file') {
      const input = box.matches('input[type="file"]') ? box : box.querySelector('input[type="file"]');
      return input?.files?.[0]?.name ?? '';
    }
    if (q.source.kind === 'google-form') {
      const radio = box.querySelector('[role="radio"][aria-checked="true"]');
      if (radio) return optionText(radio);
      const checks = [...box.querySelectorAll('[role="checkbox"][aria-checked="true"]')];
      if (box.querySelector('[role="checkbox"]')) return checks.map(optionText).join(', ');
      const sel = box.querySelector('[role="option"][aria-selected="true"]');
      if (box.querySelector('[role="listbox"]')) return sel ? optionText(sel) : '';
      if (q.type === 'time') {
        const nums = [...box.querySelectorAll('input')].filter(visible);
        if (nums.length >= 2) return `${String(nums[0].value).padStart(2, '0')}:${String(nums[1].value).padStart(2, '0')}`;
      }
      const f = box.matches('input') ? box : box.querySelector('input[type="date"], textarea, input[type="text"], input[type="email"], input[type="number"], input[type="tel"], input[type="url"], input:not([type])');
      return f ? f.value : null;
    }
    const radios = box.matches('input[type="radio"]') ? [...document.querySelectorAll(`input[type="radio"][data-awaaz-key="${CSS.escape(q.source.key)}"]`)] : [...box.querySelectorAll('input[type="radio"]')];
    if (radios.length) { const r = radios.find((x) => x.checked); return r ? (optionText(r) || r.value) : ''; }
    const checks = box.matches('input[type="checkbox"]') ? [box] : [...box.querySelectorAll('input[type="checkbox"]')];
    if (checks.length === 1 && q.type === 'yesno') return checks[0].checked ? 'Yes' : 'No';
    if (checks.length) return checks.filter((c) => c.checked).map((c) => optionText(c) || c.value).join(', ');
    const select = box.matches('select') ? box : box.querySelector('select');
    if (select) return text(select.selectedOptions[0]);
    const field = box.matches('input, textarea') ? box : box.querySelector('textarea, input');
    if (!field) return null;
    const v = field.value;
    // Report dates back in the session's ISO form, so verification compares like with like.
    const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (q.type === 'date' && us) {
      const [m, d] = PLATFORM === 'microsoft' ? [us[1], us[2]] : [us[2], us[1]];
      return `${us[3]}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    return v;
  }

  let styled = false;
  function focus(q) {
    const box = container(q);
    if (!box) return;
    if (!styled) {
      const style = document.createElement('style');
      style.textContent = '.awaazform-focus{outline:3px solid #624de3!important;outline-offset:4px;border-radius:8px;transition:outline-color .4s}';
      (document.head || document.documentElement).appendChild(style);
      styled = true;
    }
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
    box.classList.add('awaazform-focus');
    setTimeout(() => box.classList.remove('awaazform-focus'), 1600);
  }


  // ---- The widget: an extension iframe in a closed shadow root, so page styles and scripts can't reach it.
  let host = null;
  let frame = null;
  function mountWidget(open) {
    if (host) return;
    host = document.createElement('div');
    host.id = 'awaazform-widget';
    host.style.cssText = 'all:initial;position:fixed;bottom:16px;right:16px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL(`widget.html${open ? '#open' : ''}`);
    frame.title = 'AwaazForm';
    frame.allow = 'microphone; clipboard-write';
    frame.style.cssText = 'border:0;background:transparent;color-scheme:normal;width:84px;height:84px;display:block;transition:width .25s ease,height .25s ease;';
    root.appendChild(frame);
    document.documentElement.appendChild(host);
  }
  function unmountWidget() {
    host?.remove();
    host = frame = null;
  }
  // On form sites Bolu waits in the corner; elsewhere he appears when the toolbar button is clicked.
  if (PLATFORM !== 'other') {
    const tryMount = () => (scan().items?.length || scan().questions?.length) && mountWidget(false);
    document.readyState === 'complete' ? tryMount() : window.addEventListener('load', () => setTimeout(tryMount, 300), { once: true });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (!msg || msg.awaazform !== true) return;
    if (msg.type === 'ping') return respond({ ok: true });
    if (msg.type === 'toggle') { host ? unmountWidget() : mountWidget(true); return respond({ ok: true }); }
    if (msg.type === 'resize') {
      if (frame) { frame.style.width = `${Math.min(msg.w, innerWidth - 24)}px`; frame.style.height = `${Math.min(msg.h, innerHeight - 24)}px`; }
      return respond({ ok: true });
    }
    if (msg.type === 'remove') { unmountWidget(); return respond({ ok: true }); }
    (async () => {
      try {
        switch (msg.type) {
          case 'scan': return respond({ ok: true, result: scan() });
          case 'write': {
            const box = container(msg.question);
            if (!box) throw new Error('This question isn’t on the current page. Go to its page on the form (Next/Back), then try again.');
            if (msg.question.type === 'file') {
              if (!msg.file) throw new Error('No file was sent');
              attachFile(box, msg.file);
            } else {
              await (msg.question.source.kind === 'google-form' ? writeGoogle(box, msg.question, msg.value) : writeDom(box, msg.question, msg.value));
            }
            await sleep(120);
            return respond({ ok: true });
          }
          case 'read': return respond({ ok: true, result: read(msg.question) });
          case 'focus': focus(msg.question); return respond({ ok: true });
          default: return respond({ ok: false, error: 'Unknown request' });
        }
      } catch (err) {
        respond({ ok: false, error: err.message });
      }
    })();
    return true;
  });
})();
