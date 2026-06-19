// Parse a Bank of America "Print Transaction Details" PDF in the browser.
// The print view is a stacked table: each transaction is a main line
//   <date> <description> <type> <amount> <balance>
// plus continuation lines for wrapped description/type, and (on SafeBalance
// accounts) a standalone "Cleared" status line. We group text by vertical
// position into lines, then anchor on the amount+balance pair. This logic was
// validated in Node against Gino's real PDFs before shipping (see _pdftest.mjs).

import * as pdfjsLib from "pdfjs-dist";
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";
import type { RawRow } from "./importStatement";

// Let Vite bundle + instantiate the worker (handles the /homebase/ base path
// and the ESM worker type). The old `?url` + workerSrc path failed to load the
// worker on the deployed PWA — that is why PDF import stopped working.
pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker();

const TYPE_RE = /^(Debit|Credit|Transfer|Deposit|Other|Virtual|Card|Payment)( (Card|Payment))?$/;
const STATUS_RE = /^(Cleared|Pending|Processing|Reconcile)$/i;
const AMT_RE = /^-?\$[\d,]+\.\d{2}$/;
const BAL_RE = /^\$[\d,]+\.\d{2}$/;
const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;
const NOISE_RE =
  /Bank of America|Posting date|^Available$|^balance$|^Transactions$|Balance Summary|^View:|Account Activity|bankofamerica\.com|^\d+\/\d+$|available balance/i;

const num = (s: string) => parseFloat(s.replace(/[$,]/g, ""));

/** Group a PDF's text items into reading-order lines (one string[] per line). */
async function pdfLines(data: ArrayBuffer): Promise<string[][]> {
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const out: string[][] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const byY: Record<number, { x: number; s: string }[]> = {};
    for (const it of tc.items) {
      // TextItem has str + transform; ignore TextMarkedContent items.
      const item = it as { str?: string; transform?: number[] };
      if (!item.str || !item.str.trim() || !item.transform) continue;
      const y = Math.round(item.transform[5]);
      (byY[y] = byY[y] || []).push({ x: Math.round(item.transform[4]), s: item.str.trim() });
    }
    Object.keys(byY)
      .map(Number)
      .sort((a, b) => b - a) // top to bottom
      .forEach((y) => out.push(byY[y].sort((a, b) => a.x - b.x).map((i) => i.s)));
  }
  return out;
}

interface Building {
  date: string | null;
  amount: number;
  desc: string;
  pending: boolean;
}

function extractRows(lines: string[][]): RawRow[] {
  const txns: Building[] = [];
  let cur: Building | null = null;
  const flush = () => {
    if (cur) txns.push(cur);
    cur = null;
  };

  for (const segs of lines) {
    if (segs.every((s) => NOISE_RE.test(s) || STATUS_RE.test(s))) continue;
    if (segs.some((s) => NOISE_RE.test(s)) && !segs.some((s) => AMT_RE.test(s))) continue;

    const isMain =
      segs.length >= 2 &&
      AMT_RE.test(segs[segs.length - 2]) &&
      BAL_RE.test(segs[segs.length - 1]);

    if (isMain) {
      flush();
      const amount = num(segs[segs.length - 2]);
      const first = segs[0];
      const date = DATE_RE.test(first) ? first : null; // null => pending "Processing"
      const middle = segs.slice(1, segs.length - 2);
      const desc = middle.filter((s) => !TYPE_RE.test(s) && !STATUS_RE.test(s)).join(" ");
      cur = { date, amount, desc, pending: !date };
    } else if (cur) {
      for (const s of segs) {
        if (TYPE_RE.test(s) || STATUS_RE.test(s)) continue;
        if (/^\d{2}\/\d{2}$/.test(s) && cur.pending) continue;
        cur.desc += " " + s;
      }
    }
  }
  flush();

  return txns
    .filter((t) => !t.pending && t.date)
    .map((t) => ({
      // MM/DD/YYYY -> ISO
      date: `${t.date!.slice(6)}-${t.date!.slice(0, 2)}-${t.date!.slice(3, 5)}`,
      description: t.desc.replace(/\s{2,}/g, " ").trim(),
      amount: t.amount,
    }))
    .filter((r) => !isNaN(r.amount) && /^\d{4}-\d{2}-\d{2}$/.test(r.date));
}

/** Parse a BofA "Print Transaction Details" PDF into raw rows. Pending
 *  (not-yet-posted) transactions are skipped — they import once they clear. */
export async function parseBofaPdf(file: File): Promise<RawRow[]> {
  const data = await file.arrayBuffer();
  const lines = await pdfLines(data);
  return extractRows(lines);
}
