import * as THREE from 'three';
import { ComparisonRenderer } from './renderer.js';
import { loadMesh, disposeLoadedModel } from './loaders.js';
import { assetBaseURL, resolveAssetURL } from './asset-urls.js';

const $ = (selector) => document.querySelector(selector);
const DEFAULT_METHODS = ['MODL', '2DGS', 'TriangleSplatting', 'MeshSplatting'];
const TITLE = 'Watertight Mesh Optimization of Textured Objects';
const grid = $('#comparison-grid');
const cards = [];
const controllers = [null, null, null, null];
let renderer;
let project;
let assetBase;
let currentDataset = 'AriaDTC';
let currentScene;
let sceneToken = 0;
let currentMode = 'geometry';
let modelsEnabled = true;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function status(message = '', error = false) {
  $('#global-status').textContent = message;
  $('#global-status').classList.toggle('error', error);
}
function slotMessage(index, message = '', error = false) {
  cards[index].message.textContent = message;
  cards[index].message.classList.toggle('error', error);
}
function updateModeDescription() {
  const description = $('#mode-description');
  description.textContent = {
    geometry: '',
    appearance: 'Explore color and surface detail from every angle.',
    wireframe: 'Triangle edges over solid surfaces. Edges behind the surface are hidden.',
  }[currentMode];
  description.parentElement.hidden = !description.textContent;
}
function setMethodLabels(names = project?.methods || DEFAULT_METHODS) {
  names.forEach((name, i) => {
    cards[i].name.textContent = name;
    cards[i].viewport.setAttribute('aria-label', modelsEnabled
      ? `${name} interactive mesh. Arrow keys rotate; Shift arrows pan; plus/minus zoom.`
      : `${name} reconstruction coming soon.`);
  });
}
for (let index = 0; index < 4; index++) {
  const card = element('article', 'mesh-card');
  const heading = element('div', 'card-heading');
  const title = element('h3');
  const name = element('span', 'method-name', DEFAULT_METHODS[index]);
  title.append(name);
  heading.append(title);
  if (index === 0) heading.append(element('span', 'ours-badge', 'OURS'));
  const viewport = element('div', 'viewport');
  viewport.tabIndex = 0;
  viewport.setAttribute('role', 'img');
  viewport.setAttribute('aria-label', `${DEFAULT_METHODS[index]} interactive mesh. Drag to rotate, scroll to zoom. Keyboard arrows rotate, Shift arrows pan.`);
  const overlay = element('div', 'slot-overlay');
  const message = element('span', 'slot-message');
  overlay.append(message);
  viewport.append(overlay);
  const info = element('div', 'card-info');
  const stats = element('div', 'mesh-stats');
  const triangles = element('span', '', '— triangles');
  stats.append(triangles);
  info.append(stats);
  card.append(heading, viewport, info);
  grid.append(card);
  cards.push({ card, name, viewport, message, triangles });
}

function applyTransform(root, entry = {}) {
  const group = new THREE.Group();
  group.add(root);
  for (const key of ['position', 'rotation']) {
    if (entry[key] !== undefined) {
      if (!Array.isArray(entry[key]) || entry[key].length !== 3 || !entry[key].every(Number.isFinite)) throw new Error(`${key} must contain three finite numbers.`);
      group[key].set(...entry[key]);
    }
  }
  if (entry.scale !== undefined) {
    const value = typeof entry.scale === 'number' ? [entry.scale, entry.scale, entry.scale] : entry.scale;
    if (!Array.isArray(value) || value.length !== 3 || !value.every((v) => Number.isFinite(v) && v > 0)) throw new Error('scale must be a positive number or three positive numbers.');
    group.scale.set(...value);
  }
  group.userData = { ...root.userData };
  return group;
}

