/**
 * QR codes drawn as vectors: one SVG path per code, crisp at any print size and tiny. Shared by the
 * driver sheets (PDF) and the plan screen's Driver link dialog, which gets the path from the server
 * (GET /api/dispatch/driver-links), so the `qrcode` package stays out of the browser bundle.
 */
import { create as createQr } from 'qrcode';

/** The modules of `text` as one path ("M x y H x2 V y2 H x Z" per run of dark modules) and the code's size in modules. */
export function qrPath(text: string, level: 'L' | 'M' = 'M'): { size: number; d: string } {
  const m = createQr(text, { errorCorrectionLevel: level }).modules;
  const parts: string[] = [];
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; ) {
      if (!m.get(r, c)) {
        c++;
        continue;
      }
      const c0 = c;
      while (c < m.size && m.get(r, c)) c++;
      parts.push(`M${c0} ${r}H${c}V${r + 1}H${c0}Z`);
    }
  }
  return { size: m.size, d: parts.join('') };
}
