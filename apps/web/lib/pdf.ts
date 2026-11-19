'use client';

import {
  classifySupport, formatDate, guessFieldType, normalizeDate,
  type FieldType, type FieldWriter, type FormQuestion, type PdfBox,
} from '@awaazform/core';
import {
  EncryptedPDFError, PDFCheckBox, PDFDocument, PDFDropdown, PDFName, PDFOptionList, PDFRadioGroup,
  PDFTextField, StandardFonts, rgb, type PDFField, type PDFFont,
} from 'pdf-lib';

// PDF support (J3, J4, FR-05 – FR-08). Everything runs in the browser; the file is never uploaded.

export const MAX_PDF_BYTES = 10 * 1024 * 1024;

export interface PageSize { width: number; height: number }
export interface TextItem { id: string; page: number; x: number; y: number; w: number; h: number; text: string }

/** Where each question lives on the page, for the preview overlay. */
export interface PdfLayout {
  pages: PageSize[];
  boxes: Record<string, { page: number; box: PdfBox; more?: PdfBox[]; cells?: PdfBox[]; optionBoxes?: Record<string, PdfBox> }>;
}

export interface PdfPlan {
  kind: 'acroform' | 'flat';
  fileName: string;
  title: string;
  questions: FormQuestion[];
  layout: PdfLayout;
}

export type Analysis =
  | { kind: 'unsupported'; reason: string }
  | { kind: 'acroform'; plan: PdfPlan }
  | { kind: 'flat'; fileName: string; title: string; pages: PageSize[]; items: TextItem[]; rules: Rule[]; rects: Rect[] };

/** A printed answer line: a drawn underline or a run of ‘____’, in PDF user space. */
export interface Rule { page: number; x1: number; x2: number; y: number }
/** A drawn box (a photo frame, a table cell) that answers must not run into. */
export interface Rect { page: number; x: number; y: number; w: number; h: number }

// ---------------------------------------------------------------------------
// pdf.js (rendering and text) is loaded lazily, client-side only.

type PdfJs = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfJs> | null = null;
export function pdfjs(): Promise<PdfJs> {
  return (pdfjsPromise ??= import('pdfjs-dist').then((m) => {
    m.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
    return m;
  }));
}

/** Opens a document; call `close()` when done to free the worker-side copy. */
export async function openPdfJs(bytes: ArrayBuffer) {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: new Uint8Array(bytes.slice(0)) });
  const pdf = await task.promise;
  return Object.assign(pdf, { close: () => task.destroy() });
}

const prettify = (name: string) =>
  name.replace(/[._]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());

// ---------------------------------------------------------------------------

export async function analyzePdf(bytes: ArrayBuffer, fileName: string): Promise<Analysis> {
  if (bytes.byteLength > MAX_PDF_BYTES) return { kind: 'unsupported', reason: 'This PDF is larger than 10 MB.' };

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes.slice(0), { updateMetadata: false });
  } catch (err) {
    if (err instanceof EncryptedPDFError) return { kind: 'unsupported', reason: 'This PDF is password-protected. Remove the password and upload it again.' };
    return { kind: 'unsupported', reason: 'This file could not be read as a PDF.' };
  }

  const title = doc.getTitle()?.trim() || fileName.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ');
  const pages = doc.getPages().map((p) => p.getSize());
  const form = doc.getForm();
  const fields = form.getFields();

  // FR-06: XFA-only forms can't be filled.
  if (form.hasXFA() && fields.length === 0) {
    return { kind: 'unsupported', reason: 'This is an XFA form (made with Adobe LiveCycle). AwaazForm cannot fill XFA forms; open it in Adobe Reader instead.' };
  }

  if (fields.length > 0) return { kind: 'acroform', plan: acroPlan(doc, fields, fileName, title, pages) };

  // Flat PDF: read its text. No text at all means a scan (FR-08).
  const pdf = await openPdfJs(bytes);
  const lib = await pdfjs();
  const items: TextItem[] = [];
  const rules: Rule[] = [];
  const rects: Rect[] = [];
  for (let p = 0; p < pdf.numPages; p++) {
    const page = await pdf.getPage(p + 1);
    const tc = await page.getTextContent();
    tc.items.forEach((raw, i) => {
      if (!('str' in raw) || !raw.str.trim()) return;
      const text = raw.str.trim();
      const it = { id: `p${p}i${i}`, page: p, x: raw.transform[4], y: raw.transform[5], w: raw.width, h: raw.height || 9, text };
      // A run of underscores or dots is a printed answer line, not a label.
      if (/^[_.…\s]{6,}$/.test(text)) { rules.push({ page: p, x1: it.x, x2: it.x + it.w, y: it.y }); return; }
      // “E mail ID.______”: one text item holding the label and its line. Split them.
      if (/_{4,}/.test(text)) {
        const parts = splitUnderlines(it);
        items.push(...parts.items);
        rules.push(...parts.rules);
        return;
      }
      items.push(it);
    });
    try {
      const shapes = drawnShapes(await page.getOperatorList(), lib.OPS, p);
      rules.push(...shapes.rules);
      rects.push(...shapes.rects);
    } catch { /* placement falls back to text only */ }
  }
  await pdf.close();
  if (items.reduce((n, i) => n + i.text.length, 0) < 20) {
    return { kind: 'unsupported', reason: 'This PDF looks like a scan (a picture of a page), so there is no text to work with. Scanned PDFs are not supported.' };
  }
  return { kind: 'flat', fileName, title, pages, items, rules, rects };
}

/**
 * Splits a text item like “E mail ID.______ Date:____” into labels and answer lines. pdf.js only gives
 * the whole item's width, so positions are estimated: an underscore is about half the font size wide.
 */
