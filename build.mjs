import { build } from 'esbuild';
import { readFile, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assetBaseURL } from './src/asset-urls.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(path.join(root, 'public/site-config.json'), 'utf8'));
if (process.argv.includes('--pages') && config.pagesMode === 'not-found') {
  await rm(path.join(root, 'dist'), { recursive: true, force: true });
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await copyFile(path.join(root, '404.html'), path.join(root, 'dist/404.html'));
  await writeFile(path.join(root, 'dist/.nojekyll'), '');
  console.log('Built temporary 404 site without an index page, models, or videos.');
  process.exit(0);
}
if (process.env.ASSET_BASE_URL?.trim()) config.assetBaseUrl = process.env.ASSET_BASE_URL.trim();
assetBaseURL(config, 'https://nburgdorfer.github.io/modl/scenes.json');
const placeholder = process.argv.includes('--placeholder') ||
  (process.argv.includes('--pages') && !config.assetBaseUrl?.trim());
config.modelsEnabled = !placeholder;
const manifest = JSON.parse(await readFile(path.join(root, 'public/scenes.json'), 'utf8'));
if (placeholder) {
  for (const scene of manifest.scenes) {
    scene.models = [null, null, null, null];
    scene.videos = [];
  }
}
const workerPlugin = {
  name: 'inline-worker',
  setup(builder) {
    builder.onResolve({ filter: /\?worker$/ }, args => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?worker$/, '')),
      namespace: 'worker-text',
    }));
    builder.onLoad({ filter: /.*/, namespace: 'worker-text' }, async args => {
      const result = await build({ entryPoints: [args.path], bundle: true, write: false,
        format: 'iife', platform: 'browser', target: 'es2022', minify: true });
      return { contents: result.outputFiles[0].text, loader: 'text' };
    });
  },
};
const result = await build({
  entryPoints: [path.join(root, 'src/app.js')], bundle: true, write: false,
  format: 'iife', platform: 'browser', target: 'es2022', minify: true,
  legalComments: 'inline', plugins: [workerPlugin],
});
const [template, css] = await Promise.all([
  readFile(path.join(root, 'src/index.html'), 'utf8'),
  readFile(path.join(root, 'src/style.css'), 'utf8'),
]);
const html = template.replace('/* INLINE_STYLE */', css)
  .replace('/* INLINE_SCRIPT */', () => result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script'));
await rm(path.join(root, 'dist'), { recursive: true, force: true });
await mkdir(path.join(root, 'dist'), { recursive: true });
await writeFile(path.join(root, 'dist/index.html'), html);
await copyFile(path.join(root, 'node_modules/three/LICENSE'), path.join(root, 'dist/THREE-LICENSE.txt'));
await writeFile(path.join(root, 'dist/scenes.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(path.join(root, 'dist/site-config.json'), JSON.stringify(config, null, 2) + '\n');
await writeFile(path.join(root, 'dist/.nojekyll'), '');
console.log(`Built ${placeholder ? 'placeholder page' : 'static viewer'}: ${path.join(root, 'dist/index.html')} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB). ${placeholder ? 'Models and videos are coming soon.' : 'Meshes and videos are hosted separately.'}`);
