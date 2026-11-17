import { readFile } from 'node:fs/promises';

// The release image writes this file at build time. Do not take the running
// revision from a mutable deployment environment variable.
export async function readReleaseRevision(path: URL): Promise<string | null> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Cannot read release revision manifest');
  }
  let manifest: unknown;
  try { manifest = JSON.parse(source); }
  catch { throw new Error('Invalid release revision manifest'); }
  if (!manifest || typeof manifest !== 'object' || !('revision' in manifest) ||
      typeof manifest.revision !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.revision)) {
    throw new Error('Invalid release revision manifest');
  }
  return manifest.revision;
}
