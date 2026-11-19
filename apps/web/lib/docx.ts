'use client';

// Word (.docx) forms, entirely in the browser. A .docx is a zip; the text lives in word/document.xml.
// AwaazForm finds the places a person writes — content controls, "Name: ______" blanks, ☐ option
// boxes, and empty table cells next to a label — and fills them in the XML. Nothing is uploaded.

import { classifySupport, formatDate, guessFieldType, normalizeDate, type FieldType, type FormQuestion, type RawControl } from '@awaazform/core';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
export const MAX_DOCX_BYTES = 10 * 1024 * 1024;

const BLANK = /_{4,}|\.{6,}|…{3,}/g;
const BOX = /[☐□❑▢]/g;
const BOX_CHECKED = '☒';
const BOX_EMPTY = '☐';

type SlotRef =
  | { kind: 'sdt'; el: Element; checkbox: boolean }
  | { kind: 'blank'; run: Element }
  | { kind: 'cell'; tc: Element }
  | { kind: 'boxes'; boxes: { option: string; run: Element }[] };

export interface DocxSlot {
  id: string;
  label: string;
  type: FieldType;
  options?: string[];
  kind: SlotRef['kind'];
}

/** What the preview draws: paragraphs and tables of text runs and slot markers. */
export type Part = { text: string } | { slot: string; option?: string };
export type Block = { kind: 'p'; parts: Part[]; heading: boolean } | { kind: 'table'; rows: Part[][][] };

export interface DocxPlan {
  fileName: string;
  title: string;
  slots: DocxSlot[];
  blocks: Block[];
}

const els = (root: Element | Document, local: string) => Array.from(root.getElementsByTagNameNS(W, local));
const kids = (el: Element, local?: string) => Array.from(el.children).filter((c) => c.namespaceURI === W && (!local || c.localName === local));
const child = (el: Element, local: string) => kids(el, local)[0];
const attr = (el: Element | undefined, local: string) => el?.getAttributeNS(W, local) ?? el?.getAttribute(`w:${local}`) ?? null;
const textOf = (el: Element) => els(el, 't').map((t) => t.textContent ?? '').join('');
const cleanLabel = (s: string) =>
  s.replace(BLANK, ' ').replace(BOX, ' ').replace(/\s+/g, ' ').replace(/^[\d.()a-z]{1,4}[.)]\s+/i, '').replace(/[\s:：\-–—]+$/u, '').trim();

/** Splits a run into several runs, one per piece, keeping its formatting. Returns the new runs. */
function splitRun(run: Element, pieces: string[]): Element[] {
  const doc = run.ownerDocument;
  const rPr = child(run, 'rPr');
  const out = pieces.map((p) => {
    const r = doc.createElementNS(W, 'w:r');
    if (rPr) r.appendChild(rPr.cloneNode(true));
    const t = doc.createElementNS(W, 'w:t');
    t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
    t.textContent = p;
    r.appendChild(t);
    return r;
  });
  out.forEach((r) => run.parentNode!.insertBefore(r, run));
  run.parentNode!.removeChild(run);
  return out;
}

function setRunText(run: Element, text: string) {
  const ts = els(run, 't');
  if (ts.length === 0) {
    const t = run.ownerDocument.createElementNS(W, 'w:t');
    run.appendChild(t);
    ts.push(t);
  }
  ts[0]!.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
  ts[0]!.textContent = text;
  ts.slice(1).forEach((t) => t.parentNode?.removeChild(t));
}

function newRun(doc: Document, text: string, underline = false): Element {
  const r = doc.createElementNS(W, 'w:r');
  if (underline) {
    const rPr = doc.createElementNS(W, 'w:rPr');
    const u = doc.createElementNS(W, 'w:u');
    u.setAttributeNS(W, 'w:val', 'single');
    rPr.appendChild(u);
    r.appendChild(rPr);
  }
  setRunText(r, text);
  return r;
}

export class DocxDoc {
  private files: Record<string, Uint8Array>;
  private doc: Document;
  private refs = new Map<string, SlotRef>();
  private slotType = new Map<string, FieldType>();
  /** Runs AwaazForm added (empty cells), so a second write replaces rather than appends. */
  private added = new Map<string, Element>();
  readonly plan: DocxPlan;

