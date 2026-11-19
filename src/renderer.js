import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const BACKGROUND = 0xe8eae6;
const VIEWS = {
  perspective: new THREE.Vector3(1, 0.65, 1.35).normalize(),
  front: new THREE.Vector3(0, 0, 1),
  side: new THREE.Vector3(1, 0, 0),
  top: new THREE.Vector3(0, 1, 0.00001).normalize(),
};

function materialTextures(material, target) {
  if (!material) return;
  for (const value of Object.values(material)) {
    if (value?.isTexture) target.add(value);
  }
  for (const uniform of Object.values(material.uniforms || {})) {
    const values = Array.isArray(uniform.value) ? uniform.value : [uniform.value];
    for (const value of values) if (value?.isTexture) target.add(value);
  }
}

function copyCamera(source, target) {
  target.position.copy(source.position);
  target.quaternion.copy(source.quaternion);
  target.up.copy(source.up);
  target.zoom = source.zoom;
  target.near = source.near;
  target.far = source.far;
  target.fov = source.fov;
  target.updateProjectionMatrix();
  target.updateMatrixWorld();
}

/** Four full-resolution models, one WebGL context, and one synchronized camera pose. */
export class ComparisonRenderer {
  constructor({ canvas, panes, onStats = () => {}, onError = () => {} }) {
    if (panes.length !== 4) throw new Error('The comparison needs four viewport elements.');
    this.canvas = canvas;
    this.panes = panes;
    this.onStats = onStats;
    this.onError = onError;
    this.mode = 'geometry';
    this.quality = 'balanced';
    this.frame = null;
    this.renderCount = 0;
    this.syncing = false;
    this.disposed = false;
    this.contextLost = false;
    this.bounds = new THREE.Box3();
    this.radius = 1;
    this.fitReference = null;
    this.viewDirections = Object.fromEntries(Object.entries(VIEWS).map(([name, direction]) => [name, direction.clone()]));
    this.cleanups = [];
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.info.autoReset = false;
    this.renderer.setClearColor(0x000000, 0);
    canvas.style.pointerEvents = 'none';
    this.geometryMaterial = new THREE.MeshStandardMaterial({
      color: 0xc7d0cd, roughness: 0.8, metalness: 0, side: THREE.DoubleSide,
    });
    this.wireSurfaceMaterial = this.geometryMaterial.clone();
    this.wireSurfaceMaterial.polygonOffset = true;
    this.wireSurfaceMaterial.polygonOffsetFactor = 1;
    this.wireSurfaceMaterial.polygonOffsetUnits = 1;
    this.wireMaterial = new THREE.MeshBasicMaterial({
      color: 0x263b34, wireframe: true, side: THREE.DoubleSide,
      depthTest: true, depthWrite: false,
    });

    this.slots = panes.map((pane, index) => {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(BACKGROUND);
      scene.add(new THREE.HemisphereLight(0xf1f7ff, 0x73776c, 2));
      const key = new THREE.DirectionalLight(0xffffff, 2.5);
      key.position.set(3, 5, 4);
      scene.add(key);
      const fill = new THREE.DirectionalLight(0xc0d7f0, 1.2);
      fill.position.set(-4, 1, -2);
      scene.add(fill);
      const camera = new THREE.PerspectiveCamera(40, 1, 0.001, 10000);
      camera.position.set(3, 2, 4);
      const controls = this.createControls(index, camera, pane);
      if (!pane.hasAttribute('tabindex')) pane.tabIndex = 0;
      pane.style.touchAction = 'none';
      const onKey = (event) => this.handleKey(event, index);
      pane.addEventListener('keydown', onKey);
      this.cleanups.push(() => pane.removeEventListener('keydown', onKey));
      return {
        scene, camera, controls, model: null, originals: new Map(),
        resources: { geometries: new Set(), materials: new Set(), textures: new Set() },
        stats: { triangles: 0, vertices: 0, meshes: 0, appearance: 'none' },
      };
    });
    this.synchronize(0);
    this.resizeObserver = new ResizeObserver(() => this.invalidate());
    this.resizeObserver.observe(canvas.parentElement || canvas);
    panes.forEach((pane) => this.resizeObserver.observe(pane));
    const invalidate = () => this.invalidate();
    window.addEventListener('resize', invalidate);
    window.addEventListener('scroll', invalidate, { passive: true, capture: true });
    document.addEventListener('visibilitychange', invalidate);
    this.cleanups.push(() => window.removeEventListener('resize', invalidate));
    this.cleanups.push(() => window.removeEventListener('scroll', invalidate, true));
    this.cleanups.push(() => document.removeEventListener('visibilitychange', invalidate));
    const lost = (event) => {
      event.preventDefault();
      this.contextLost = true;
      this.onError('The GPU context was lost. Close other GPU-heavy tabs; this viewer will redraw if the browser restores it.');
    };
    const restored = () => {
      this.contextLost = false;
      this.invalidate();
    };
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('webglcontextrestored', restored);
    this.cleanups.push(() => canvas.removeEventListener('webglcontextlost', lost));
    this.cleanups.push(() => canvas.removeEventListener('webglcontextrestored', restored));
    this.invalidate();
  }

