// Removes leftovers of earlier app updates. Node-only, so it's kept out of
// release.mjs (which the browser preview also loads).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UPDATE_DIR_PREFIX } from './release.mjs';

const HOUR = 3_600_000;

/**
 * Deletes update temp folders older than `maxAgeMs` (a download that failed, or an
 * installer that has long finished with the folder it ran from). Never throws.
 */
export async function cleanStaleUpdates(dir = os.tmpdir(), maxAgeMs = 24 * HOUR, now = Date.now()) {
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((n) => n.startsWith(UPDATE_DIR_PREFIX))
      .map(async (n) => {
        const p = path.join(dir, n);
        try {
          const st = await fs.lstat(p);
          if (st.isDirectory() && now - st.mtimeMs > maxAgeMs) await fs.rm(p, { recursive: true, force: true });
        } catch {}
      }),
  );
}
