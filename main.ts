// main.ts — the entry program for EMBERLINE (threejs-fps-02).
//
// Copies game/ and screenshots/ from this repository into the output
// directory (MAKEFUN_OUTPUT_DIR, or /output in the grader) and writes
// /output/dossier.json with buildDossier from the kit's vendored library.
//
// Pre-flight (beyond the starter): the build refuses to run when
// screenshots/ is missing, holds anything other than 3-4 images, or holds
// an image over 256 KiB — the gate needs exactly that, and failing here is
// cheaper than failing on the server.

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDossier } from './vendor/makefun-threejs.ts';

const repo = new URL('.', import.meta.url).pathname;
const out = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const MAX_SHOTS = 4;
const MIN_SHOTS = 3;
const MAX_SHOT_BYTES = 262144;

function fail(message) {
  console.error(`main.ts: ${message}`);
  process.exit(1);
}

function checkScreenshots() {
  const dir = join(repo, 'screenshots');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    fail('screenshots/ is missing; the gate needs 3 or 4 screenshots.');
  }
  const images = readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => /\.(png|jpe?g)$/i.test(name))
    .sort();
  if (images.length < MIN_SHOTS || images.length > MAX_SHOTS) {
    fail(`screenshots/ holds ${images.length} images; the gate needs 3 or 4.`);
  }
  for (const name of images) {
    const size = statSync(join(dir, name)).size;
    if (size > MAX_SHOT_BYTES) {
      fail(`screenshots/${name} is ${size} bytes; the gate allows at most 256 KiB.`);
    }
  }
}

checkScreenshots();

mkdirSync(out, { recursive: true });
cpSync(join(repo, 'game'), join(out, 'game'), { recursive: true });
cpSync(join(repo, 'screenshots'), join(out, 'screenshots'), { recursive: true });

const dossier = buildDossier(out, {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
});
writeFileSync(join(out, 'dossier.json'), dossier);
console.log(`main.ts: wrote ${join(out, 'dossier.json')} (${dossier.length} bytes)`);
