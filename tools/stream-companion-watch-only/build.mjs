import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preferLowWatchQuality } from '../stream-companion-helper-updates/third/extension/watch-quality.js';
import { attachWatchTab } from './watch-only.mjs';

// The full companion also injects this same self-contained chooser into an
// isolated world. Package it as a static script so extras need no worker.
export async function buildWatchExtension(output) {
  await mkdir(output);
  await copyFile(new URL('./manifest.json', import.meta.url), join(output, 'manifest.json'));
  const script = `(${attachWatchTab.toString()})(${preferLowWatchQuality.toString()});\n`;
  await writeFile(join(output, 'watch-only.js'), script, { flag: 'wx' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw Error('Specify a new output directory for the unpacked extension.');
  await buildWatchExtension(resolve(process.argv[2]));
}