function splitUnderlines(it: TextItem): { items: TextItem[]; rules: Rule[] } {
  const raw = it.text;
  const runs = [...raw.matchAll(/_{4,}/g)];
  const under = runs.reduce((n, r) => n + r[0].length, 0);
  const others = raw.length - under;
  const uw = Math.min(it.h * 0.5, it.w / Math.max(1, under));
  const ow = others ? Math.max(0, (it.w - under * uw) / others) : 0;
  const items: TextItem[] = [];
  const rules: Rule[] = [];
  let x = it.x;
  let k = 0;
  for (const part of raw.split(/(_{4,})/)) {
    if (!part) continue;
    if (/^_{4,}$/.test(part)) {
      rules.push({ page: it.page, x1: x, x2: x + part.length * uw, y: it.y - 1 });
      x += part.length * uw;
    } else {
      const w = part.length * ow;
      const lead = part.length - part.trimStart().length;
      const text = part.trim();
      if (text) items.push({ ...it, id: k++ ? `${it.id}s${k}` : it.id, x: x + lead * ow, w: text.length * ow, text });
      x += w;
    }
  }
  return { items, rules };
}

type Matrix = [number, number, number, number, number, number];
const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];

/**
 * Underlines and boxes drawn on a page. Each path's bounding box (pdf.js gives it as the last argument
 * of constructPath, in every recent version) is mapped through the current transform, then sorted into
 * thin horizontal lines (answer lines) and larger rectangles (photo frames, cells) to stay clear of.
 */
function drawnShapes(ops: { fnArray: number[]; argsArray: unknown[][] }, OPS: Record<string, number>, page: number) {
  const rules: Rule[] = [];
  const rects: Rect[] = [];
  const verticals: { x: number; y1: number; y2: number }[] = [];
  const stack: Matrix[] = [];
  let m: Matrix = [1, 0, 0, 1, 0, 0];
  const at = (x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
  const addBox = (pts: [number, number][]) => {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y;
    if (w >= 30 && h <= 2.5) rules.push({ page, x1: x, x2: x + w, y });
    else if (w <= 2.5 && h >= 6 && h <= 30) verticals.push({ x, y1: y, y2: y + h });
    else if (w >= 24 && h >= 8 && w < 500) rects.push({ page, x, y, w, h }); // frames and table cells
    else if (w >= 6 && w <= 28 && h >= 6 && h <= 28) rects.push({ page, x, y, w, h }); // a tick box or a character cell
  };
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] ?? [];
    if (fn === OPS.save) stack.push(m);
    else if (fn === OPS.restore) m = stack.pop() ?? m;
    else if (fn === OPS.transform) m = mul(args as unknown as Matrix, m);
    else if (fn === OPS.constructPath) {
      // pdf.js ≥ 5: [drawOp, [pathData], bbox]; path data ops: 0 moveTo, 1 lineTo, 2 curveTo, 3 quad, 4 close.
      const data = (args[1] as ArrayLike<number>[] | undefined)?.[0];
      if (data && typeof data[0] === 'number') {
        let sub: [number, number][] = [];
        let k = 0;
        const flush = (closed: boolean) => {
          if (closed && sub.length >= 3) addBox(sub);
          else for (let s = 1; s < sub.length; s++) addBox([sub[s - 1]!, sub[s]!]); // open lines: each segment
          sub = [];
        };
        while (k < data.length) {
          const op = data[k++];
          if (op === 0) { flush(false); sub.push(at(data[k]!, data[k + 1]!)); k += 2; }
          else if (op === 1) { sub.push(at(data[k]!, data[k + 1]!)); k += 2; }
          else if (op === 2) { sub.push(at(data[k + 4]!, data[k + 5]!)); k += 6; }
          else if (op === 3) { sub.push(at(data[k + 2]!, data[k + 3]!)); k += 4; }
          else if (op === 4) flush(true);
          else break;
        }
        flush(false);
        continue;
      }
      // Older pdf.js: only the overall bounding box is known.
      const mm = args[args.length - 1] as ArrayLike<number> | null;
      if (!mm || mm.length < 4 || ![mm[0], mm[1], mm[2], mm[3]].every(Number.isFinite)) continue;
      addBox([at(mm[0]!, mm[1]!), at(mm[2]!, mm[1]!), at(mm[0]!, mm[3]!), at(mm[2]!, mm[3]!)]);
    }
  }
  // Character grids drawn as dividers: evenly spaced vertical strokes of the same height make cells.
  const groups = new Map<string, number[]>();
  for (const v of verticals) {
    const key = `${Math.round(v.y1)}:${Math.round(v.y2)}`;
    groups.set(key, [...(groups.get(key) ?? []), v.x]);
  }
  for (const [key, xs] of groups) {
    const [y1, y2] = key.split(':').map(Number) as [number, number];
    const sorted = [...new Set(xs.map((x) => Math.round(x * 2) / 2))].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      const w = sorted[i]! - sorted[i - 1]!;
      if (w >= 6 && w <= 28) rects.push({ page, x: sorted[i - 1]!, y: y1, w, h: y2 - y1 });
    }
  }
  return { rules, rects };
}

