import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial } from 'three';

function parseMODL(buffer) {
  if (buffer.byteLength < 12 || new TextDecoder().decode(new Uint8Array(buffer, 0, 8)) !== 'MODLSH01') {
    throw new Error('Invalid MODL SH file signature.');
  }
  const headerLength = new DataView(buffer).getUint32(8, true);
  if (headerLength > 1024 * 1024 || headerLength > buffer.byteLength - 12) throw new Error('Invalid MODL SH header length.');
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, headerLength)));
  const { vertexCount, faceCount, degree, coefficientCount } = header;
  if (header.shConvention && header.shConvention !== 'modl') throw new Error('MODL SH coefficients must use the MODL basis convention.');
  if (![vertexCount, faceCount].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid MODL vertex or face count.');
  if (!Number.isInteger(degree) || degree < 0 || degree > 3 || coefficientCount !== 48) throw new Error('MODL requires degree 0–3 and 48 coefficients per vertex.');
  let offset = 12 + Math.ceil(headerLength / 4) * 4;
  const expected = offset + vertexCount * 3 * 4 + faceCount * 3 * 4 + vertexCount * 48 * 4;
  if (!Number.isSafeInteger(expected) || expected !== buffer.byteLength) throw new Error('MODL SH payload size does not match its header.');
  const geometry = new BufferGeometry();
  // Isolate small geometry arrays from the large coefficient backing buffer so
  // the latter can be freed after the GPU texture's padded storage is prepared.
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(buffer, offset, vertexCount * 3).slice(), 3));
  offset += vertexCount * 3 * 4;
  geometry.setIndex(new BufferAttribute(new Uint32Array(buffer, offset, faceCount * 3).slice(), 1));
  offset += faceCount * 3 * 4;
  const coefficients = new Float32Array(buffer, offset, vertexCount * 48);
  for (const value of coefficients) if (!Number.isFinite(value)) throw new Error('MODL SH coefficients must be finite.');
  return { geometry, sh: { degree, coefficients, header } };
}

// Parse large text/binary meshes away from the UI thread, then transfer their
// typed-array storage. No JSON expansion or second copy of the mesh is needed.
self.onmessage = ({ data: { buffer, extension } }) => {
  try {
    let root;
    let sh;
    if (extension === 'modl') {
      const parsed = parseMODL(buffer);
      sh = parsed.sh;
      root = new Mesh(parsed.geometry, new MeshStandardMaterial());
    } else if (extension === 'ply') {
      const header = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 1024 * 1024)));
      const headerEnd = header.indexOf('end_header');
      if (headerEnd < 0 || !/^element\s+face\s+[1-9]\d*\s*$/m.test(header.slice(0, headerEnd))) {
        throw new Error('This PLY has no faces. Select a triangle mesh, not a point cloud.');
      }
      const geometry = new PLYLoader().parse(buffer);
      root = new Mesh(geometry, new MeshStandardMaterial({ vertexColors: !!geometry.getAttribute('color') }));
    } else if (extension === 'stl') {
      const geometry = new STLLoader().parse(buffer);
      root = new Mesh(geometry, new MeshStandardMaterial({
        vertexColors: !!geometry.getAttribute('color'),
        opacity: geometry.alpha ?? 1,
        transparent: geometry.alpha < 1,
      }));
    } else if (extension === 'obj') {
      root = new OBJLoader().parse(new TextDecoder().decode(buffer));
    } else {
      throw new Error(`Unsupported worker mesh format: ${extension}`);
    }

    root.updateMatrixWorld(true);
    const buffers = new Set();
    const attribute = (value) => {
      if (!value) return null;
      buffers.add(value.array.buffer);
      return { array: value.array, itemSize: value.itemSize, normalized: value.normalized };
    };
    const meshes = [];
    root.traverse((node) => {
      if (!node.isMesh) return;
      const geometry = node.geometry;
      const position = geometry.getAttribute('position');
      if (!position?.count || (geometry.index ? geometry.index.count : position.count) < 3) return;
      for (let i = 0; i < position.array.length; i++) {
        if (!Number.isFinite(position.array[i])) throw new Error('Mesh contains non-finite vertex coordinates.');
      }
      if (geometry.index) {
        for (const index of geometry.index.array) {
          if (index >= position.count || index < 0) throw new Error('Mesh contains a face with an invalid vertex index.');
        }
      }
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const materials = (Array.isArray(node.material) ? node.material : [node.material]).map((material) => ({
        name: material.name,
        color: material.color?.toArray() ?? [1, 1, 1],
        opacity: material.opacity,
        transparent: material.transparent,
        vertexColors: material.vertexColors,
      }));
      meshes.push({
        name: node.name,
        matrix: node.matrixWorld.toArray(),
        attributes: Object.fromEntries(Object.entries(geometry.attributes).map(([key, value]) => [key, attribute(value)])),
        index: attribute(geometry.index),
        groups: geometry.groups,
        materials,
        ...(sh ? { sh } : {}),
      });
      if (sh) buffers.add(sh.coefficients.buffer);
    });
    if (!meshes.length) throw new Error('The file contains no renderable mesh faces.');
    self.postMessage({ meshes, materialLibraries: root.materialLibraries ?? [] }, [...buffers]);
  } catch (error) {
    self.postMessage({ error: error.message || String(error) });
  }
};
