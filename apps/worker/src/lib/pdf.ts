// Minimal dependency-free PDF writer for text reports (Helvetica, WinAnsi).
// Produces a valid multi-page PDF 1.4 document; no images or embedded fonts.

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 48;

export interface PdfLine {
  text: string;
  size?: number;
  bold?: boolean;
  gap?: number;
}

function esc(s: string): string {
  // Restrict to printable Latin-1; replace others to keep the content stream valid.
  return s.replace(/[^\x20-\x7e\xa0-\xff]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrap(text: string, size: number): string[] {
  const maxChars = Math.max(20, Math.floor((PAGE_W - 2 * MARGIN) / (size * 0.5)));
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      if ((line + ' ' + word).trim().length > maxChars) {
        if (line) out.push(line);
        line = word;
      } else line = (line + ' ' + word).trim();
    }
    out.push(line);
  }
  return out;
}

export function renderPdf(lines: PdfLine[]): Uint8Array {
  const pages: string[] = [];
  let y = PAGE_H - MARGIN;
  let ops: string[] = [];
  const flush = () => {
    pages.push(ops.join('\n'));
    ops = [];
    y = PAGE_H - MARGIN;
  };
  for (const l of lines) {
    const size = l.size ?? 10;
    for (const w of wrap(l.text, size)) {
      if (y - size < MARGIN) flush();
      ops.push(`BT /${l.bold ? 'F2' : 'F1'} ${size} Tf ${MARGIN} ${y - size} Td (${esc(w)}) Tj ET`);
      y -= size * 1.35;
    }
    y -= l.gap ?? 2;
  }
  flush();
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) ;
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(''); // pages placeholder
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const content of pages) {
    const stream = new TextEncoder().encode(content);
    add(`<< /Length ${stream.length} >>\nstream\n${content}\nendstream`);
    const contentId = objects.length;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`);
    kids.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
  let length = enc(out).length;
  const parts: string[] = [out];
  objects.forEach((body, i) => {
    offsets.push(length);
    const obj = `${i + 1} 0 obj\n${body}\nendobj\n`;
    parts.push(obj);
    length += enc(obj).length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(xref);
  out = parts.join('');
  return enc(out);
}
