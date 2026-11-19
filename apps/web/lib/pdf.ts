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
  boxes: Record<string, { page: number; box: PdfBox; more?: PdfBox[]; optionBoxes?: Record<string, PdfBox> }>;
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
  const stack: Matrix[] = [];
  let m: Matrix = [1, 0, 0, 1, 0, 0];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] ?? [];
    if (fn === OPS.save) stack.push(m);
    else if (fn === OPS.restore) m = stack.pop() ?? m;
    else if (fn === OPS.transform) m = mul(args as unknown as Matrix, m);
    else if (fn === OPS.constructPath) {
      const mm = args[args.length - 1] as ArrayLike<number> | null;
      if (!mm || mm.length < 4 || ![mm[0], mm[1], mm[2], mm[3]].every(Number.isFinite)) continue;
      const pts = [[mm[0]!, mm[1]!], [mm[2]!, mm[1]!], [mm[0]!, mm[3]!], [mm[2]!, mm[3]!]].map(([x, y]) => [x! * m[0] + y! * m[2] + m[4], x! * m[1] + y! * m[3] + m[5]]);
      const xs = pts.map((p) => p[0]!), ys = pts.map((p) => p[1]!);
      const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y;
      if (w >= 30 && h <= 2.5) rules.push({ page, x1: x, x2: x + w, y });
      else if (w >= 24 && h >= 24 && w < 500) rects.push({ page, x, y, w, h });
      else if (w >= 6 && w <= 20 && h >= 6 && h <= 20 && Math.abs(w - h) <= 4) rects.push({ page, x, y, w, h }); // a printed tick box
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
    const it = byId.get(cand.itemId);
    if (!it) continue;
    const pw = pages[it.page]?.width ?? 612;
    const pageRules = rules.filter((r) => r.page === it.page);
    const sameLine = items.filter((o) => o.page === it.page && Math.abs(o.y - it.y) <= 3 && o.x > it.x + it.w - 1);
    // Skip short connector text like ":" or "(or)" when finding where the answer space starts.
    const filler = sameLine.filter((o) => !labelIds.has(o.id) && o.text.length <= 6 && !(cand.options ?? []).some((op) => op.itemId === o.id));
    const start = Math.max(it.x + it.w, ...filler.map((o) => o.x + o.w)) + 4;
    const nextLabel = sameLine.filter((o) => (labelIds.has(o.id) || o.text.length > 6) && o.x >= start).sort((a, b) => a.x - b.x)[0];
    const h = Math.max(14, it.h + 6);

    let box: PdfBox | null = null;
    // 1. The answer line printed for this label: on (or just under) the text's baseline, starting to its right.
    const line = pageRules
      .filter((r) => !used.has(r) && r.y <= it.y + 4 && r.y >= it.y - 8 && r.x2 > start + 20 && r.x1 >= it.x + it.w - 12 && (!nextLabel || r.x1 < nextLabel.x))
      .sort((a, b) => a.x1 - b.x1)[0];
    if (line) {
      used.add(line);
      const x = Math.max(line.x1, start - 2);
      box = { x, y: line.y + 1, w: line.x2 - x, h };
    } else {
      // 2. Up to the next label, a tall frame (photo box) on this line, or the cell it starts in.
      const lineTop = it.y + it.h + 2, lineBottom = it.y - 6;
      const frame = rects
        .filter((r) => r.page === it.page && r.h >= 40 && r.x >= start && r.y < lineTop && r.y + r.h > lineBottom)
        .sort((a, b) => a.x - b.x)[0];
      const cell = rects.find((r) => r.page === it.page && r.h < 40 && start >= r.x && start < r.x + r.w && it.y >= r.y - 2 && it.y <= r.y + r.h);
      const end = Math.min(nextLabel ? nextLabel.x : pw - 36, frame ? frame.x : Infinity, cell ? cell.x + cell.w : Infinity, pw - 36) - 6;
      if (end - start >= 50) box = { x: start, y: it.y - 4, w: end - start, h };
    }
    // 3. No room on the line: underneath.
    box ??= { x: it.x, y: it.y - h - 4, w: Math.min(260, pw - it.x - 36), h };

    // Blank answer lines straight below, with no label of their own: room for long answers.
    const more: PdfBox[] = [];
    if (!cand.options?.length) {
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
    const raw = byId.get(c.itemId)?.text ?? c.label;
    const control = /signature|thumb impression/i.test(c.label) ? 'signature' : /photo/i.test(c.label) ? 'file' : c.type;
    const { support, reason } = classifySupport(c.label, control);
    const options = c.options?.map((o) => o.text);
    questions.push({
      id, label: c.label, type: options?.length && c.type === 'text' ? 'choice' : c.type, options, required: c.required, support, supportReason: reason,
      source: { kind: 'pdf-flat', fileName, page: b.page, box: b.box, more: b.more, optionBoxes: b.optionBoxes, uppercase: /block letters|capital letters/i.test(raw + ' ' + c.label) },
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
      if (!q.source.optionBoxes || !q.options?.length) this.assertEncodable(v);
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
    if (v === undefined || q.source.kind !== 'pdf-flat') return [];
    return layoutText(this.font, [q.source.box, ...(q.source.more ?? [])], v);
  }

  /** The filled file. AwaazForm never submits it; the user downloads it and submits it themselves. */
  async export(): Promise<Uint8Array> {
    if (this.plan.kind === 'acroform') {
      this.doc.getForm().updateFieldAppearances(this.font);
      return this.doc.save();
    }
    const pages = this.doc.getPages();
    for (const q of this.plan.questions) {
      const v = this.flatValues.get(q.id);
      if (v === undefined || q.source.kind !== 'pdf-flat') continue;
      const page = pages[q.source.page];
      if (!page) continue;
      const color = rgb(0.05, 0.1, 0.45);
      if (q.source.optionBoxes && q.options?.length) {
        // Tick the printed box for each chosen option.
        for (const choice of v.split(', ')) {
          const b = q.source.optionBoxes[choice];
          if (b) page.drawText('X', { x: b.x + 2, y: b.y + 2, size: Math.min(11, b.h), font: this.font, color });
        }
        continue;
      }
      // Long answers wrap onto the printed lines below (no pdf-lib maxWidth: it wraps into overlapping lines).
      for (const seg of layoutText(this.font, [q.source.box, ...(q.source.more ?? [])], v)) {
        page.drawText(seg.text, { x: seg.box.x + 2, y: seg.box.y + Math.max(2, (seg.box.h - seg.size) / 2 + 1), size: seg.size, font: this.font, color });
      }
    }
    return this.doc.save();
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