  private constructor(bytes: ArrayBuffer, fileName: string) {
    this.files = unzipSync(new Uint8Array(bytes));
    const xml = this.files['word/document.xml'];
    if (!xml) throw new Error('This file has no Word document inside. Is it a .docx?');
    this.doc = new DOMParser().parseFromString(strFromU8(xml), 'application/xml');
    if (this.doc.getElementsByTagName('parsererror').length) throw new Error('This Word document could not be read.');
    this.plan = this.analyze(fileName);
  }

  /** Opens a .docx. Throws with a plain-language message if it can't. */
  static open(bytes: ArrayBuffer, fileName: string): DocxDoc {
    const head = new Uint8Array(bytes.slice(0, 4));
    if (head[0] === 0xd0 && head[1] === 0xcf) throw new Error('This is an older .doc file. Open it in Word and save it as .docx, then try again.');
    if (head[0] !== 0x50 || head[1] !== 0x4b) throw new Error('This doesn’t look like a Word (.docx) file.');
    return new DocxDoc(bytes, fileName);
  }

  // ---- Finding the places to write ---------------------------------------------------------

  private analyze(fileName: string): DocxPlan {
    const body = els(this.doc, 'body')[0];
    if (!body) throw new Error('This Word document is empty.');
    const slots: DocxSlot[] = [];
    const blocks: Block[] = [];
    let lastText = '';
    let n = 0;
    const add = (label: string, type: FieldType, ref: SlotRef, options?: string[]) => {
      const id = `d${++n}`;
      const l = cleanLabel(label) || `Blank ${n}`;
      this.refs.set(id, ref);
      this.slotType.set(id, type);
      slots.push({ id, label: l.slice(0, 160), type, options, kind: ref.kind });
      return id;
    };

    const paragraph = (p: Element, inCell = false): Part[] => {
      const parts: Part[] = [];
      let before = '';
      const runsOf = (el: Element): Element[] =>
        kids(el).flatMap((c) => (c.localName === 'r' ? [c] : c.localName === 'hyperlink' || c.localName === 'smartTag' || c.localName === 'ins' ? runsOf(c) : c.localName === 'sdt' ? [c] : []));

      // Option boxes: "Gender: ☐ Male ☐ Female". One question, one run per box.
      const full = textOf(p);
      const boxCount = (full.match(BOX) ?? []).length;
      if (boxCount >= 2 && !els(p, 'sdt').length) {
        for (const r of runsOf(p)) {
          const t = textOf(r);
          if (r.localName === 'r' && BOX.test(t) && t.length > 1) splitRun(r, t.split(/([☐□❑▢])/).filter(Boolean));
          BOX.lastIndex = 0;
        }
        const boxes: { option: string; run: Element }[] = [];
        let label = '';
        let current: { option: string; run: Element } | null = null;
        const items: Part[] = [];
        for (const r of runsOf(p)) {
          const t = textOf(r);
          if (/^[☐□❑▢]$/.test(t)) {
            current = { option: '', run: r };
            boxes.push(current);
            items.push({ slot: '', option: String(boxes.length - 1) });
          } else if (current) {
            current.option += t;
            items.push({ text: t });
          } else {
            label += t;
            items.push({ text: t });
          }
        }
        boxes.forEach((b) => (b.option = b.option.replace(/\s+/g, ' ').trim()));
        const valid = boxes.filter((b) => b.option);
        if (valid.length >= 2) {
          const id = add(label || lastText, valid.length === 2 && /^(yes|हाँ|हो)$/i.test(valid[0]!.option) ? 'yesno' : 'choice', { kind: 'boxes', boxes: valid }, valid.map((b) => b.option));
          return items.map((it) => ('slot' in it ? { slot: id, option: boxes[Number(it.option)]?.option } : it));
        }
      }

      for (const r of runsOf(p)) {
        if (r.localName === 'sdt') {
          const id = this.contentControl(r, before || lastText, add);
          if (id) { parts.push({ slot: id }); before = ''; continue; }
          const t = textOf(r);
          parts.push({ text: t });
          before += t;
          continue;
        }
        const t = kids(r).map((c) => (c.localName === 't' ? c.textContent ?? '' : c.localName === 'tab' ? '\t' : '')).join('');
        BLANK.lastIndex = 0;
        if (!BLANK.test(t)) { parts.push({ text: t }); before += t; continue; }
        // Each blank gets its own run, so it can be written on its own.
        const pieces = t.split(/(_{4,}|\.{6,}|…{3,})/).filter(Boolean);
        const runs = pieces.length > 1 ? splitRun(r, pieces) : [r];
        pieces.forEach((piece, i) => {
          BLANK.lastIndex = 0;
          if (/^(_{4,}|\.{6,}|…{3,})$/.test(piece)) {
            const label = cleanLabel(before) || (inCell ? '' : cleanLabel(lastText));
            const id = add(label, guessFieldType(label), { kind: 'blank', run: runs[i]! });
            parts.push({ slot: id });
            before = '';
          } else {
            parts.push({ text: piece });
            before += piece;
          }
        });
      }
      const text = cleanLabel(full);
      if (text && text.length < 120) lastText = text;
      return parts;
    };

    const table = (tbl: Element): Part[][][] => {
      const rows = kids(tbl, 'tr');
      const header = rows[0] ? kids(rows[0], 'tc').map((tc) => cleanLabel(textOf(tc))) : [];
      return rows.map((tr, ri) => {
        const cells = kids(tr, 'tc');
        return cells.map((tc, ci) => {
          const own = textOf(tc).trim();
          const hasSdt = els(tc, 'sdt').length > 0;
          if (!own && !hasSdt) {
            // An empty cell beside a label ("Name" | ____), or under a column heading.
            const left = ci > 0 ? cleanLabel(textOf(cells[ci - 1]!)) : '';
            const head = ri > 0 ? header[ci] : '';
            const label = left && left.length < 80 ? left : head ? `${head} (row ${ri})` : '';
            if (label && ri <= 12) {
              const id = add(label, guessFieldType(label), { kind: 'cell', tc });
              return [{ slot: id }];
            }
            return [{ text: '' }];
          }
          return kids(tc, 'p').flatMap((p, i) => (i ? [{ text: '\n' }, ...paragraph(p, true)] : paragraph(p, true)));
        });
      });
    };

    for (const node of kids(body)) {
      if (node.localName === 'p') {
        const style = attr(child(child(node, 'pPr') ?? node, 'pStyle'), 'val') ?? '';
        blocks.push({ kind: 'p', parts: paragraph(node), heading: /heading|title/i.test(style) });
      } else if (node.localName === 'tbl') {
        blocks.push({ kind: 'table', rows: table(node) });
      } else if (node.localName === 'sdt') {
        const id = this.contentControl(node, lastText, add);
        if (id) blocks.push({ kind: 'p', parts: [{ slot: id }], heading: false });
        else for (const p of els(node, 'p')) blocks.push({ kind: 'p', parts: paragraph(p), heading: false });
      }
    }

    const firstText = blocks.flatMap((b) => (b.kind === 'p' ? [b.parts.map((x) => ('text' in x ? x.text : '')).join('').trim()] : [])).find(Boolean);
    const title = (firstText && firstText.length < 100 ? firstText : '') || fileName.replace(/\.docx$/i, '');
    return { fileName, title, slots, blocks };
  }

