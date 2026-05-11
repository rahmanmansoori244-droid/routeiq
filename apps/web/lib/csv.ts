import Papa from 'papaparse';
import * as XLSX from 'xlsx';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 50_000;
const PARSE_TIMEOUT_MS = 10_000;

const ALLOWED_TYPES = new Set([
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export interface ParsedFile {
  fileName: string;
  fileType: string;
  rows: Record<string, string>[];
  warnings: string[];
}

export async function parseUpload(file: File): Promise<ParsedFile> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`File too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB).`);
  }
  if (file.type && !ALLOWED_TYPES.has(file.type)) {
    throw new Error(`Unsupported file type: ${file.type}. Use CSV or XLSX.`);
  }

  const fileName = sanitizeFileName(file.name);
  const isExcel =
    file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    file.type === 'application/vnd.ms-excel' ||
    /\.xlsx?$/i.test(file.name);

  const warnings: string[] = [];

  if (isExcel) {
    const arr = new Uint8Array(await file.arrayBuffer());
    const rows = await withTimeout(
      Promise.resolve(parseExcel(arr)),
      PARSE_TIMEOUT_MS,
      'XLSX parse timed out (possible zip bomb).',
    );
    if (rows.length > MAX_ROWS) {
      throw new Error(`Too many rows: ${rows.length}. Max ${MAX_ROWS}.`);
    }
    return { fileName, fileType: 'xlsx', rows, warnings };
  }

  const text = await file.text();
  const result = await withTimeout(parseCsv(text), PARSE_TIMEOUT_MS, 'CSV parse timed out.');
  if (result.rows.length > MAX_ROWS) {
    throw new Error(`Too many rows: ${result.rows.length}. Max ${MAX_ROWS}.`);
  }
  if (result.errors.length) {
    for (const e of result.errors.slice(0, 5)) {
      warnings.push(`CSV parse warning at row ${e.row}: ${e.message}`);
    }
  }
  return { fileName, fileType: 'csv', rows: result.rows, warnings };
}

function parseExcel(buffer: Uint8Array): Record<string, string>[] {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: false, cellNF: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
  return rows.map((r) => normalizeKeys(r));
}

function parseCsv(text: string): Promise<{ rows: Record<string, string>[]; errors: Papa.ParseError[] }> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, unknown>>(text, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.trim().toLowerCase(),
      complete: (res) => resolve({ rows: res.data.map(normalizeKeys), errors: res.errors }),
      error: (err: Error) => reject(err),
    });
  });
}

function normalizeKeys(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    const key = k.trim().toLowerCase();
    out[key] = v == null ? '' : String(v).trim();
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function sanitizeFileName(name: string): string {
  return name
    .replace(/[/\\]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}
