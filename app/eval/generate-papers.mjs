import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const destination = new URL('./papers/', import.meta.url);

function makePdf(objects) {
  const parts = [Buffer.from('%PDF-1.4\n')];
  const offsets = [];
  let position = parts[0].length;
  for (const [index, object] of objects.entries()) {
    const bytes = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(object), Buffer.from('\nendobj\n')]);
    offsets.push(position);
    parts.push(bytes);
    position += bytes.length;
  }
  const entries = offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`));
  return Buffer.concat(parts);
}

function stream(commands, fields = '') {
  return Buffer.concat([
    Buffer.from(`<< /Length ${Buffer.byteLength(commands)} ${fields} >>\nstream\n`),
    Buffer.from(commands),
    Buffer.from('\nendstream')
  ]);
}

function textPdf(pages) {
  const children = pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ');
  return makePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${children}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...pages.flatMap((lines, index) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      stream('BT /F1 14 Tf 20 TL 45 760 Td ' + lines.map(line => `(${line}) Tj T*`).join(' ') + ' ET')
    ])
  ]);
}

const papers = {
  'dev-cs': [['1. Which structure follows FIFO?', 'A. Stack', 'B. Queue']],
  'dev-math': [['1. Solve 2x + 3 = 11.']],
  'eval-cs': [['1. Which traversal visits nodes by level?', 'A. Depth-first', 'B. Breadth-first'],
    ['2. Explain why binary search requires sorted input.']],
  'eval-math': [['1. Find the determinant of [[2, 1], [3, 4]].']]
};
for (const [id, pages] of Object.entries(papers)) {
  writeFileSync(new URL(id + '.pdf', destination), textPdf(pages));
}

const temp = mkdtempSync(join(tmpdir(), 'beitibao-eval-'));
try {
  const source = join(temp, 'source.pdf');
  writeFileSync(source, textPdf([['1. A 2 kg mass accelerates at 3 m/s^2.', 'What is the net force in N?']]));
  const raster = execFileSync('pdftoppm', ['-scale-to', '842', '-singlefile', source], { maxBuffer: 4 * 1024 * 1024 });
  const ppmHeader = /^P6\s+(\d+)\s+(\d+)\s+255\n/.exec(raster.subarray(0, 128).toString('latin1'));
  if (!ppmHeader) throw new Error('Unexpected Poppler raster header');
  const [, width, height] = ppmHeader;
  const pixels = raster.subarray(ppmHeader[0].length);
  if (pixels.length !== Number(width) * Number(height) * 3) throw new Error('Unexpected raster size');
  const { deflateSync } = await import('node:zlib');
  writeFileSync(new URL('eval-physics.pdf', destination), makePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Scan 5 0 R >> >> /Contents 4 0 R >>',
    stream('q 595 0 0 842 0 0 cm /Scan Do Q'),
    stream(deflateSync(pixels), `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`)
  ]));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
writeFileSync(new URL('eval-broken.pdf', destination), '%PDF-1.7\nsynthetic invalid input\n');
