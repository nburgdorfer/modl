import * as THREE from 'three';

// Basis order and signs match src/tools/spherical_harmonics.py, including its
// positive degree-2/3 yz, xz, and odd terms (not the Gaussian Splatting basis).
const BASIS = [
  '0.28209479177387814',
  '-0.4886025119029199 * y',
  '0.4886025119029199 * z',
  '-0.4886025119029199 * x',
  '1.0925484305920792 * x * y',
  '1.0925484305920792 * y * z',
  '0.31539156525252005 * (3.0 * z * z - 1.0)',
  '1.0925484305920792 * x * z',
  '0.5462742152960396 * (x * x - y * y)',
  '0.5900435899266435 * y * (3.0 * x * x - y * y)',
  '2.890611442640554 * x * y * z',
  '0.4570457994644658 * y * (5.0 * z * z - 1.0)',
  '0.3731763325901154 * z * (5.0 * z * z - 3.0)',
  '0.4570457994644658 * x * (5.0 * z * z - 1.0)',
  '1.445305721320277 * z * (x * x - y * y)',
  '0.5900435899266435 * x * (x * x - 3.0 * y * y)',
];

/** CPU reference for tests and inspection. Coefficients are basis-major RGB. */
export function evaluateSH(coefficients, direction, degree = 3) {
  validateDegree(degree);
  if (coefficients.length < 3 * (degree + 1) ** 2) throw new Error('Insufficient SH coefficients.');
  const length = Math.hypot(...direction);
  if (!Number.isFinite(length) || length === 0) throw new Error('SH ray must be finite and nonzero.');
  const [x, y, z] = direction.map((value) => value / length);
  const basis = [
    0.28209479177387814,
    -0.4886025119029199 * y, 0.4886025119029199 * z, -0.4886025119029199 * x,
    1.0925484305920792 * x * y, 1.0925484305920792 * y * z,
    0.31539156525252005 * (3 * z * z - 1), 1.0925484305920792 * x * z,
    0.5462742152960396 * (x * x - y * y),
    0.5900435899266435 * y * (3 * x * x - y * y), 2.890611442640554 * x * y * z,
    0.4570457994644658 * y * (5 * z * z - 1), 0.3731763325901154 * z * (5 * z * z - 3),
    0.4570457994644658 * x * (5 * z * z - 1), 1.445305721320277 * z * (x * x - y * y),
    0.5900435899266435 * x * (x * x - 3 * y * y),
  ];
  const color = [0.5, 0.5, 0.5];
  for (let term = 0; term < (degree + 1) ** 2; term++) {
    for (let channel = 0; channel < 3; channel++) color[channel] += basis[term] * coefficients[term * 3 + channel];
  }
  return color;
}

function validateDegree(degree) {
  if (!Number.isInteger(degree) || degree < 0 || degree > 3) throw new Error('MODL SH degree must be between 0 and 3.');
}