function acroPlan(doc: PDFDocument, fields: PDFField[], fileName: string, title: string, pages: PageSize[]): PdfPlan {
  const questions: FormQuestion[] = [];
  const layout: PdfLayout = { pages, boxes: {} };
  const pageDicts = doc.getPages().map((p) => p.node);

  fields.forEach((f, i) => {
    const name = f.getName();
    const tu = f.acroField.dict.lookup(PDFName.of('TU'));
    const label = (tu && 'decodeText' in tu ? (tu as { decodeText(): string }).decodeText() : '') || prettify(name.split('.').pop() ?? name);
    let type: FieldType = 'text';
    let options: string[] | undefined;
    let control: Parameters<typeof classifySupport>[1] = 'text';

    if (f instanceof PDFTextField) { type = f.isMultiline() ? 'paragraph' : guessFieldType(label); control = type; }
    else if (f instanceof PDFCheckBox) { type = 'yesno'; options = ['Yes', 'No']; control = 'yesno'; }
    else if (f instanceof PDFRadioGroup) { type = 'choice'; options = f.getOptions(); control = 'choice'; }
    else if (f instanceof PDFDropdown) { type = 'dropdown'; options = f.getOptions(); control = 'dropdown'; }
    else if (f instanceof PDFOptionList) { type = 'multichoice'; options = f.getOptions(); control = 'multichoice'; }
    else control = /sig/i.test(f.constructor.name) ? 'signature' : 'unknown';

    const { support, reason } = classifySupport(label, control);
    const id = `f${i}`;
    questions.push({
      id, label, type, options, required: f.isRequired(), support, supportReason: reason,
      source: { kind: 'pdf-acroform', fileName, fieldName: name },
    });

    // Overlay position from the first widget.
    const w = f.acroField.getWidgets()[0];
    if (w) {
      const r = w.getRectangle();
      const pRef = w.P();
      let page = pRef ? pageDicts.findIndex((d) => doc.context.getObjectRef(d) === pRef) : -1;
      if (page < 0) page = pageDicts.findIndex((d) => d.Annots()?.asArray().some((a) => doc.context.lookup(a) === w.dict));
      layout.boxes[id] = { page: Math.max(0, page), box: { x: r.x, y: r.y, w: r.width, h: r.height } };
    }
  });
  return { kind: 'acroform', fileName, title, questions, layout };
}

// ---------------------------------------------------------------------------
// Flat PDFs: candidate questions and answer boxes (J4). The user reviews all of this.

export interface Candidate {
  itemId: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: { text: string; itemId?: string }[];
  include: boolean;
  /** Set when the place to write is already known (one part of a captioned line). */
  box?: PdfBox;
  /** Set when the tick boxes are already known (a table's tick columns). */
  optionBoxes?: Record<string, PdfBox>;
}

