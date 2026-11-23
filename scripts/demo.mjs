import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip, gzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoDirectory = path.join(root, 'public/demo');
// Each compressed part stays below GitHub's 50 MiB large-file warning.
const chunkBytes = 48 * 1024 * 1024;

async function importDemo(source) {
  await mkdir(demoDirectory, { recursive: true });
  const hash = createHash('sha256');
  const manifest = { bytes: 0, sha256: '', parts: [] };
  for await (const chunk of createReadStream(source, { highWaterMark: chunkBytes })) {
    const name = `demo-${String(manifest.parts.length).padStart(3, '0')}.html.gz`;
    await writeFile(path.join(demoDirectory, name), gzipSync(chunk, { level: 9 }));
    hash.update(chunk);
    manifest.bytes += chunk.length;
    manifest.parts.push(name);
  }
  if (!manifest.bytes) throw new Error('The demo HTML is empty.');
  manifest.sha256 = hash.digest('hex');
  await writeFile(path.join(demoDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const name of await readdir(demoDirectory)) {
    if (/^demo-\d+\.html\.gz$/.test(name) && !manifest.parts.includes(name)) {
      await rm(path.join(demoDirectory, name));
    }
  }
  console.log(`Imported demo (${manifest.bytes} bytes) into ${manifest.parts.length} compressed parts.`);
}

export async function buildDemo(destination) {
  const manifest = JSON.parse(await readFile(path.join(demoDirectory, 'manifest.json'), 'utf8'));
  const hash = createHash('sha256');
  let bytes = 0;
  async function* parts() {
    for (const name of manifest.parts) {
      if (!/^demo-\d+\.html\.gz$/.test(name)) throw new Error('Invalid demo part name.');
      yield* createReadStream(path.join(demoDirectory, name));
    }
  }
  await pipeline(
    Readable.from(parts()),
    createGunzip(),
    new Transform({
      transform(chunk, encoding, callback) {
        hash.update(chunk);
        bytes += chunk.length;
        callback(null, chunk);
      },
    }),
    createWriteStream(destination),
  );
  if (bytes !== manifest.bytes || hash.digest('hex') !== manifest.sha256) {
    await rm(destination, { force: true });
    throw new Error('Demo checksum mismatch. Re-import the complete demo HTML.');
  }
  return bytes;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: npm run import:demo -- /path/to/demo.html');
  await importDemo(path.resolve(process.argv[2]));
}
