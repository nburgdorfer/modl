import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assetBaseURL, resolveAssetURL } from '../src/asset-urls.js';

const manifestURL = 'https://nburgdorfer.github.io/modl/scenes.json';
test('local assets stay under the GitHub Pages project path', () => {
  const base = assetBaseURL({ assetBaseUrl: '' }, manifestURL);
  assert.equal(resolveAssetURL('assets/scan055/model-1/modl.modl', base),
    'https://nburgdorfer.github.io/modl/assets/scan055/model-1/modl.modl');
});

test('an external asset directory works with or without a trailing slash', () => {
  for (const url of ['https://cdn.example.org/results/v1', 'https://cdn.example.org/results/v1/']) {
    const base = assetBaseURL({ assetBaseUrl: url }, manifestURL);
    assert.equal(resolveAssetURL('assets/object/mesh.glb', base), 'https://cdn.example.org/results/v1/assets/object/mesh.glb');
  }
});

test('configured hosting rejects insecure URLs and embedded credentials', () => {
  for (const url of ['http://cdn.example.org/', 'file:///tmp/', 'https://name:password@cdn.example.org/', 'https://cdn.example.org/?token=example', 'https://cdn.example.org/#fragment', '/assets']) {
    assert.throws(() => assetBaseURL({ assetBaseUrl: url }, manifestURL));
  }
  assert.throws(() => assetBaseURL({ assetBaseUrl: 12 }, manifestURL));
});

test('manifest entries cannot escape the configured directory', () => {
  const base = assetBaseURL({ assetBaseUrl: 'https://cdn.example.org/modl/' }, manifestURL);
  for (const src of ['../private/file.ply', '%2e%2e/private/file.ply', '/elsewhere/file.ply', '//elsewhere.example.org/file.glb', 'data:text/plain,hello', 'javascript:alert(1)', '']) {
    assert.throws(() => resolveAssetURL(src, base));
  }
});

test('all prepared meshes and videos resolve locally and externally', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/scenes.json', import.meta.url), 'utf8'));
  const entries = manifest.scenes.flatMap(scene => [...scene.models, ...(scene.videos || [])]).filter(Boolean);
  assert.equal(manifest.scenes.length, 15);
  assert.equal(entries.length, 67);
  for (const entry of entries) {
    assert.ok(entry.src.startsWith('assets/'));
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes > 0);
    for (const config of [{}, { assetBaseUrl: 'https://cdn.example.org/v1/' }]) {
      assert.ok(resolveAssetURL(entry.src, assetBaseURL(config, manifestURL)).endsWith(entry.src));
    }
  }
});
