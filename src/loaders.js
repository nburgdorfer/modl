import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { createSHMaterial } from './sh-material.js';
import workerSource from './mesh-worker.js?worker';

const SUPPORTED = new Set(['ply', 'obj', 'stl', 'glb', 'gltf', 'modl']);
const abortError = () => new DOMException('Mesh loading canceled.', 'AbortError');
const checkAbort = (signal) => { if (signal?.aborted) throw abortError(); };
const isFile = (value) => typeof File !== 'undefined' && value instanceof File;
const directory = (path) => path.slice(0, path.lastIndexOf('/') + 1);

function abortable(promise, signal, onLateResolve = () => {}) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    let canceled = signal.aborted;
    const abort = () => { canceled = true; reject(abortError()); };
    if (canceled) reject(abortError());
    else signal.addEventListener('abort', abort, { once: true });
    promise.then((value) => {
      signal.removeEventListener('abort', abort);
      if (canceled) onLateResolve(value);
      else resolve(value);
    }, (error) => {
      signal.removeEventListener('abort', abort);
      if (!canceled) reject(error);
    });
  });
}

function normalizePath(path) {
  try { path = decodeURIComponent(path); } catch { /* Keep an invalid percent escape literal. */ }
  const parts = [];
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function resources(main, files, signal) {
  const local = isFile(main);
  const objectURLs = new Map();
  const uniqueFiles = [...new Set([...(local ? [main] : []), ...files])];
  const paths = new Map(uniqueFiles.map((file) => [normalizePath(file.webkitRelativePath || file.name), file]));
  const base = local ? directory(main.webkitRelativePath || main.name) : new URL('.', new URL(main, document.baseURI)).href;
  const findFile = (path) => {
    const normalized = normalizePath(path);
    if (paths.has(normalized)) return paths.get(normalized);
    const suffixMatches = [...paths].filter(([key]) => key.endsWith(`/${normalized}`) || normalized.endsWith(`/${key}`));
    if (suffixMatches.length === 1) return suffixMatches[0][1];
    const name = normalized.split('/').pop();
    const matches = uniqueFiles.filter((file) => file.name === name);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`Several selected files are named “${name}”. Select the asset folder to preserve relative paths.`);
    throw new Error(`Missing companion file “${path}”. Select the mesh together with its material, texture, and buffer files, or select its folder.`);
  };
  const manager = new THREE.LoadingManager();
  const failures = [];
  const resolutionErrors = [];
  manager.onError = (url) => failures.push(url);
  manager.setURLModifier((url) => {
    checkAbort(signal);
    if (/^(data:|blob:)/i.test(url) || !local) return url;
    let file;
    try { file = findFile(url); }
    catch (error) { resolutionErrors.push(error); throw error; }
    if (!objectURLs.has(file)) objectURLs.set(file, URL.createObjectURL(file));
    return objectURLs.get(file);
  });
  const text = async (path) => {
    checkAbort(signal);
    if (local) return abortable(findFile(path).text(), signal);
    const response = await fetch(path, { signal });
    if (!response.ok) throw new Error(`Could not load ${path} (HTTP ${response.status}).`);
    return response.text();
  };
  return {
    manager, base, text,
    assertSuccess() {
      if (resolutionErrors.length) throw resolutionErrors[0];
      if (failures.length) throw new Error(`Could not load companion resource: ${failures[0]}. Check its path and web-server access.`);
    },
    dispose() { for (const url of objectURLs.values()) URL.revokeObjectURL(url); },
  };
}

async function readBuffer(source, onProgress, signal) {
  checkAbort(signal);
  onProgress({ stage: 'reading', loaded: 0, total: isFile(source) ? source.size : undefined });
  if (isFile(source)) {
    const buffer = await abortable(source.arrayBuffer(), signal);
    checkAbort(signal);
    onProgress({ stage: 'reading', loaded: buffer.byteLength, total: buffer.byteLength, ratio: 1 });
    return buffer;
  }
  const response = await fetch(source, { signal });
  if (!response.ok) throw new Error(`Could not load mesh (HTTP ${response.status}): ${source}`);
  // Let the browser allocate the response buffer instead of retaining chunks
  // and making an additional full-size copy for large mesh downloads.
  const buffer = await response.arrayBuffer();
  checkAbort(signal);
  onProgress({ stage: 'reading', loaded: buffer.byteLength, total: buffer.byteLength, ratio: 1 });
  return buffer;
}

