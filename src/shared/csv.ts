import type { PnmInput, QA } from "./protocol";

// What the host says a form column holds.
export type ColumnKind = "name" | "photo" | "question" | "ignore";

// The first separator outside quotes decides it. Comma CSV from a downloaded form export, or tab-separated text copied straight out of Google Sheets.
function detectSeparator(text: string): "," | "\t" {
  let inQuotes = false;
  for (const char of text) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (char === "," || char === "\t")) return char;
    else if (!inQuotes && char === "\n") break;
  }
  return ",";
}

// Parses CSV or tab-separated text with quoted fields, a BOM and any line ending. Blank rows are dropped.
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const separator = detectSeparator(text);

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  const endRow = () => {
    row.push(cell);
    cell = "";
    if (row.some((value) => value !== "")) rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;

    // Inside quotes everything is text, and a doubled quote is one literal quote.
    if (inQuotes) {
      if (char !== '"') cell += char;
      else if (text[index + 1] === '"') {
        cell += '"';
        index++;
      } else inQuotes = false;
    } else if (char === '"') inQuotes = true;
    else if (char === separator) {
      row.push(cell);
      cell = "";
    } else if (char === "\n") endRow();
    else cell += char;
  }

  // The last row may not end with a newline.
  if (cell !== "" || row.length > 0) endRow();

  return rows;
}

// The file id in any of the Drive share link shapes Google Forms produces.
const DRIVE_ID = /drive\.google\.com\/(?:file\/d\/|(?:open|uc)\?(?:.*&)?id=)([\w-]+)/;

// Turns a Drive share link into its thumbnail address, which serves the image itself.
export function normalizePhotoUrl(raw: string): string | null {
  // File-upload questions list multiple files as a comma-separated cell.
  const first = raw.split(",")[0]!.trim();
  if (!/^https?:\/\//i.test(first)) return null;

  // The page only loads https images, so an http link would never show.
  const url = first.replace(/^http:/i, "https:");

  const driveId = DRIVE_ID.exec(url)?.[1];
  return driveId ? `https://drive.google.com/thumbnail?id=${driveId}&sz=w800` : url;
}

// True only for addresses normalizePhotoUrl builds, so the Worker never fetches anything else.
export function isDrivePhoto(url: string): boolean {
  return /^https:\/\/drive\.google\.com\/thumbnail\?id=[\w-]+&sz=w\d+$/.test(url);
}

// A first guess at each form column, which the host can change before importing.
export function guessColumn(header: string): ColumnKind {
  const text = header.trim();

  // Contact details and form bookkeeping aren't for brothers to read.
  if (!text || /^(timestamp|score)$/i.test(text) || /e-?mail|phone/i.test(text)) return "ignore";
  if (/photo|picture|image|headshot|selfie/i.test(text)) return "photo";

  // Short enough to be a label, and not the imperative "Name three things...".
  if (/\bname\b/i.test(text) && text.length <= 30 && !/^name\s+\w/i.test(text)) return "name";
  return "question";
}

// One PNM per row with a name. Several name columns are joined, such as first and last.
export function buildPnms(rows: string[][], columns: ColumnKind[]): PnmInput[] {
  const [headers, ...body] = rows;
  if (!headers) return [];

  const pnms: PnmInput[] = [];

  for (const row of body) {
    const nameParts: string[] = [];
    let photoUrl: string | null = null;
    const answers: QA[] = [];

    columns.forEach((kind, index) => {
      const value = (row[index] ?? "").trim();
      if (kind === "name" && value) nameParts.push(value);
      else if (kind === "photo" && !photoUrl) photoUrl = normalizePhotoUrl(value);
      else if (kind === "question" && value) answers.push({ q: (headers[index] ?? "").trim(), a: value });
    });

    if (nameParts.length > 0) pnms.push({ name: nameParts.join(" "), photoUrl, answers });
  }

  return pnms;
}

// Cells that start like a formula get a leading quote so spreadsheets show them as text.
export function toCsv(rows: (string | number)[][]): string {
  const cell = (value: string | number) => {
    if (typeof value === "number") return String(value);

    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
  };

  return rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