  private contentControl(sdt: Element, labelHint: string, add: (label: string, type: FieldType, ref: SlotRef, options?: string[]) => string): string | null {
    const pr = child(sdt, 'sdtPr');
    if (!pr) return null;
    const alias = attr(child(pr, 'alias'), 'val') || attr(child(pr, 'tag'), 'val') || '';
    const placeholder = child(pr, 'showingPlcHdr') ? textOf(child(sdt, 'sdtContent') ?? sdt) : '';
    const label = alias || cleanLabel(labelHint) || placeholder;
    if (pr.getElementsByTagNameNS(W14, 'checkbox').length) return add(label, 'yesno', { kind: 'sdt', el: sdt, checkbox: true }, ['Yes', 'No']);
    const list = child(pr, 'dropDownList') ?? child(pr, 'comboBox');
    if (list) {
      const options = kids(list, 'listItem').map((li) => attr(li, 'displayText') || attr(li, 'value') || '').filter(Boolean);
      if (options.length) return add(label, 'dropdown', { kind: 'sdt', el: sdt, checkbox: false }, options);
    }
    if (child(pr, 'date')) return add(label, 'date', { kind: 'sdt', el: sdt, checkbox: false });
    if (child(pr, 'text') || child(pr, 'richText') || child(pr, 'showingPlcHdr') || kids(pr).length <= 3) {
      return add(label, guessFieldType(label), { kind: 'sdt', el: sdt, checkbox: false });
    }
    return null;
  }

  // ---- Writing and reading back --------------------------------------------------------------