/** Exact interior-pixel SH evaluation after perspective-correct interpolation. */
export function createSHMaterial(coefficients, vertexCount, degree = 3, options = {}) {
  validateDegree(degree);
  if (!(coefficients instanceof Float32Array) || coefficients.length !== vertexCount * 48) {
    throw new Error('MODL SH data must contain 48 float32 coefficients per vertex.');
  }
  // A texture avoids the WebGL vertex-attribute limit. Twelve RGBA texels encode
  // the 16 RGB bases; gl_VertexID preserves indexed mesh vertex correspondence.
  const texels = vertexCount * 12;
  const width = Math.ceil(Math.sqrt(texels));
  const height = Math.ceil(texels / width);
  const data = new Float32Array(width * height * 4);
  data.set(coefficients);
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;

  const vertexEvaluation = options.appearanceEvaluation === 'vertex';
  const screenInterpolation = options.interpolation === 'screen';
  const component = (index) => `${vertexEvaluation ? 'coefficients' : 'vSH'}[${Math.floor(index / 4)}].${'xyzw'[index % 4]}`;
  const terms = BASIS.slice(0, (degree + 1) ** 2).map((basis, index) =>
    `rgb += (${basis}) * vec3(${component(index * 3)}, ${component(index * 3 + 1)}, ${component(index * 3 + 2)});`,
  ).join('\n');
  const material = new THREE.ShaderMaterial({
    name: `${options.sourceMethod || 'MODL'} degree-${degree} spherical harmonics`,
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
    toneMapped: false,
    uniforms: {
      shCoefficients: { value: texture },
      shTextureWidth: { value: width },
      shCameraLocal: { value: new THREE.Vector3() },
    },
    vertexShader: vertexEvaluation ? `
      uniform highp sampler2D shCoefficients;
      uniform int shTextureWidth;
      uniform vec3 shCameraLocal;
      out vec3 vColor;
      ${screenInterpolation ? 'out float vClipW;' : ''}
      vec4 readCoefficients(int offset) {
        return texelFetch(shCoefficients, ivec2(offset % shTextureWidth, offset / shTextureWidth), 0);
      }
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        int base = gl_VertexID * 12;
        vec4 coefficients[12];
        ${Array.from({ length: 12 }, (_, i) => `coefficients[${i}] = readCoefficients(base + ${i});`).join('\n')}
        vec3 direction = normalize(position - shCameraLocal);
        float x = direction.x;
        float y = direction.y;
        float z = direction.z;
        vec3 rgb = vec3(0.5);
        ${terms}
        rgb = max(rgb, vec3(0.0));
        ${screenInterpolation ? 'vColor = rgb * gl_Position.w; vClipW = gl_Position.w;' : 'vColor = rgb;'}
      }
    ` : `
      uniform highp sampler2D shCoefficients;
      uniform int shTextureWidth;
      out vec4 vSH[12];
      out vec3 vLocalPosition;
      vec4 readCoefficients(int offset) {
        return texelFetch(shCoefficients, ivec2(offset % shTextureWidth, offset / shTextureWidth), 0);
      }
      void main() {
        int base = gl_VertexID * 12;
        ${Array.from({ length: 12 }, (_, i) => `vSH[${i}] = readCoefficients(base + ${i});`).join('\n')}
        vLocalPosition = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: vertexEvaluation ? `
      in vec3 vColor;
      ${screenInterpolation ? 'in float vClipW;' : ''}
      out vec4 shColor;
      void main() {
        shColor = vec4(${screenInterpolation ? 'vColor / vClipW' : 'vColor'}, 1.0);
      }
    ` : `
      uniform vec3 shCameraLocal;
      in vec4 vSH[12];
      in vec3 vLocalPosition;
      out vec4 shColor;
      void main() {
        vec3 direction = normalize(vLocalPosition - shCameraLocal);
        float x = direction.x;
        float y = direction.y;
        float z = direction.z;
        vec3 rgb = vec3(0.5);
        ${terms}
        // Training fits display RGB directly. No extra lighting, tone mapping,
        // or linear-to-sRGB conversion belongs between this sum and the canvas.
        shColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
      }
    `,
  });
  material.userData.appearanceKind = 'spherical harmonics';
  material.userData.shDegree = degree;
  const inverse = new THREE.Matrix4();
  material.onBeforeRender = (renderer, scene, camera, geometry, object) => {
    if (width > renderer.capabilities.maxTextureSize || height > renderer.capabilities.maxTextureSize) {
      throw new Error(`This SH mesh needs a ${width}×${height} coefficient texture; this GPU supports ${renderer.capabilities.maxTextureSize}×${renderer.capabilities.maxTextureSize}.`);
    }
    camera.getWorldPosition(material.uniforms.shCameraLocal.value);
    material.uniforms.shCameraLocal.value.applyMatrix4(inverse.copy(object.matrixWorld).invert());
    material.uniformsNeedUpdate = true;
  };
  return material;
}