const LABEL_HINT = /\b(name|surname|mobile|phone|e-?mail|date of birth|dob|gender|sex|address|house|building|street|locality|town|village|city|post office|pin ?code|postal|tehsil|taluk|district|state|country|father|mother|husband|wife|guardian|relative|relationship|place|date|age|occupation|qualification|nationality|aadha+r|epic|percentage)\b/i;
const OFFICE_USE = /form (no|number)|office use|acknowledg|receipt|\b(ero|aero|blo)\b|signature|thumb impression/i;
const NOT_A_FIELD =/^(\d+\.|to,?$|note|disclaimer|declaration|i hereby|i am |i submit|\(see |\(@|\(to be filled|space for|accessibility)/i;

/** Heuristic fallback when AI is unavailable: short label-like text items. */
export function heuristicCandidates(items: TextItem[]): Candidate[] {
  return items
    .filter((it) => it.text.length >= 3 && it.text.length <= 70 && LABEL_HINT.test(it.text) && !NOT_A_FIELD.test(it.text))
    .map((it) => ({ itemId: it.id, label: cleanLabel(it.text), type: guessFieldType(it.text), required: it.text.startsWith('*'), include: true }));
}

export function cleanLabel(s: string): string {
  return s.replace(/^\*?\s*(\(\w{1,4}\)\s*)+/, '').replace(/[:_\-\s]+$/, '').replace(/_{2,}/g, '').replace(/\s+/g, ' ').trim() || s.trim();
}

/** Asks the server to identify questions, one page per request (keeps each request inside free-tier token limits).
 * Only printed form text is sent, never answers. Long sentences are dropped: they are instructions, not labels. */
/**
 * Asks the AI for each page's questions. A page that fails (usually the AI's per-minute rate limit) is
 * retried once after the server's Retry-After; if it still fails, that page alone falls back to the
 * simple rules, and every page the AI did read is kept. `fallbackPages` lists the pages that used rules.
 */
export async function aiCandidates(items: TextItem[], pages: PageSize[]): Promise<{ candidates: Candidate[]; fallbackPages: number[]; error?: string }> {
  const known = new Set(items.map((i) => i.id));
  const out: Candidate[] = [];
  const fallbackPages: number[] = [];
  let lastError: string | undefined;
  for (let p = 0; p < pages.length; p++) {
    const pageItems = items.filter((i) => i.page === p && i.text.length <= 110);
    if (pageItems.length === 0) continue;
    const body = JSON.stringify({
      page: p, pageSize: pages[p],
      items: pageItems.slice(0, 350).map(({ id, x, y, text }) => ({ id, x: Math.round(x), y: Math.round(y), text })),
    });
    let questions: Omit<Candidate, 'include'>[] | null = null;
    for (let attempt = 0; attempt < 2 && !questions; attempt++) {
      try {
        const res = await fetch('/api/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        const json = (await res.json().catch(() => ({}))) as { questions?: Omit<Candidate, 'include'>[]; error?: string };
        if (res.ok && json.questions) { questions = json.questions; break; }
        lastError = json.error ?? `AI request failed (${res.status})`;
        if (res.status !== 429 && res.status < 500) break; // a real refusal: retrying won't help
        const wait = Math.min(20, Number(res.headers.get('retry-after')) || 6) * 1000;
        if (attempt === 0) await new Promise((r) => setTimeout(r, wait));
      } catch (err) {
        lastError = (err as Error).message;
      }
    }
    if (questions) {
      // Office-use fields are unticked (not removed), so the user can still include them.
      out.push(...questions.filter((q) => known.has(q.itemId)).map((q) => ({ ...q, include: !OFFICE_USE.test(q.label) })));
    } else {
      fallbackPages.push(p);
      out.push(...heuristicCandidates(items.filter((i) => i.page === p)));
    }
  }
  return { candidates: out, fallbackPages, error: fallbackPages.length ? lastError : undefined };
}

/** Places an answer box to the right of the label, up to the next label on the line or the margin. */
/**
 * A line with captions printed under it, like
 *   Name: ______________________________________________
 *         (Surname)     (Name)    (Father Name)   (Mother Name)
 * is four answers, not one. Each caption becomes its own question, written on its part of the line.
 */
export function splitCaptioned(cands: Candidate[], items: TextItem[], rules: Rule[]): Candidate[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const captionIds = new Set<string>();
  const out: Candidate[] = [];
  for (const cand of cands) {
    const it = byId.get(cand.itemId);
    if (!it || cand.options?.length || captionIds.has(cand.itemId)) { if (!captionIds.has(cand.itemId)) out.push(cand); continue; }
    // A long line on the label's row or just below it.
    const line = rules
      .filter((r) => r.page === it.page && r.y <= it.y + 4 && r.y >= it.y - 26 && r.x2 - r.x1 >= 150 && r.x1 <= it.x + it.w + 40)
      .sort((a, b) => b.y - a.y)[0];
    if (!line) { out.push(cand); continue; }
    const caps = items
      .filter((o) => o.page === it.page && o.y < line.y - 2 && o.y >= line.y - 20 && o.x + o.w > line.x1 && o.x < line.x2)
      .flatMap((o) => [...o.text.matchAll(/\(([^()]{2,30})\)/g)].map((m) => {
        // Where in the item the caption sits (items like ") (Surname)" carry leftovers).
        const cw = o.w / Math.max(1, o.text.length);
        const x = o.x + (m.index ?? 0) * cw;
        return { id: o.id, text: m[1]!.trim(), x, w: m[0].length * cw };
      }))
      .filter((c) => !/block|capital|letters|optional|if any/i.test(c.text))
      .sort((a, b) => a.x - b.x);
    if (caps.length < 2) { out.push(cand); continue; }
    const block = items.some((o) => o.page === it.page && o.y >= line.y - 20 && o.y <= it.y + 4 && /block letters|capital letters/i.test(o.text));
    const centers = caps.map((c) => c.x + c.w / 2);
    const startX = line.y < it.y - 6 ? line.x1 : Math.max(line.x1, it.x + it.w + 4);
    caps.forEach((c, k) => {
      const x1 = k === 0 ? startX : (centers[k - 1]! + centers[k]!) / 2;
      const x2 = k === caps.length - 1 ? line.x2 : (centers[k]! + centers[k + 1]!) / 2;
      captionIds.add(c.id);
      const base = cleanLabel(cand.label).replace(/\s*\(.*\)\s*$/, '');
      const label = /^name$/i.test(c.text) && /name/i.test(base) ? 'First name' : /name/i.test(c.text) || !base ? c.text : `${base}: ${c.text}`;
      out.push({ ...cand, itemId: k ? `${cand.itemId}c${k}` : cand.itemId, label: block ? `${label} (block letters)` : label, box: { x: x1 + 2, y: line.y + 1, w: x2 - x1 - 6, h: Math.max(14, it.h + 4) } });
    });
  }
  // The captions themselves aren't questions.
  return out.filter((c) => !captionIds.has(c.itemId) || c.box);
}

export const SIGNATURE = /signature|thumb impression|हस्ताक्षर|स्वाक्षरी/i;
/** Someone else's signature (an officer, a parent): not the user's to draw. */
const OTHERS_SIGNATURE = /officer|authori[sz]ed|principal|\bhod\b|head of|director|registrar|\b(ero|aero|blo)\b|verif|parent|guardian|witness|seal|stamp|office/i;

function bounds(bs: PdfBox[]): PdfBox {
  const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y));
  return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y };
}

/** Where to sign: on the line printed above the label if there is one, else the clear space above it. */
function signatureBox(it: TextItem, items: TextItem[], rules: Rule[], pw: number): PdfBox {
  const w = Math.min(200, Math.max(140, it.w + 30));
  const cx = it.x + it.w / 2;
  const x = Math.max(24, Math.min(pw - 24 - w, cx - w / 2));
  const line = rules.find((r) => r.page === it.page && r.y > it.y && r.y <= it.y + it.h + 14 && r.x1 < cx && r.x2 > cx);
  const bottom = line ? line.y + 1 : it.y + it.h + 2;
  // Stop below whatever is printed above (the declaration).
  const above = items.filter((o) => o.page === it.page && o.id !== it.id && o.y > bottom && o.x < x + w && o.x + o.w > x).map((o) => o.y);
  const top = Math.min(bottom + 50, above.length ? Math.min(...above) - 3 : Infinity);
  return { x, y: bottom, w, h: Math.max(22, top - bottom) };
}

/** The user's own signature lines that the AI skipped (it is told signatures are filled by hand). */
export function addSignatures(cands: Candidate[], items: TextItem[]): Candidate[] {
  const have = new Set(cands.map((c) => c.itemId));
  const extra = items
    .filter((o) => SIGNATURE.test(o.text) && !OTHERS_SIGNATURE.test(o.text) && o.text.length <= 60 && !have.has(o.id))
    .map((o) => ({ itemId: o.id, label: cleanLabel(o.text), type: 'text' as FieldType, required: false, include: true }));
  return [...cands.filter((c) => !(SIGNATURE.test(c.label) && OTHERS_SIGNATURE.test(c.label)))
    .map((c) => SIGNATURE.test(c.label) ? { ...c, type: 'signature' as FieldType, include: true } : c),
    ...extra.map((c) => ({ ...c, type: 'signature' as FieldType }))];
}

/**
 * A choice whose options are rows of a table with empty tick columns (“tick Internal / External”):
 * the ticks go in those columns, so each row × column becomes an option, “Embedded Systems (Internal)”.
 */
export function tableTicks(cands: Candidate[], items: TextItem[], rects: Rect[]): Candidate[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return cands.map((cand) => {
    if (!cand.options?.length) return cand;
    const it = byId.get(cand.itemId);
    if (!it) return cand;
    const cells = dedupe(rects.filter((r) => r.page === it.page && r.w >= 24 && r.h >= 8 && r.h < 90));
    const inside = (r: Rect, o: TextItem) => o.x + 1 >= r.x && o.x + 1 <= r.x + r.w && o.y + o.h / 3 >= r.y && o.y + o.h / 3 <= r.y + r.h;
    const options: { text: string }[] = [];
    const optionBoxes: Record<string, PdfBox> = {};
    const seenRows = new Set<number>();
    for (const op of cand.options) {
      const oi = op.itemId ? byId.get(op.itemId) : undefined;
      if (!oi) continue;
      const cell = cells.find((r) => inside(r, oi));
      if (!cell || seenRows.has(Math.round(cell.y))) continue;
      const row = cells.filter((r) => Math.abs(r.y - cell.y) <= 1.5 && Math.abs(r.h - cell.h) <= 2 && r.x > cell.x + 1).sort((a, b) => a.x - b.x);
      for (const c of row) {
        if (items.some((o) => o.page === it.page && inside(c, o))) continue; // not empty: printed content
        // The column's heading: the nearest text above, inside the column.
        const head = items
          .filter((o) => o.page === it.page && o.y > c.y + c.h && o.y < c.y + c.h + 140 && o.x + o.w / 2 >= c.x && o.x + o.w / 2 <= c.x + c.w)
          .sort((a, b) => a.y - b.y)[0];
        if (!head) continue;
        seenRows.add(Math.round(cell.y));
        const text = `${op.text} (${cleanLabel(head.text)})`;
        const s = Math.min(12, c.h - 3);
        options.push({ text });
        optionBoxes[text] = { x: c.x + (c.w - s) / 2, y: c.y + (c.h - s) / 2, w: s, h: s };
      }
    }
    return options.length >= 2 ? { ...cand, type: 'multichoice' as FieldType, options, optionBoxes } : cand;
  });
}

/** A row of character boxes (PRN, mobile number) to the right of a label, plus any rows stacked under it. */
function cellRow(it: TextItem, start: number, rects: Rect[], nextLabelX: number): PdfBox[] | null {
  const mid = it.y + it.h / 3;
  const small = dedupe(rects.filter((r) => r.page === it.page && r.w >= 8 && r.w <= 28 && r.h >= 8 && r.h <= 30));
  const row = (y: number, h: number, x0: number) => {
    const same = small.filter((r) => Math.abs(r.y - y) <= 1.5 && Math.abs(r.h - h) <= 2).sort((a, b) => a.x - b.x);
    const run: Rect[] = [];
    for (const r of same) {
      if (r.x < x0 - 1) continue;
      if (!run.length || r.x - (run[run.length - 1]!.x + run[run.length - 1]!.w) <= 3) run.push(r);
      else break;
    }
    return run;
  };
  const first = small
    .filter((r) => r.x >= start - 8 && r.x < nextLabelX && mid >= r.y - 3 && mid <= r.y + r.h + 3)
    .sort((a, b) => a.x - b.x)[0];
  if (!first) return null;
  const run = row(first.y, first.h, first.x);
  if (run.length < 4) return null;
  const cells: PdfBox[] = run.map(({ x, y, w, h }) => ({ x, y, w, h }));
  // Grids that continue on the next row (long names): same start, directly below.
  let below = first;
  for (let n = 0; n < 2; n++) {
    const next = small.find((r) => Math.abs(r.x - run[0]!.x) <= 3 && r.y < below.y - 2 && r.y >= below.y - below.h - 6);
    if (!next) break;
    const more = row(next.y, next.h, next.x);
    if (more.length < 4) break;
    cells.push(...more.map(({ x, y, w, h }) => ({ x, y, w, h })));
    below = next;
  }
  return cells;
}

/** Filled and stroked copies of the same cell, or a cell drawn twice: keep one. */
function dedupe(rs: Rect[]): Rect[] {
  const out: Rect[] = [];
  for (const r of rs) if (!out.some((o) => Math.abs(o.x - r.x) <= 1.5 && Math.abs(o.y - r.y) <= 1.5 && Math.abs(o.w - r.w) <= 2)) out.push(r);
  return out;
}

/**
 * Places an answer box for each question. Preference order:
 * 1. the printed answer line (underline or ‘____’) to the right of the label, exactly as wide as the line;
 * 2. otherwise the space up to the next label, stopping before any drawn frame (a photo box) and inside
 *    the table cell it starts in; never to the page edge;
 * 3. no room on the line: underneath the label.
 * Blank answer lines directly below (an address's 2nd and 3rd lines) become `more`, for long answers.
 */
export function placeBoxes(c: Candidate[], items: TextItem[], pages: PageSize[], rules: Rule[] = [], rects: Rect[] = []): PdfLayout['boxes'] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const labelIds = new Set(c.map((x) => x.itemId));
  const boxes: PdfLayout['boxes'] = {};
  const used = new Set<Rule>();

  for (const cand of c) {
    const it = byId.get(cand.itemId.replace(/c\d+$/, ''));
    if (!it) continue;
    // One part of a captioned line, or a table's tick columns: the place is already known.
    if (cand.box) { boxes[cand.itemId] = { page: it.page, box: cand.box }; continue; }
    if (cand.optionBoxes && Object.keys(cand.optionBoxes).length) {
      boxes[cand.itemId] = { page: it.page, box: bounds(Object.values(cand.optionBoxes)), optionBoxes: cand.optionBoxes };
      continue;
    }
    // A signature: the space above “Signature of the student”, where people sign.
    if (cand.type === 'signature' || SIGNATURE.test(cand.label) || SIGNATURE.test(it.text)) {
      boxes[cand.itemId] = { page: it.page, box: signatureBox(it, items, rules, pages[it.page]?.width ?? 612) };
      continue;
    }
    const pw = pages[it.page]?.width ?? 612;
    const pageRules = rules.filter((r) => r.page === it.page);
    const sameLine = items.filter((o) => o.page === it.page && Math.abs(o.y - it.y) <= 3 && o.x > it.x + it.w - 1);
    // Skip short connector text like ":" or "(or)" when finding where the answer space starts.
    const filler = sameLine.filter((o) => !labelIds.has(o.id) && o.text.length <= 6 && !(cand.options ?? []).some((op) => op.itemId === o.id));
    const start = Math.max(it.x + it.w, ...filler.map((o) => o.x + o.w)) + 4;
    const nextLabel = sameLine.filter((o) => (labelIds.has(o.id) || o.text.length > 6) && o.x >= start).sort((a, b) => a.x - b.x)[0];
    const h = Math.max(14, it.h + 6);

    let box: PdfBox | null = null;
    // 0. A row of character boxes: one character per box.
    const cells = cand.options?.length ? null : cellRow(it, start, rects, nextLabel ? nextLabel.x : pw);
    if (cells) {
      const xs = cells.map((b) => b.x), ys = cells.map((b) => b.y);
      const x = Math.min(...xs), y = Math.min(...ys);
      boxes[cand.itemId] = {
        page: it.page,
        box: { x, y, w: Math.max(...cells.map((b) => b.x + b.w)) - x, h: Math.max(...cells.map((b) => b.y + b.h)) - y },
        cells,
      };
      continue;
    }
    // 1. The answer line printed for this label: on (or just under) the text's baseline, starting to its right.
    const line = pageRules
      .filter((r) => !used.has(r) && r.y <= it.y + 4 && r.y >= it.y - 8 && r.x2 > start + 20 && r.x1 >= it.x + it.w - 12 && (!nextLabel || r.x1 < nextLabel.x))
      .sort((a, b) => a.x1 - b.x1)[0];
    // 1b. A label alone on its row, with its line printed underneath (“Name:” then “________”).
    const under = line ? undefined : pageRules
      .filter((r) => !used.has(r) && r.y < it.y - 6 && r.y >= it.y - 26 && Math.abs(r.x1 - it.x) <= 30 && r.x2 - r.x1 >= 100)
      .filter((r) => !items.some((o) => o.page === it.page && o.id !== it.id && labelIds.has(o.id) && Math.abs(o.y - r.y) <= 4 && o.x < r.x2))
      .sort((a, b) => b.y - a.y)[0];
    if (line) {
      used.add(line);
      const x = Math.max(line.x1, start - 2);
      box = { x, y: line.y + 1, w: line.x2 - x, h };
    } else if (under && !nextLabel && sameLine.every((o) => o.text.length <= 6)) {
      used.add(under);
      box = { x: under.x1 + 2, y: under.y + 1, w: under.x2 - under.x1 - 4, h };
    } else {
      // 2. Up to the next label, a tall frame (photo box) on this line, or the cell it starts in.
      const lineTop = it.y + it.h + 2, lineBottom = it.y - 6;
      const frame = rects
        .filter((r) => r.page === it.page && r.h >= 40 && r.x >= start && r.y < lineTop && r.y + r.h > lineBottom)
        .sort((a, b) => a.x - b.x)[0];
      const cell = rects.find((r) => r.page === it.page && r.h < 40 && start >= r.x && start < r.x + r.w && it.y >= r.y - 2 && it.y <= r.y + r.h);
      const end = Math.min(nextLabel ? nextLabel.x : pw - 36, frame ? frame.x : Infinity, cell ? cell.x + cell.w : Infinity, pw - 36) - 6;
      // A date needs ~10 characters, not the whole row (“Date: ……… Signature”).
      const cap = cand.type === 'date' ? start + 150 : Infinity;
      if (end - start >= 50) box = { x: start, y: it.y - 4, w: Math.min(end, cap) - start, h };
    }
    // 3. No room on the line: underneath.
    box ??= { x: it.x, y: it.y - h - 4, w: Math.min(260, pw - it.x - 36), h };
    // Printed rules can also run across to another caption. Apply the date limit to every
    // placement path, including a detected line or the fallback underneath the label.
    if (cand.type === 'date') box.w = Math.min(box.w, 150, nextLabel ? Math.max(12, nextLabel.x - box.x - 6) : Infinity);

    // Blank answer lines straight below, with no label of their own: room for long answers.
    const more: PdfBox[] = [];
    if (!cand.options?.length && cand.type !== 'date') {
      let prevY = box.y;
      for (;;) {
        const next = pageRules
          .filter((r) => !used.has(r) && r.y < prevY - 8 && r.y > prevY - 34 && Math.abs(r.x1 - box!.x) <= 24 && r.x2 - r.x1 >= 60)
          .sort((a, b) => b.y - a.y)[0];
        if (!next) break;
        const labelled = items.some((o) => o.page === it.page && Math.abs(o.y - next.y) <= 6 && o.x < next.x1 && labelIds.has(o.id));
        if (labelled || more.length >= 4) break;
        used.add(next);
        more.push({ x: next.x1, y: next.y + 1, w: next.x2 - next.x1, h });
        prevY = next.y;
      }
    }

    let optionBoxes: Record<string, PdfBox> | undefined;
    if (cand.options?.length) {
      optionBoxes = {};
      for (const op of cand.options) {
        const oi = op.itemId ? byId.get(op.itemId) : undefined;
        if (!oi) continue;
        // A printed tick box just left of the option text, if one is drawn; otherwise the usual spot.
        const tick = rects.find((r) => r.page === oi.page && r.w <= 20 && r.h <= 20 && r.x + r.w <= oi.x + 2 && r.x + r.w >= oi.x - 18 && Math.abs(r.y + r.h / 2 - (oi.y + oi.h / 3)) <= 8);
        optionBoxes[op.text] = tick ?? { x: oi.x - 16, y: oi.y - 2, w: 12, h: 12 };
      }
    }
    // A choice question is outlined around its tick boxes, not over the instructions printed beside it.
    if (optionBoxes && Object.keys(optionBoxes).length) box = bounds(Object.values(optionBoxes));
    boxes[cand.itemId] = { page: it.page, box, more: more.length ? more : undefined, optionBoxes };
  }
  return boxes;
}