function parseWorker(buffer, extension, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    let worker;
    const cleanup = () => {
      signal?.removeEventListener('abort', abort);
      worker?.terminate();
      URL.revokeObjectURL(url);
    };
    const abort = () => { cleanup(); reject(abortError()); };
    try {
      worker = new Worker(url);
      worker.onmessage = ({ data }) => {
        cleanup();
        if (data.error) reject(new Error(data.error));
        else resolve(data);
      };
      worker.onerror = (event) => {
        cleanup();
        reject(new Error(event.message || 'Mesh parsing worker failed.'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      worker.postMessage({ buffer, extension }, [buffer]);
    } catch (error) { cleanup(); reject(error); }
  });
}

function unpack(result) {
  const root = new THREE.Group();
  for (const part of result.meshes) {
    const geometry = new THREE.BufferGeometry();
    for (const [name, { array, itemSize, normalized }] of Object.entries(part.attributes)) {
      geometry.setAttribute(name, new THREE.BufferAttribute(array, itemSize, normalized));
    }
    if (part.index) geometry.setIndex(new THREE.BufferAttribute(part.index.array, part.index.itemSize, part.index.normalized));
    for (const group of part.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
    const materials = part.sh ? [createSHMaterial(part.sh.coefficients, geometry.getAttribute('position').count, part.sh.degree, part.sh.header)] : part.materials.map((value) => {
      const appearance = {
        color: new THREE.Color().fromArray(value.color),
        vertexColors: !!value.vertexColors,
        opacity: value.opacity ?? 1,
        transparent: !!value.transparent,
        side: THREE.DoubleSide,
      };
      // PLY RGB is an already rendered/baked color, including this project's
      // SH0 export. Adding another light would alter that supplied appearance.
      const material = value.vertexColors
        ? new THREE.MeshBasicMaterial({ ...appearance, toneMapped: false })
        : new THREE.MeshStandardMaterial({ ...appearance, roughness: 0.8, metalness: 0 });
      material.name = value.name || '';
      return material;
    });
    const mesh = new THREE.Mesh(geometry, materials.length === 1 ? materials[0] : materials);
    mesh.name = part.name;
    mesh.userData.hasAppearance = !!part.sh || !!geometry.getAttribute('color');
    if (part.sh) {
      mesh.userData.appearanceKind = 'spherical harmonics';
      mesh.userData.shDegree = part.sh.degree;
      root.userData.sh = part.sh.header;
    }
    mesh.applyMatrix4(new THREE.Matrix4().fromArray(part.matrix));
    root.add(mesh);
  }
  return root;
}

function validateGLTFGeometry(root) {
  const checked = new Set();
  let hasFaces = false;
  root.traverse((node) => {
    if (!node.isMesh || checked.has(node.geometry)) return;
    const geometry = node.geometry;
    checked.add(geometry);
    const position = geometry?.getAttribute('position');
    if (!position || position.itemSize !== 3) throw new Error('glTF mesh positions must have three components.');
    const count = geometry.index ? geometry.index.count : position.count;
    if (count % 3 !== 0) throw new Error('glTF mesh faces must contain complete triangles.');
    hasFaces ||= count >= 3;
    for (let i = 0; i < position.count; i++) {
      if (!Number.isFinite(position.getX(i)) || !Number.isFinite(position.getY(i)) || !Number.isFinite(position.getZ(i))) {
        throw new Error('glTF mesh contains non-finite vertex coordinates.');
      }
    }
    if (geometry.index) {
      for (let i = 0; i < geometry.index.count; i++) {
        const index = geometry.index.getX(i);
        if (!Number.isInteger(index) || index < 0 || index >= position.count) throw new Error('glTF mesh contains a face with an invalid vertex index.');
      }
    }
    const normal = geometry.getAttribute('normal');
    if (normal && normal.count !== position.count) throw new Error('glTF mesh normal count does not match its vertices.');
    if (normal) {
      for (let i = 0; i < normal.count; i++) {
        if (!Number.isFinite(normal.getX(i)) || !Number.isFinite(normal.getY(i)) || !Number.isFinite(normal.getZ(i))) throw new Error('glTF mesh contains non-finite normals.');
      }
    }
    // Recompute instead of trusting optional accessor bounds from the file.
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  });
  if (!hasFaces) throw new Error('The glTF file contains no renderable mesh faces.');
}

async function applyOBJMaterials(root, libraries, assets, signal) {
  if (!libraries.length) return;
  const creators = [];
  // Keep the manager open until all material files have been discovered, so
  // completion means every referenced texture has finished loading.
  let finish;
  const loaded = new Promise((resolve) => { finish = resolve; });
  assets.manager.onLoad = finish;
  assets.manager.itemStart('__obj_materials__');
  try {
    for (const library of libraries) {
      checkAbort(signal);
      const path = assets.base + library;
      const source = await assets.text(path);
      const creator = new MTLLoader(assets.manager).setMaterialOptions({ side: THREE.DoubleSide }).parse(source, directory(path));
      creators.push(creator);
    }
    root.traverse((node) => {
      if (!node.isMesh) return;
      const old = Array.isArray(node.material) ? node.material : [node.material];
      const replacement = old.map((material) => {
        const creator = creators.find((candidate) => Object.hasOwn(candidate.materialsInfo, material.name));
        if (!creator) return material;
        const next = creator.create(material.name);
        next.vertexColors = !!node.geometry.getAttribute('color');
        node.userData.hasAppearance = true;
        material.dispose();
        return next;
      });
      node.material = replacement.length === 1 ? replacement[0] : replacement;
    });
  } finally { assets.manager.itemEnd('__obj_materials__'); }
  await abortable(loaded, signal);
  checkAbort(signal);
  assets.assertSuccess();
}

export function disposeLoadedModel(root) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  root?.traverse((node) => {
    if (node.geometry) geometries.add(node.geometry);
    for (const material of (Array.isArray(node.material) ? node.material : [node.material])) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      for (const uniform of Object.values(material.uniforms || {})) if (uniform.value?.isTexture) textures.add(uniform.value);
    }
  });
  for (const texture of textures) {
    texture.dispose();
    texture.source?.data?.close?.();
  }
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}