  createControls(index, camera, pane) {
    const controls = new OrbitControls(camera, pane);
    controls.enableDamping = false;
    controls.screenSpacePanning = true;
    controls.zoomSpeed = 0.8;
    controls.rotateSpeed = 0.7;
    controls.addEventListener('change', () => this.synchronize(index));
    return controls;
  }

  setCameraPose(pose = {}) {
    const vector = (value, fallback, name) => {
      if (value === undefined) return fallback.clone();
      if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) throw new Error(`${name} must contain three finite numbers.`);
      const result = new THREE.Vector3(...value);
      if (result.lengthSq() < 1e-16) throw new Error(`${name} cannot be a zero vector.`);
      return result.normalize();
    };
    const direction = vector(pose.direction, VIEWS.perspective, 'Camera direction');
    const up = vector(pose.up, new THREE.Vector3(0, 1, 0), 'Camera up');
    if (Math.abs(up.dot(direction)) > 0.99999) throw new Error('Camera direction and up cannot be parallel.');
    const source = this.slots[0];
    const target = source.controls.target.clone();
    const distance = source.camera.position.distanceTo(target) || 1;
    const minDistance = source.controls.minDistance;
    const maxDistance = source.controls.maxDistance;
    source.camera.up.copy(up);
    source.camera.position.copy(target).addScaledVector(direction, distance);
    source.camera.lookAt(target);
    const front = pose.direction ? direction.clone().projectOnPlane(up).normalize() : VIEWS.front.clone();
    if (Math.abs(front.dot(up)) > 0.99999) front.set(1, 0, 0).projectOnPlane(up).normalize();
    this.viewDirections = {
      perspective: direction,
      front,
      side: new THREE.Vector3().crossVectors(up, front).normalize(),
      top: up.clone().addScaledVector(front, 0.00001).normalize(),
    };
    this.syncing = true;
    try {
      for (let index = 0; index < this.slots.length; index++) {
        const slot = this.slots[index];
        slot.controls.dispose();
        if (slot !== source) copyCamera(source.camera, slot.camera);
        // OrbitControls caches its up-to-Y quaternion at construction.
        slot.controls = this.createControls(index, slot.camera, this.panes[index]);
        slot.controls.target.copy(target);
        slot.controls.minDistance = minDistance;
        slot.controls.maxDistance = maxDistance;
        slot.controls.update();
      }
    } finally { this.syncing = false; }
    this.synchronize(0);
  }

  useCurrentViewAsUp() {
    const source = this.slots[0];
    const position = source.camera.position.clone();
    const quaternion = source.camera.quaternion.clone();
    const direction = position.clone().sub(source.controls.target);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).normalize();
    this.setCameraPose({ direction: direction.toArray(), up: up.toArray() });
    // setCameraPose establishes the new control/preset basis. Restore the exact
    // visible pose to avoid even round-off drift when the frame is reset often.
    source.camera.position.copy(position);
    source.camera.quaternion.copy(quaternion);
    source.camera.updateMatrixWorld();
    this.synchronize(0);
  }

  synchronize(sourceIndex) {
    if (this.syncing || this.disposed || !this.slots) return;
    this.syncing = true;
    try {
      const source = this.slots[sourceIndex];
      for (const slot of this.slots) {
        if (slot === source) continue;
        copyCamera(source.camera, slot.camera);
        slot.controls.target.copy(source.controls.target);
        slot.controls.minDistance = source.controls.minDistance;
        slot.controls.maxDistance = source.controls.maxDistance;
        slot.controls.update();
      }
    } finally {
      this.syncing = false;
    }
    this.invalidate();
  }

  handleKey(event, index) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const slot = this.slots[index];
    const { camera, controls } = slot;
    const offset = camera.position.clone().sub(controls.target);
    const upToY = new THREE.Quaternion().setFromUnitVectors(camera.up.clone().normalize(), new THREE.Vector3(0, 1, 0));
    const spherical = new THREE.Spherical().setFromVector3(offset.clone().applyQuaternion(upToY));
    if (event.shiftKey && event.key.startsWith('Arrow')) {
      const step = offset.length() * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.06;
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
      const movement = new THREE.Vector3();
      if (event.key === 'ArrowLeft') movement.copy(right).multiplyScalar(-step);
      if (event.key === 'ArrowRight') movement.copy(right).multiplyScalar(step);
      if (event.key === 'ArrowUp') movement.copy(up).multiplyScalar(step);
      if (event.key === 'ArrowDown') movement.copy(up).multiplyScalar(-step);
      event.preventDefault();
      camera.position.add(movement);
      controls.target.add(movement);
      controls.update();
      this.synchronize(index);
      return;
    }
    const angle = 0.05;
    switch (event.key) {
      case 'ArrowLeft': spherical.theta -= angle; break;
      case 'ArrowRight': spherical.theta += angle; break;
      case 'ArrowUp': spherical.phi -= angle; break;
      case 'ArrowDown': spherical.phi += angle; break;
      case '+': case '=': spherical.radius *= 0.85; break;
      case '-': case '_': spherical.radius /= 0.85; break;
      case 'Home': event.preventDefault(); this.fit(); return;
      default: return;
    }
    event.preventDefault();
    spherical.makeSafe();
    spherical.radius = THREE.MathUtils.clamp(spherical.radius, controls.minDistance, controls.maxDistance);
    camera.position.copy(controls.target).add(offset.setFromSpherical(spherical).applyQuaternion(upToY.invert()));
    controls.update();
    this.synchronize(index);
  }

  setModel(index, model) {
    const slot = this.slots[index];
    if (!slot) throw new Error(`Invalid viewport index: ${index}`);
    if (!model?.isObject3D) throw new Error('Expected a Three.js Object3D.');
    if (slot.model === model) return;
    const originals = new Map();
    const resources = { geometries: new Set(), materials: new Set(), textures: new Set() };
    const stats = { triangles: 0, vertices: 0, meshes: 0, appearance: 'none' };
    let hasColor = false;
    let hasTexture = false;
    let hasMaterial = false;
    let hasSphericalHarmonics = false;
    model.traverse((mesh) => {
      if (!mesh.isMesh) return;
      const geometry = mesh.geometry;
      if (!geometry?.attributes.position) return;
      const count = geometry.index ? geometry.index.count : geometry.attributes.position.count;
      if (!geometry.attributes.normal) geometry.computeVertexNormals();
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      stats.triangles += Math.floor(Math.min(count, geometry.drawRange.count) / 3);
      stats.vertices += geometry.attributes.position.count;
      stats.meshes += 1;
      hasColor ||= !!geometry.attributes.color;
      hasSphericalHarmonics ||= mesh.userData.appearanceKind === 'spherical harmonics';
      originals.set(mesh, mesh.material);
      resources.geometries.add(geometry);
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      hasMaterial ||= (mesh.userData.hasAppearance ?? model.userData.hasAppearance) !== false;
      for (const material of materials) {
        if (!material) continue;
        resources.materials.add(material);
        materialTextures(material, resources.textures);
        hasTexture ||= !!material.map;
      }
    });
    if (stats.meshes === 0 || stats.triangles === 0) throw new Error('This file contains no triangle mesh.');
    stats.appearance = hasSphericalHarmonics ? 'spherical harmonics' : hasTexture ? 'texture' : hasColor ? 'vertex color' : hasMaterial ? 'material' : 'none';
    this.releaseSlot(index, resources);
    slot.model = model;
    slot.originals = originals;
    slot.resources = resources;
    slot.stats = stats;
    slot.scene.add(model);
    this.applyMode(slot);
    this.onStats(index, { ...stats });
    this.updateBounds();
    this.invalidate();
  }

  releaseSlot(index, incomingResources = null) {
    const slot = this.slots[index];
    if (!slot.model) return;
    slot.scene.remove(slot.model);
    for (const [mesh, original] of slot.originals) mesh.material = original;
    // Resource sharing between slots is allowed (useful for large synthetic tests).
    for (const type of ['geometries', 'materials', 'textures']) {
      for (const resource of slot.resources[type]) {
        const retained = incomingResources?.[type].has(resource) || this.slots.some((other, otherIndex) => otherIndex !== index && other.resources[type].has(resource));
        if (!retained) {
          resource.dispose();
          if (type === 'textures' && typeof ImageBitmap !== 'undefined' && resource.image instanceof ImageBitmap) {
            const imageRetained = [...(incomingResources?.textures || [])].some((texture) => texture.image === resource.image) || this.slots.some((other, otherIndex) => otherIndex !== index && [...other.resources.textures].some((texture) => texture.image === resource.image));
            if (!imageRetained) resource.image.close();
          }
        }
      }
      slot.resources[type].clear();
    }
    slot.originals.clear();
    slot.model = null;
    slot.stats = { triangles: 0, vertices: 0, meshes: 0, appearance: 'none' };
  }

  clear() {
    this.slots.forEach((slot, index) => {
      this.releaseSlot(index);
      this.onStats(index, { ...slot.stats });
    });
    this.updateBounds();
    this.fitReference = null;
    this.invalidate();
  }

  applyMode(slot) {
    for (const [mesh, original] of slot.originals) {
      mesh.material = this.mode === 'appearance' ? original : this.mode === 'wireframe' ? this.wireSurfaceMaterial : this.geometryMaterial;
    }
  }

  setMode(mode) {
    if (!['geometry', 'appearance', 'wireframe'].includes(mode)) throw new Error(`Unknown display mode: ${mode}`);
    this.mode = mode;
    this.slots.forEach((slot) => this.applyMode(slot));
    this.invalidate();
  }

  setQuality(quality) {
    if (!['balanced', 'high'].includes(quality)) throw new Error(`Unknown quality: ${quality}`);
    this.quality = quality;
    this.invalidate();
  }

  updateBounds() {
    this.bounds.makeEmpty();
    for (const slot of this.slots) {
      if (slot.model) {
        slot.model.updateMatrixWorld(true);
        this.bounds.union(new THREE.Box3().setFromObject(slot.model));
      }
    }
    this.radius = this.bounds.isEmpty() ? 1 : Math.max(this.bounds.getSize(new THREE.Vector3()).length() / 2, 1e-8);
  }

  fit(referenceIndex = this.fitReference) {
    if (referenceIndex !== null && (!Number.isInteger(referenceIndex) || !this.slots[referenceIndex])) {
      throw new Error(`Invalid fit reference: ${referenceIndex}`);
    }
    this.fitReference = referenceIndex;
    this.updateBounds();
    if (this.bounds.isEmpty()) return;
    const source = this.slots[0];
    const fittedBounds = referenceIndex !== null && this.slots[referenceIndex].model
      ? new THREE.Box3().setFromObject(this.slots[referenceIndex].model)
      : this.bounds;
    const fitRadius = Math.max(fittedBounds.getSize(new THREE.Vector3()).length() / 2, 1e-8);
    const center = fittedBounds.getCenter(new THREE.Vector3());
    const direction = source.camera.position.clone().sub(source.controls.target).normalize();
    if (direction.lengthSq() === 0) direction.copy(VIEWS.perspective);
    let minAspect = Infinity;
    for (const pane of this.panes) {
      const rect = pane.getBoundingClientRect();
      if (rect.width && rect.height) minAspect = Math.min(minAspect, rect.width / rect.height);
    }
    if (!Number.isFinite(minAspect)) minAspect = 1;
    const verticalFov = THREE.MathUtils.degToRad(source.camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * minAspect);
    const distance = fitRadius / Math.sin(Math.min(verticalFov, horizontalFov) / 2) * 1.08;
    source.controls.target.copy(center);
    source.camera.position.copy(center).addScaledVector(direction, distance);
    source.camera.near = fitRadius / 10000;
    source.camera.far = Math.max(this.radius * 3 + center.distanceTo(this.bounds.getCenter(new THREE.Vector3())), fitRadius * 1000);
    source.camera.zoom = 1;
    source.controls.minDistance = fitRadius / 1000;
    source.controls.maxDistance = fitRadius * 500;
    source.camera.updateProjectionMatrix();
    source.controls.update();
    this.synchronize(0);
  }

  setView(view) {
    if (!this.viewDirections[view]) throw new Error(`Unknown camera view: ${view}`);
    const source = this.slots[0];
    const distance = source.camera.position.distanceTo(source.controls.target) || this.radius * 3;
    source.camera.position.copy(source.controls.target).addScaledVector(this.viewDirections[view], distance);
    source.controls.update();
    this.synchronize(0);
  }

  invalidate() {
    if (this.frame !== null || this.disposed || this.contextLost) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (!document.hidden) {
        try { this.render(); } catch (error) { this.onError(`Unable to render: ${error.message}`); }
      }
    });
  }

  render() {
    if (this.disposed || this.contextLost) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const pixelRatio = this.quality === 'high' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    if (this.renderer.getPixelRatio() !== pixelRatio) this.renderer.setPixelRatio(pixelRatio);
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (this.canvas.width !== Math.floor(width * pixelRatio) || this.canvas.height !== Math.floor(height * pixelRatio)) {
      this.renderer.setSize(width, height, false);
    }
    this.renderer.info.reset();
    this.renderer.setScissorTest(false);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, true, true);
    this.renderer.setScissorTest(true);
    this.slots.forEach((slot, index) => {
      const paneRect = this.panes[index].getBoundingClientRect();
      if (paneRect.width < 1 || paneRect.height < 1 || paneRect.bottom <= 0 || paneRect.top >= window.innerHeight) return;
      const left = paneRect.left - rect.left;
      const bottom = rect.bottom - paneRect.bottom;
      const clipLeft = Math.max(0, left);
      const clipBottom = Math.max(0, bottom);
      const clipRight = Math.min(rect.width, left + paneRect.width);
      const clipTop = Math.min(rect.height, bottom + paneRect.height);
      if (clipRight <= clipLeft || clipTop <= clipBottom) return;
      slot.camera.aspect = paneRect.width / paneRect.height;
      slot.camera.updateProjectionMatrix();
      this.renderer.setViewport(left, bottom, paneRect.width, paneRect.height);
      this.renderer.setScissor(clipLeft, clipBottom, clipRight - clipLeft, clipTop - clipBottom);
      this.renderer.render(slot.scene, slot.camera);
      if (this.mode === 'wireframe' && slot.model) {
        // All opaque surfaces populate depth before any edges are drawn. Reuse
        // the same indexed geometry; no expanded line geometry or mesh copies.
        const background = slot.scene.background;
        slot.scene.background = null;
        for (const mesh of slot.originals.keys()) mesh.material = this.wireMaterial;
        try {
          // autoClear=false and no scene background preserve the surface depth.
          this.renderer.render(slot.scene, slot.camera);
        } finally {
          slot.scene.background = background;
          for (const mesh of slot.originals.keys()) mesh.material = this.wireSurfaceMaterial;
        }
      }
    });
    this.renderer.setScissorTest(false);
    this.renderCount += 1;
  }

  getDiagnostics() {
    return {
      mode: this.mode,
      quality: this.quality,
      fitReference: this.fitReference,
      renderCount: this.renderCount,
      contextLost: this.contextLost,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      slots: this.slots.map((slot) => ({
        ...slot.stats,
        materialKinds: [...new Set([...slot.resources.materials].map((material) => material.type))],
        texturedMaterials: [...slot.resources.materials].filter((material) => !!material.map).length,
        position: slot.camera.position.toArray(),
        quaternion: slot.camera.quaternion.toArray(),
        target: slot.controls.target.toArray(),
        up: slot.camera.up.toArray(),
        zoom: slot.camera.zoom,
        near: slot.camera.near,
        far: slot.camera.far,
      })),
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.cleanups.forEach((cleanup) => cleanup());
    this.resizeObserver.disconnect();
    this.slots.forEach((slot, index) => { slot.controls.dispose(); this.releaseSlot(index); });
    this.geometryMaterial.dispose();
    this.wireSurfaceMaterial.dispose();
    this.wireMaterial.dispose();
    this.renderer.dispose();
  }
}
