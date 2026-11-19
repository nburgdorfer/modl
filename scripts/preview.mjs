import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  port: { type: 'string', default: '8080' },
  assets: { type: 'string' },
} });
const siteRoot = await realpath('dist');
const assetRoot = values.assets ? await realpath(path.join(values.assets, 'assets')) : null;
const mime = { '.html': 'text/html', '.json': 'application/json', '.txt': 'text/plain',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = http.createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/' || url.pathname === '/modl') { response.writeHead(302, { Location: '/modl/' }).end(); return; }
    if (!url.pathname.startsWith('/modl/')) { response.writeHead(404).end(); return; }
    let relative = decodeURIComponent(url.pathname.slice('/modl/'.length)) || 'index.html';
    const fromAssets = assetRoot && relative.startsWith('assets/');
    const root = fromAssets ? assetRoot : siteRoot;
    if (fromAssets) relative = relative.slice('assets/'.length);
    const file = await realpath(path.resolve(root, relative));
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    const info = await stat(file);
    if (!info.isFile()) { response.writeHead(404).end(); return; }
    const headers = { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
      'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'Content-Length': info.size };
    let start = 0, end = info.size - 1, code = 200;
    if (request.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if (!match || (!match[1] && !match[2])) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return; }
      if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= info.size) {
        response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return;
      }
      code = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
      headers['Content-Length'] = end - start + 1;
    }
    response.writeHead(code, headers);
    if (request.method === 'HEAD' || info.size === 0) response.end();
    else {
      const stream = createReadStream(file, { start, end });
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    }
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 400).end();
  }
});
server.listen(Number(values.port), '127.0.0.1', () => {
  console.log(`Local: http://127.0.0.1:${server.address().port}/modl/`);
  if (!assetRoot) console.log('Use --assets /path/to/exhibit to preview existing local meshes.');
});
