import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createHash } from 'node:crypto';
import sharp from 'sharp';

const run = promisify(execFile);
export const schoolRenderVersion = 'pdf-visible-rgb-2400-v1';
const limits = { timeout: 8000, maxBuffer: 4 * 1024 * 1024 };
export const maxPdfBytes = 10 * 1024 * 1024;

async function withPdf<T>(pdf: Buffer, action: (path: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), 'beitibao-pdf-'));
  try {
    const path = join(directory, 'paper.pdf');
    await writeFile(path, pdf, { mode: 0o600 });
    return await action(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function extractPages(pdf: Buffer) {
  return withPdf(pdf, async (path) => {
    const info = await run('pdfinfo', [path], { ...limits, env: { ...process.env, LC_ALL: 'C' } });
    const count = Number(info.stdout.match(/^Pages:\s+(\d+)$/m)?.[1]);
    if (!Number.isInteger(count) || count < 1 || count > 30 || /^Encrypted:\s+yes/m.test(info.stdout)) {
      throw new Error('INVALID_PDF');
    }
    const result = await run('pdftotext', ['-layout', '-enc', 'UTF-8', path, '-'], limits);
    const pages = result.stdout.split('\f');
    return Array.from({ length: count }, (_, index) => (pages[index] ?? '').trim().slice(0, 24000));
  });
}

export function renderPage(pdf: Buffer, page: number, size = 1300) {
  return withPdf(pdf, async (path) => {
    const result = await run('pdftoppm', [
      '-f', String(page), '-l', String(page), '-scale-to', String(size), '-singlefile', '-png', path
    ], { ...limits, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' });
    return result.stdout;
  });
}

export function schoolPageFingerprints(pdf: Buffer, count: number) {
  return withPdf(pdf, async (path) => {
    const directory = path.slice(0, path.lastIndexOf('/'));
    await run('pdftoppm', ['-f', '1', '-l', String(count), '-scale-to', '2400', '-png', path, join(directory, 'page')],
      { ...limits, timeout: 60_000 });
    const names = (await readdir(directory)).filter(name => /^page-\d+\.png$/u.test(name)).sort();
    if (names.length !== count) throw new Error('PDF_FINGERPRINT_FAILED');
    const fingerprints: string[] = [];
    for (const name of names) {
      const { data, info } = await sharp(join(directory, name), { limitInputPixels: 2400 * 2400 })
        .toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
      fingerprints.push(createHash('sha256').update(`${info.width}:${info.height}:${info.channels}:`).update(data).digest('hex'));
    }
    return fingerprints;
  });
}