  write(slotId: string, value: string): void {
    const ref = this.refs.get(slotId);
    if (!ref) throw new Error('That place in the document was not found');
    const type = this.slotType.get(slotId);
    const shown = type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDate(value) : value;
    switch (ref.kind) {
      case 'sdt': {
        const pr = child(ref.el, 'sdtPr');
        const plc = pr && child(pr, 'showingPlcHdr');
        if (plc) pr!.removeChild(plc);
        const content = child(ref.el, 'sdtContent');
        if (!content) throw new Error('This content control has no content');
        if (ref.checkbox) {
          const box = pr!.getElementsByTagNameNS(W14, 'checked')[0];
          box?.setAttributeNS(W14, 'w14:val', value === 'Yes' ? '1' : '0');
          const run = els(content, 'r')[0];
          if (run) setRunText(run, value === 'Yes' ? BOX_CHECKED : BOX_EMPTY);
          return;
        }
        const runs = els(content, 'r');
        if (runs.length === 0) {
          const target = els(content, 'p')[0] ?? content;
          target.appendChild(newRun(this.doc, shown));
        } else {
          setRunText(runs[0]!, shown);
          // Drop the placeholder's grey style on the first run; empty the rest.
          const rStyle = child(child(runs[0]!, 'rPr') ?? runs[0]!, 'rStyle');
          if (rStyle && /placeholder/i.test(attr(rStyle, 'val') ?? '')) rStyle.parentNode!.removeChild(rStyle);
          runs.slice(1).forEach((r) => setRunText(r, ''));
        }
        return;
      }
      case 'blank': {
        setRunText(ref.run, ` ${shown} `);
        let rPr = child(ref.run, 'rPr');
        if (!rPr) { rPr = this.doc.createElementNS(W, 'w:rPr'); ref.run.insertBefore(rPr, ref.run.firstChild); }
        if (!child(rPr, 'u')) { const u = this.doc.createElementNS(W, 'w:u'); u.setAttributeNS(W, 'w:val', 'single'); rPr.appendChild(u); }
        return;
      }
      case 'cell': {
        const existing = this.added.get(slotId);
        if (existing) return setRunText(existing, shown);
        let p = child(ref.tc, 'p');
        if (!p) { p = this.doc.createElementNS(W, 'w:p'); ref.tc.appendChild(p); }
        const run = newRun(this.doc, shown);
        p.appendChild(run);
        this.added.set(slotId, run);
        return;
      }
      case 'boxes': {
        const chosen = new Set(value.split(', '));
        let hit = false;
        for (const b of ref.boxes) {
          const on = chosen.has(b.option);
          hit ||= on;
          setRunText(b.run, on ? BOX_CHECKED : BOX_EMPTY);
        }
        if (!hit) throw new Error('None of the boxes match that answer');
      }
    }
  }

  /** Reads the slot back from the XML, as a normalized value (dates as YYYY-MM-DD). */
  read(slotId: string): string | null {
    const ref = this.refs.get(slotId);
    if (!ref) return null;
    const type = this.slotType.get(slotId);
    let v: string;
    switch (ref.kind) {
      case 'sdt': {
        const content = child(ref.el, 'sdtContent');
        if (!content) return null;
        if (ref.checkbox) return textOf(content).includes(BOX_CHECKED) ? 'Yes' : 'No';
        if (child(child(ref.el, 'sdtPr')!, 'showingPlcHdr')) return '';
        v = textOf(content).trim();
        break;
      }
      case 'blank': v = textOf(ref.run).trim(); break;
      case 'cell': v = textOf(ref.tc).trim(); break;
      case 'boxes': return ref.boxes.filter((b) => textOf(b.run).includes(BOX_CHECKED)).map((b) => b.option).join(', ');
    }
    if (type === 'date' && v) return normalizeDate(v) ?? v;
    return v;
  }

  /** The filled document, ready to download. */
  export(): Uint8Array {
    const xml = new XMLSerializer().serializeToString(this.doc);
    return zipSync({ ...this.files, 'word/document.xml': strToU8(xml) }, { level: 6 });
  }
}

/** Questions for a session, from the slots the user kept. */
export function docxQuestions(plan: DocxPlan, keep?: Set<string>): FormQuestion[] {
  return plan.slots
    .filter((s) => !keep || keep.has(s.id))
    .map((s) => ({
      id: s.id,
      label: s.label,
      type: s.type,
      required: false,
      options: s.options,
      // Passwords, OTPs, bank details and the like are never filled (PRD §9).
      ...(({ support, reason }) => ({ support, supportReason: reason }))(classifySupport(s.label, s.type as RawControl)),
      source: { kind: 'docx' as const, fileName: plan.fileName, slot: s.id },
    }));
}