export function flatPlan(fileName: string, title: string, pages: PageSize[], cands: Candidate[], boxes: PdfLayout['boxes'], items: TextItem[]): PdfPlan {
  const questions: FormQuestion[] = [];
  const layout: PdfLayout = { pages, boxes: {} };
  const byId = new Map(items.map((i) => [i.id, i]));
  cands.filter((c) => c.include && boxes[c.itemId]).forEach((c, i) => {
    const b = boxes[c.itemId]!;
    const id = `q${i + 1}`;
    const raw = (c.box ? '' : byId.get(c.itemId)?.text) || c.label;
    const signature = c.type === 'signature' || SIGNATURE.test(c.label);
    const control = signature ? 'text' : /photo/i.test(c.label) ? 'file' : c.type;
    // Signatures are drawn on screen and stamped into the PDF; the user still signs, AwaazForm only places it.
    const { support, reason } = classifySupport(c.label, control);
    const options = signature ? undefined : c.options?.map((o) => o.text);
    questions.push({
      id, label: c.label, type: signature ? 'signature' : options?.length && c.type === 'text' ? 'choice' : c.type, options, required: c.required, support, supportReason: reason,
      source: { kind: 'pdf-flat', fileName, page: b.page, box: b.box, more: b.more, cells: b.cells, optionBoxes: b.optionBoxes, uppercase: /block letters|capital letters/i.test(raw + ' ' + c.label) },
    });
    layout.boxes[id] = b;
  });
  return { kind: 'flat', fileName, title, questions, layout };
}