async function loadSlot(index, source, transform) {
  controllers[index]?.abort();
  const controller = new AbortController();
  controllers[index] = controller;
  const { signal } = controller;
  slotMessage(index, 'Loading reconstruction…');
  cards[index].card.setAttribute('aria-busy', 'true');
  let loaded;
  let attached = false;
  try {
    loaded = await loadMesh(source, { signal });
    if (signal.aborted) { disposeLoadedModel(loaded); return false; }
    renderer.setModel(index, applyTransform(loaded, transform));
    attached = true;
    slotMessage(index);
    return true;
  } catch (error) {
    if (loaded && !attached) disposeLoadedModel(loaded);
    if (error.name !== 'AbortError' && !signal.aborted) {
      console.error('Reconstruction loading failed:', error);
      slotMessage(index, 'This reconstruction could not be displayed.', true);
    }
    return false;
  } finally {
    if (controllers[index] === controller) {
      cards[index].card.removeAttribute('aria-busy');
      controllers[index] = null;
    }
  }
}
function fitScene() { renderer?.fit(currentScene?.fitReference ?? null); }
function clearScene() {
  sceneToken++;
  $('#set-up-direction').disabled = true;
  controllers.forEach((controller) => controller?.abort());
  renderer?.clear();
  cards.forEach((card, index) => {
    card.card.removeAttribute('aria-busy');
    slotMessage(index);
  });
  clearVideos();
  $('#load-scene').disabled = !modelsEnabled;
  $('#load-scene').textContent = modelsEnabled ? 'Load scene' : 'Coming soon';
}
function visibleMethods(indices) {
  cards.forEach((card, i) => {
    card.card.hidden = !indices.includes(i);
    const order = indices.indexOf(i) + 1;
    card.card.style.order = order;
  });
  grid.style.setProperty('--columns', indices.length);
  grid.classList.toggle('two-methods', indices.length === 2);
  renderer?.invalidate();
}
function resolveAsset(src) {
  return resolveAssetURL(src, assetBase);
}

function validateProject(value) {
  if (!value || !Array.isArray(value.scenes) || !value.scenes.length) throw new Error('scenes.json needs a non-empty scenes array.');
  if (value.methods !== undefined && (!Array.isArray(value.methods) || value.methods.length !== 4 || !value.methods.every((x) => typeof x === 'string' && x.trim()))) throw new Error('methods must contain four names.');
  if (value.datasets !== undefined && (!Array.isArray(value.datasets) || !value.datasets.length || !value.datasets.every((x) => typeof x === 'string' && x.trim()))) throw new Error('datasets must be a list of names.');
  const ids = new Set();
  for (const scene of value.scenes) {
    if (!scene || typeof scene.id !== 'string' || !scene.id || ids.has(scene.id)) throw new Error('Every scene needs a unique id.');
    ids.add(scene.id);
    if (!Array.isArray(scene.models) || scene.models.length !== 4) throw new Error(`${scene.id}: models needs four slots; use null for unavailable methods.`);
    if (scene.dataset !== undefined && typeof scene.dataset !== 'string') throw new Error(`${scene.id}: dataset must be a name.`);
    if (scene.methodLabels !== undefined && (!Array.isArray(scene.methodLabels) || scene.methodLabels.length !== 4 || !scene.methodLabels.every((x) => typeof x === 'string' && x.trim()))) throw new Error(`${scene.id}: methodLabels needs four names.`);
    if (scene.visibleMethods !== undefined && (!Array.isArray(scene.visibleMethods) || !scene.visibleMethods.length || !scene.visibleMethods.every((i) => Number.isInteger(i) && i >= 0 && i < 4) || new Set(scene.visibleMethods).size !== scene.visibleMethods.length)) throw new Error(`${scene.id}: visibleMethods needs distinct indices from 0 through 3.`);
    if (scene.fitReference !== undefined && scene.fitReference !== null && (!Number.isInteger(scene.fitReference) || scene.fitReference < 0 || scene.fitReference > 3)) throw new Error(`${scene.id}: fitReference needs a method index from 0 through 3.`);
    if (scene.camera !== undefined) {
      const direction = scene.camera?.direction, up = scene.camera?.up;
      for (const vector of [direction, up]) {
        if (!Array.isArray(vector) || vector.length !== 3 || !vector.every(Number.isFinite) || Math.hypot(...vector) < 1e-8) throw new Error(`${scene.id}: camera direction and up must be nonzero 3-vectors.`);
      }
      if (Math.abs(new THREE.Vector3(...direction).normalize().dot(new THREE.Vector3(...up).normalize())) > 0.99999) throw new Error(`${scene.id}: camera direction and up cannot be parallel.`);
    }
    for (const model of scene.models) if (model !== null && (!model || typeof model.src !== 'string')) throw new Error(`${scene.id}: each model needs src, or null.`);
    if (scene.videos !== undefined && (!Array.isArray(scene.videos) || !scene.videos.every((video) => video && typeof video.src === 'string'))) throw new Error(`${scene.id}: videos needs a list of source entries.`);
  }
  return value;
}