/** Load a File or served URL without uploading local assets anywhere. */
export async function loadMesh(fileOrUrl, { files = [], onProgress = () => {}, signal } = {}) {
  const name = isFile(fileOrUrl) ? fileOrUrl.name : new URL(fileOrUrl, document.baseURI).pathname.split('/').pop();
  const extension = name.split('.').pop().toLowerCase();
  if (!SUPPORTED.has(extension)) throw new Error('Choose a MODL, PLY, OBJ, STL, GLB, or glTF mesh.');
  const assets = resources(fileOrUrl, files, signal);
  let root;
  try {
    const buffer = await readBuffer(fileOrUrl, onProgress, signal);
    onProgress({ stage: 'parsing' });
    if (extension === 'glb' || extension === 'gltf') {
      const gltf = await abortable(new GLTFLoader(assets.manager).parseAsync(buffer, assets.base), signal, (late) => {
        for (const scene of late.scenes || [late.scene]) disposeLoadedModel(scene);
      });
      root = gltf.scene || gltf.scenes[0];
      if (!root) throw new Error('The glTF file does not contain a scene.');
      validateGLTFGeometry(root);
      root.traverse((node) => {
        if (!node.isMesh) return;
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        node.userData.hasAppearance = !!node.geometry?.getAttribute('color') || materials.some((material) =>
          gltf.parser.associations.get(material)?.materials !== undefined || !!material.map,
        );
      });
      assets.assertSuccess();
    } else {
      const parsed = await parseWorker(buffer, extension, signal);
      root = unpack(parsed);
      if (extension === 'obj') {
        onProgress({ stage: 'resources' });
        await applyOBJMaterials(root, parsed.materialLibraries, assets, signal);
      }
    }
    checkAbort(signal);
    root.name = root.name || name;
    root.userData.sourceName = name;
    onProgress({ stage: 'ready', ratio: 1 });
    return root;
  } catch (error) {
    disposeLoadedModel(root);
    if (/No DRACOLoader|KTX2Loader|setMeshoptDecoder/.test(error.message)) {
      throw new Error('This asset uses a compressed geometry or texture codec. Export an uncompressed GLB/glTF for this offline viewer.');
    }
    throw error;
  } finally { assets.dispose(); }
}