// ---------------------------------------------------------------------------
// Filling. Writes go into the document (AcroForm) or a value map (flat); reads come from the same place.

export class PdfFiller implements FieldWriter {
  private doc!: PDFDocument;
  private font!: PDFFont;
  private flatValues = new Map<string, string>();

  private constructor(private bytes: ArrayBuffer, private plan: PdfPlan) {}

  static async create(bytes: ArrayBuffer, plan: PdfPlan) {
    const f = new PdfFiller(bytes, plan);
    f.doc = await PDFDocument.load(bytes.slice(0));
    f.font = await f.doc.embedFont(StandardFonts.Helvetica);
    // Hybrid AcroForm+XFA files: drop XFA so viewers show the AcroForm values we write.
    if (plan.kind === 'acroform' && f.doc.getForm().hasXFA()) f.doc.getForm().deleteXFA();
    return f;
  }

  /** The standard PDF fonts only cover Latin text. Devanagari needs shaping pdf-lib can't do yet. */
  private assertEncodable(value: string) {
    try {
      this.font.widthOfTextAtSize(value, 10);
    } catch {
      throw new Error('Hindi script cannot be written into PDFs yet. Answer in English letters, or write this one by hand');
    }
  }

  private toPdfValue(q: FormQuestion, v: string) {
    const out = q.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? formatDate(v, 'DD/MM/YYYY') : v;
    return q.source.kind === 'pdf-flat' && q.source.uppercase ? out.toUpperCase() : out;
  }