async function configureProject(value, baseURL, config) {
  validateProject(value);
  project = value;
  assetBase = assetBaseURL(config, baseURL);
  document.title = TITLE;
  setMethodLabels();
  await selectDataset(value.scenes[0].dataset || 'AriaDTC');
}
function renderDatasetTabs() {
  const container = $('#dataset-tabs');
  const names = [...new Set((project?.scenes || []).map((s) => s.dataset || 'AriaDTC'))];
  container.replaceChildren();
  names.forEach((name) => {
    const button = element('button', 'dataset-tab', name);
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(name === currentDataset));
    button.dataset.dataset = name;
    button.addEventListener('click', () => { void selectDataset(name).catch(showLoadError); });
    container.append(button);
  });
}
async function selectDataset(name) {
  currentDataset = name;
  renderDatasetTabs();
  const scenes = project.scenes.filter((s) => (s.dataset || 'AriaDTC') === name);
  const select = $('#scene-select');
  select.replaceChildren();
  if (!scenes.length) {
    clearScene(); currentScene = null;
    select.append(new Option('No scenes available', ''));
    select.disabled = true;
    grid.hidden = true;
    return;
  }
  select.disabled = false;
  scenes.forEach((scene) => select.append(new Option(scene.title || scene.id, scene.id)));
  selectScene(scenes[0]);
}
function selectScene(scene) {
  if (typeof scene === 'string') scene = project.scenes.find((item) => item.id === scene);
  if (!scene) return;
  clearScene();
  currentScene = scene;
  grid.hidden = false;
  setMethodLabels(scene.methodLabels || project.methods || DEFAULT_METHODS);
  visibleMethods(scene.visibleMethods || [0, 1, 2, 3]);
  renderer?.setCameraPose(scene.camera || { direction: [1, 0.65, 1.35], up: [0, 1, 0] });
  $('#scene-select').value = scene.id;
  const hasReference = scene.fitReference !== undefined && scene.fitReference !== null;
  $('#fit').querySelector('span').textContent = hasReference ? 'Fit object' : 'Fit all';
  $('#fit').title = hasReference ? `Frame ${cards[scene.fitReference].name.textContent}; keep every method at the same scale` : 'Frame the combined bounds of all meshes';
  if (!modelsEnabled) {
    $('#scene-size').textContent = 'Interactive models coming soon.';
    cards.forEach((card, index) => slotMessage(index, 'Coming soon'));
    $('#video-gallery').append(element('p', 'video-empty', 'Optimization videos coming soon.'));
    status();
    return;
  }
  const bytes = [...scene.models, ...(scene.videos || [])].reduce((sum, entry) => sum + (entry?.bytes || 0), 0);
  $('#scene-size').textContent = bytes ? `About ${Math.ceil(bytes / 1024 ** 2)} MiB for this scene, including video. Loads when you choose.` : 'Loads when you choose.';
  cards.forEach((card, index) => slotMessage(index, scene.models[index] ? 'Select Load scene to explore' : 'Result unavailable'));
  $('#video-gallery').append(element('p', 'video-empty', 'Load this scene to watch its optimization video.'));
  status();
}
async function loadScene() {
  const scene = currentScene;
  if (!modelsEnabled || !scene) return;
  clearScene();
  const token = sceneToken;
  $('#load-scene').disabled = true;
  $('#load-scene').textContent = 'Loading…';
  cards.forEach((card, index) => slotMessage(index, scene.models[index] ? 'Waiting to load…' : 'Result unavailable'));
  status('Loading scene…');
  for (const video of scene.videos || []) addVideo(video);
  if (!(scene.videos || []).length) $('#video-gallery').append(element('p', 'video-empty', 'No optimization video is available for this scene.'));
  let failed = 0;
  // Sequential loads bound peak memory and allow scene changes to cancel work.
  for (let index = 0; index < 4; index++) {
    if (token !== sceneToken) return;
    const entry = scene.models[index];
    if (!entry) { slotMessage(index, 'Result unavailable'); continue; }
    try {
      const success = await loadSlot(index, resolveAsset(entry.src), entry);
      if (token !== sceneToken) return;
      if (success) {
        fitScene();
        $('#set-up-direction').disabled = false;
      }
      else failed++;
    } catch (error) {
      failed++;
      console.error('Reconstruction loading failed:', error);
      slotMessage(index, 'This reconstruction could not be displayed.', true);
    }
  }
  if (token === sceneToken) {
    status(failed ? 'Some reconstructions could not load. Try again in a moment.' : '', failed > 0);
    $('#load-scene').disabled = false;
    $('#load-scene').textContent = failed ? 'Retry scene' : 'Reload scene';
  }
}
function clearVideos() {
  $('#video-gallery').querySelectorAll('video').forEach((video) => { video.pause(); video.removeAttribute('src'); video.load(); });
  $('#video-gallery').replaceChildren();
}
function addVideo(entry) {
  const card = element('article', 'video-card');
  const video = element('video');
  video.controls = true; video.preload = 'none'; video.playsInline = true;
  video.src = resolveAsset(entry.src);
  const copy = element('div', 'video-copy');
  copy.append(element('h3', '', entry.title || 'Optimization'));
  const error = element('p', 'video-error');
  video.addEventListener('error', () => { if (video.hasAttribute('src')) error.textContent = 'This video is unavailable. Please try again later.'; });
  card.append(video, copy, error);
  $('#video-gallery').append(card);
}
function showLoadError(error) {
  console.error('Presentation loading failed:', error);
  status('The results could not load. Please refresh the page or try again later.', true);
  $('#load-scene').disabled = !modelsEnabled || !currentScene;
  $('#load-scene').textContent = !modelsEnabled ? 'Coming soon' : currentScene ? 'Retry scene' : 'Load scene';
}