  /** Maps what's in the PDF back to the normalized form, so verification compares like with like. */
  private fromPdfValue(q: FormQuestion, v: string) {
    if (q.type === 'date') return normalizeDate(v) ?? v;
    if (q.source.kind === 'pdf-flat' && q.source.uppercase) {
      const proposed = this.flatValues.get(`${q.id}:orig`);
      return proposed && proposed.toUpperCase() === v ? proposed : v;
    }
    return v;
  }

  private field(q: FormQuestion) {
    if (q.source.kind !== 'pdf-acroform') throw new Error('Not a form field');
    return this.doc.getForm().getField(q.source.fieldName);
  }

  async write(q: FormQuestion, value: string): Promise<void> {
    if (q.support === 'unsupported') throw new Error('This field is not filled by AwaazForm');
    const v = this.toPdfValue(q, value);
    if (q.source.kind === 'pdf-flat') {
      if (q.type !== 'signature' && (!q.source.optionBoxes || !q.options?.length)) this.assertEncodable(v);
      if (q.source.cells?.length) {
        const n = q.source.cells.length;
        if (cellChars(q, v, n).length > n) throw new Error(`This field allows at most ${n} characters`);
      }
      this.flatValues.set(q.id, v);
      this.flatValues.set(`${q.id}:orig`, value);
      return;
    }
    const f = this.field(q);
    if (f instanceof PDFTextField) {
      this.assertEncodable(v);
      const max = f.getMaxLength();
      if (max !== undefined && v.length > max) throw new Error(`This field allows at most ${max} characters`);
      f.setText(v);
    } else if (f instanceof PDFCheckBox) {
      if (value === 'Yes') f.check(); else f.uncheck();
    } else if (f instanceof PDFRadioGroup || f instanceof PDFDropdown) {
      f.select(value);
    } else if (f instanceof PDFOptionList) {
      f.select(value.split(', '));
    } else {
      throw new Error('This kind of field is not supported');
    }
  }

  async read(q: FormQuestion): Promise<string | null> {
    if (q.source.kind === 'pdf-flat') {
      const v = this.flatValues.get(q.id);
      return v === undefined ? null : this.fromPdfValue(q, v);
    }
    const f = this.field(q);
    if (f instanceof PDFTextField) return this.fromPdfValue(q, f.getText() ?? '');
    if (f instanceof PDFCheckBox) return f.isChecked() ? 'Yes' : 'No';
    if (f instanceof PDFRadioGroup) return f.getSelected() ?? '';
    if (f instanceof PDFDropdown || f instanceof PDFOptionList) return f.getSelected().join(', ');
    return null;
  }

  /** Display text for the preview overlay. */
  shown(q: FormQuestion): string | undefined {
    return q.source.kind === 'pdf-flat' ? this.flatValues.get(q.id) : undefined;
  }

  /** How a flat-PDF answer is laid out: the same lines the download draws, for the preview. */
  segments(q: FormQuestion, text?: string): Segment[] {
    const v = text ?? this.flatValues.get(q.id);
    if (v === undefined || q.source.kind !== 'pdf-flat' || q.type === 'signature') return [];
    if (q.source.cells?.length) return cellText(this.font, q.source.cells, cellChars(q, v, q.source.cells.length));
    return layoutText(this.font, [q.source.box, ...(q.source.more ?? [])], v);
  }

  /** The filled file. AwaazForm never submits it; the user downloads it and submits it themselves. */
  async export(): Promise<Uint8Array> {
    if (this.plan.kind === 'acroform') {
      this.doc.getForm().updateFieldAppearances(this.font);
      return this.doc.save();
    }
    // A download is a snapshot. Drawing into the live document would leave old signatures,
    // ticks and dates underneath corrected answers on every subsequent download.
    const doc = await PDFDocument.load(this.bytes.slice(0));
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();
    for (const q of this.plan.questions) {
      const v = this.flatValues.get(q.id);
      if (v === undefined || q.source.kind !== 'pdf-flat') continue;
      const page = pages[q.source.page];
      if (!page) continue;
      const color = rgb(0.05, 0.1, 0.45);
      if (q.type === 'signature') {
        // The drawn signature, scaled to fit the box and sitting on its line.
        const img = await doc.embedPng(v);
        const b = q.source.box;
        const k = Math.min(b.w / img.width, b.h / img.height);
        const w = img.width * k, h = img.height * k;
        page.drawImage(img, { x: b.x + (b.w - w) / 2, y: b.y, width: w, height: h });
        continue;
      }
      if (q.source.optionBoxes && q.options?.length) {
        // Tick the printed box for each chosen option.
        for (const choice of v.split(', ')) {
          const b = q.source.optionBoxes[choice];
          if (b) page.drawText('X', { x: b.x + 2, y: b.y + 2, size: Math.min(11, b.h), font, color });
        }
        continue;
      }
      // Character boxes get one character each; long answers wrap onto the printed lines below
      // (no pdf-lib maxWidth: it wraps into overlapping lines).
      const segs = q.source.cells?.length
        ? cellText(this.font, q.source.cells, cellChars(q, v, q.source.cells.length))
        : layoutText(this.font, [q.source.box, ...(q.source.more ?? [])], v);
      for (const seg of segs) {
        page.drawText(seg.text, { x: seg.box.x + 2, y: seg.box.y + Math.max(2, (seg.box.h - seg.size) / 2 + 1), size: seg.size, font, color });
      }
    }
    return doc.save();
  }
}

export interface Segment { box: PdfBox; text: string; size: number }

/**
 * Fits an answer into its box and the blank lines below it: word-wraps at the largest size that fits
 * (down to 7 pt), and only if even that overflows ends the last line with “…”. Shared by the download
 * and the preview, so what you see is what you get.
 */
export function layoutText(font: PDFFont, boxes: PdfBox[], text: string): Segment[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length || !boxes.length) return [];
  const base = Math.max(7, Math.min(11, boxes[0]!.h - 3));
  const width = (s: string, size: number) => font.widthOfTextAtSize(s, size);
  const wrap = (size: number): string[] | null => {
    const lines: string[] = [];
    let cur = '';
    for (const word of words) {
      const room = (boxes[lines.length]?.w ?? 0) - 4;
      const next = cur ? `${cur} ${word}` : word;
      if (width(next, size) <= room) { cur = next; continue; }
      if (!cur) return null; // one word wider than a whole line
      lines.push(cur);
      cur = word;
      if (lines.length >= boxes.length || width(cur, size) > (boxes[lines.length]!.w - 4)) return null;
    }
    lines.push(cur);
    return lines.length <= boxes.length ? lines : null;
  };
  for (let size = base; size >= 7; size -= 0.5) {
    const lines = wrap(size);
    if (lines) return lines.map((t, i) => ({ box: boxes[i]!, text: t, size }));
  }
  // Still too long at 7 pt: fill every line, and end the last one with an ellipsis.
  const size = 7;
  const out: Segment[] = [];
  let rest = [...words];
  boxes.forEach((box, i) => {
    let line = '';
    while (rest.length && width(line ? `${line} ${rest[0]}` : rest[0]!, size) <= box.w - 4) line = line ? `${line} ${rest.shift()}` : rest.shift()!;
    if (i === boxes.length - 1 && rest.length) {
      while (line && width(`${line}…`, size) > box.w - 4) line = line.slice(0, -1);
      line += '…';
    }
    if (line) out.push({ box, text: line, size });
  });
  return out;
}

/**
 * The characters that go into a row of boxes. Numbers lose their spaces and dashes (and a leading +91
 * when the boxes only fit the 10-digit number); text keeps a blank box between words if it fits.
 */
export function cellChars(q: FormQuestion, v: string, n: number): string[] {
  if (q.type === 'phone' || /^[\d\s+()-]+$/.test(v)) {
    let d = v.replace(/[^\d]/g, '');
    if (d.length > n && d.length === n + 2 && d.startsWith('91')) d = d.slice(2);
    return [...d];
  }
  const chars = [...v.trim().replace(/\s+/g, ' ')];
  return chars.length <= n ? chars : chars.filter((c) => c !== ' ');
}

/** One character centred in each box, sized to the box. */
export function cellText(font: PDFFont, cells: PdfBox[], chars: string[]): Segment[] {
  return chars.slice(0, cells.length).flatMap((ch, i) => {
    const cell = cells[i]!;
    if (ch === ' ') return [];
    const size = Math.max(6, Math.min(12, cell.h - 4, cell.w * 0.95));
    const w = font.widthOfTextAtSize(ch, size);
    return [{ box: { x: cell.x + (cell.w - w) / 2 - 2, y: cell.y, w: w + 4, h: cell.h }, text: ch, size }];
  });
}