$('#scene-select').addEventListener('change', (event) => { try { selectScene(event.target.value); } catch (error) { showLoadError(error); } });
$('#load-scene').addEventListener('click', () => { void loadScene().catch(showLoadError); });
document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => {
  currentMode = button.dataset.mode;
  renderer?.setMode(currentMode);
  document.querySelectorAll('[data-mode]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
  updateModeDescription();
}));
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
  renderer?.setView(button.dataset.view);
  document.querySelectorAll('[data-view]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
}));
$('#quality').addEventListener('change', (event) => renderer?.setQuality(event.target.value));
$('#fit').addEventListener('click', fitScene);
$('#set-up-direction').addEventListener('click', () => {
  renderer?.useCurrentViewAsUp();
  document.querySelectorAll('[data-view]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.view === 'perspective')));
});
// Dropping a file should not replace or navigate away from the presentation.
for (const eventName of ['dragover', 'drop']) document.addEventListener(eventName, (event) => {
  if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault();
});

async function start() {
  if (location.protocol === 'file:') {
    status('This viewer needs a web server. Use the published website or run the local preview.');
    return;
  }
  try {
    const [response, configResponse] = await Promise.all([
      fetch(new URL('scenes.json', location.href)),
      fetch(new URL('site-config.json', location.href)),
    ]);
    if (!response.ok) throw new Error(`Scene list returned HTTP ${response.status}.`);
    if (!configResponse.ok) throw new Error(`Site configuration returned HTTP ${configResponse.status}.`);
    const config = await configResponse.json();
    modelsEnabled = config?.modelsEnabled !== false;
    document.body.classList.toggle('placeholder-mode', !modelsEnabled);
    document.querySelectorAll('[data-mode], [data-view], #quality, #fit').forEach(control => { control.disabled = !modelsEnabled; });
    cards.forEach(card => { card.viewport.tabIndex = modelsEnabled ? 0 : -1; });
    if (modelsEnabled) {
      try {
        renderer = new ComparisonRenderer({ canvas: $('#render-canvas'), panes: cards.map((card) => card.viewport),
          onStats(index, stats) { cards[index].triangles.textContent = stats.triangles ? `${stats.triangles.toLocaleString()} triangles` : '— triangles'; },
          onError: (message) => status(message, true),
        });
      } catch (error) {
        console.error(error);
        status('The 3D viewer needs a browser with WebGL2 and hardware acceleration enabled.', true);
        return;
      }
    }
    // Read-only diagnostics; the presentation exposes no model or project editor.
    window.meshViewer = Object.freeze({ getDiagnostics: () => renderer?.getDiagnostics() ?? { modelsEnabled: false } });
    await configureProject(await response.json(), response.url, config);
  } catch (error) { showLoadError(error); }
}
void start();
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) { controllers.forEach((controller) => controller?.abort()); clearVideos(); renderer?.dispose(); }
});
