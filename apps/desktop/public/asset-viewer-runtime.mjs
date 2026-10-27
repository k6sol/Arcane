import * as THREE from '/vendor/three/build/three.module.js';
import { GLTFLoader } from '/vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from '/vendor/three/examples/jsm/controls/OrbitControls.js';

const owners = new WeakMap();
const MAX_TRIANGLES = 2_000_000;
const MAX_MATERIALS = 64;
const MAX_DRAWS = 256;
const MAX_COORDINATE = 1e12;
const MAX_PIXELS = 4_000_000;
const VIEWS = ['perspective', 'front', 'side', 'top'];
// 'normals' and 'uv' are inspection modes. 'uv' is offered only when a mesh carries a UV0 map.
const MODES = ['rendered', 'wireframe', 'clay', 'normals', 'uv'];
const TURNTABLE_SPEED = 1.6; // OrbitControls autoRotateSpeed: one turn in about 37 s.
const LIGHTING = {
  studio: { hemisphere: 2.2, lights: [3.8, 2.4, 1.3], environment: 1, exposure: 1 },
  soft: { hemisphere: 3, lights: [1.8, 1.4, 1.1], environment: 1.2, exposure: 1 },
  dramatic: { hemisphere: .35, lights: [5, 2, .15], environment: .35, exposure: .9 },
};
const boolean = value => { if (typeof value !== 'boolean') throw new TypeError('Expected a boolean.'); };
const number = (value, min, max) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new RangeError('Value is outside the supported range.');
};
const choice = (value, values) => { if (!values.includes(value)) throw new TypeError('Unsupported viewer option.'); };
const vector = value => ({ x: value.x, y: value.y, z: value.z });
// Only errors created here may contribute text to onStatus. Loader, decoder and
// WebGL errors can contain local paths, URLs or source-controlled names.
class PreviewError extends Error {}
const previewError = message => new PreviewError(message);
const safeReason = error => error instanceof PreviewError ? error.message : 'The asset could not be displayed safely.';
const abortError = () => new DOMException('Asset preview cancelled.', 'AbortError');
const finite = values => {
  for (const value of values) if (!Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE) return false;
  return true;
};

// Track partial parses as well as the displayed scene. Loader caches can retain
// source textures, material variants, and resources from other glTF scenes.
function resourceOwner() {
  const resources = new Set(), bitmaps = new Set(), released = new WeakSet();
  let disposed = false;
  function close(image) {
    if (Array.isArray(image)) { image.forEach(close); return; }
    if (!image || typeof image.close !== 'function' || released.has(image)) return;
    bitmaps.add(image);
    if (disposed) { released.add(image); image.close(); bitmaps.delete(image); }
  }
  function capture(value) {
    if (!value) return value;
    if (Array.isArray(value)) { value.forEach(capture); return value; }
    if (value.isObject3D) {
      value.traverse(object => { capture(object.geometry); capture(object.material); capture(object.skeleton); });
      return value;
    }
    if (value.isMaterial) {
      for (const property of Object.values(value)) if (property?.isTexture) capture(property);
      for (const uniform of Object.values(value.uniforms ?? {})) capture(uniform.value?.isTexture ? uniform.value : null);
    }
    if (value.isTexture) close(value.source?.data ?? value.image);
    if (value.isBufferGeometry || value.isMaterial || value.isTexture || value.isRenderTarget || value instanceof THREE.Skeleton) {
      resources.add(value);
      if (disposed) {
        if (!released.has(value)) { released.add(value); value.dispose(); }
        resources.delete(value);
      }
    }
    return value;
  }
  return {
    capture,
    dispose() {
      disposed = true;
      for (const resource of resources) {
        if (!released.has(resource)) { released.add(resource); resource.dispose(); }
      }
      resources.clear();
      for (const bitmap of bitmaps) close(bitmap);
      bitmaps.clear();
    },
  };
}

function studioEnvironment(renderer, owned) {
  // A small analytic lighting map supplies broad reflections for metallic PBR.
  // It contains no model geometry, external image, or network dependency.
  const width = 128, height = 64, data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const key = Math.exp(-(((x - 26) / 11) ** 2 + ((y - 23) / 18) ** 2));
    const rim = Math.exp(-(((x - 94) / 8) ** 2 + ((y - 28) / 20) ** 2));
    const i = (y * width + x) * 4;
    data[i] = 18 + key * 205 + rim * 110;
    data[i + 1] = 22 + key * 210 + rim * 140;
    data[i + 2] = 30 + key * 215 + rim * 190;
    data[i + 3] = 255;
  }
  const texture = owned.capture(new THREE.DataTexture(data, width, height));
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.needsUpdate = true;
  const generator = new THREE.PMREMGenerator(renderer);
  try { return owned.capture(generator.fromEquirectangular(texture)).texture; }
  finally { generator.dispose(); }
}

// A two-tone checker (8 x 8 cells, repeated twice per UV unit) that shows stretch, seams and
// texel density. Generated locally; no image, network or model data is involved.
function uvChecker(renderer, owned) {
  const size = 256, cell = size / 8, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4, odd = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 1;
    const edge = x % cell === 0 || y % cell === 0;
    const [r, g, b] = edge ? [40, 18, 22] : odd ? [229, 50, 63] : [244, 239, 239];
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  const texture = owned.capture(new THREE.DataTexture(data, size, size));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 2);
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  texture.needsUpdate = true;
  return texture;
}

// Inspection materials replace the source material, so an alpha-tested (cutout) source would
// otherwise render as solid cards. Keep its cutout by discarding below the source alpha cutoff.
function keepCutout(made, source) {
  const map = source.map, cutoff = source.alphaTest;
  if (!map?.isTexture || !(cutoff > 0)) return made;
  made.defines = { ...(made.defines ?? {}), USE_UV: '' };
  made.onBeforeCompile = shader => {
    shader.uniforms.arcaneCutoutMap = { value: map };
    shader.uniforms.arcaneCutoff = { value: cutoff };
    shader.fragmentShader = 'uniform sampler2D arcaneCutoutMap;\nuniform float arcaneCutoff;\n' +
      shader.fragmentShader.replace('void main() {', 'void main() {\n\tif ( texture2D( arcaneCutoutMap, vUv ).a < arcaneCutoff ) discard;');
  };
  made.customProgramCacheKey = () => 'arcane-cutout';
  return made;
}

function validateScene(root, scanGeometry = false) {
  root.updateMatrixWorld(true);
  const materials = new Set(), geometries = new Set();
  let triangles = 0, meshes = 0, draws = 0, transmission = false;
  root.traverse(object => {
    if (!finite(object.matrixWorld.elements)) throw previewError('Asset contains unbounded or non-finite world transforms.');
    if (!object.geometry) return;
    const geometry = object.geometry, position = geometry.getAttribute('position');
    if (!position || !Number.isSafeInteger(position.count)) throw previewError('Asset has invalid geometry.');
    const instances = object.isInstancedMesh ? object.count : 1;
    if (!Number.isSafeInteger(instances) || instances < 0) throw previewError('Asset has invalid instance counts.');
    if (object.isMesh) {
      meshes++;
      triangles += Math.floor((geometry.index?.count ?? position.count) / 3) * instances;
    }
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of objectMaterials) {
      if (!material) continue;
      materials.add(material);
      transmission ||= material.transmission > 0;
      const passes = material.transparent && material.side === THREE.DoubleSide && !material.forceSinglePass ? 2 : 1;
      draws += passes * (Array.isArray(object.material) ? geometry.groups.filter(group => group.count > 0 && objectMaterials[group.materialIndex] === material).length : 1);
    }
    if (triangles > MAX_TRIANGLES || draws > MAX_DRAWS || materials.size > MAX_MATERIALS) {
      throw previewError('Asset exceeds preview limits (2M triangles, 64 materials, 256 draw calls).');
    }
    if (scanGeometry && !geometries.has(geometry)) {
      geometries.add(geometry);
      for (const attribute of [...Object.values(geometry.attributes), ...Object.values(geometry.morphAttributes).flat()]) {
        // Read underlying interleaved arrays without allocating another large copy.
        const array = attribute.isInterleavedBufferAttribute ? attribute.data.array : attribute.array;
        for (let i = 0; i < array.length; i++) {
          if (!Number.isFinite(array[i]) || Math.abs(array[i]) > MAX_COORDINATE) throw previewError('Asset contains invalid vertex data.');
        }
      }
      if (geometry.index) {
        for (const index of geometry.index.array) if (index >= position.count) throw previewError('Asset has out-of-range vertex indices.');
      }
      // Do not trust accessor min/max supplied by the file.
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
    }
    if (object.isSkinnedMesh) {
      if (!finite(object.bindMatrix.elements) || !finite(object.bindMatrixInverse.elements) || object.skeleton.boneInverses.some(matrix => !finite(matrix.elements))) {
        throw previewError('Asset contains invalid skin transforms.');
      }
      object.computeBoundingBox();
      object.computeBoundingSphere();
    } else if (object.isMesh && !object.isInstancedMesh && object.morphTargetInfluences?.length) {
      // Morph weights can exceed [0, 1]. Geometry's cached morph envelope alone
      // cannot bound the current pose or provide correct frustum culling.
      const box = object.boundingBox ?? new THREE.Box3(), vertex = new THREE.Vector3();
      box.makeEmpty();
      for (let i = 0; i < position.count; i++) box.expandByPoint(object.getVertexPosition(i, vertex));
      object.boundingBox = box;
      object.boundingSphere = box.getBoundingSphere(object.boundingSphere ?? new THREE.Sphere());
    }
    if (object.isInstancedMesh) {
      if (!finite(object.instanceMatrix.array)) throw previewError('Asset contains invalid instance transforms.');
      object.computeBoundingBox();
      object.computeBoundingSphere();
    }
  });
  // Transmission needs an additional scene pass; reserve its actual GPU cost.
  if (transmission && draws * 2 > MAX_DRAWS) throw previewError('Asset exceeds the 256 draw-call preview limit.');
  const box = new THREE.Box3().setFromObject(root);
  if (!box.isEmpty() && (!finite(box.min.toArray()) || !finite(box.max.toArray()))) throw previewError('Asset has unbounded or non-finite bounds.');
  return { box, triangles, meshes, materials: materials.size };
}

/**
 * Call only after preview intent and GLB prevalidation. onStatus receives readable
 * status strings. Animation starts paused; reduced motion also suspends playback.
 * Abort settles promptly, while late loader dependencies are still disposed.
 * Mutators throw TypeError/RangeError for invalid input while alive, and become
 * no-ops after disposal. Defaults: perspective/rendered/studio, first clip (or
 * index -1), paused, speed 1, loop true. Axis views look from +Z/+X/+Y; top up is
 * -Z. reset fits the current view/pose. orbit uses radians, pan CSS pixels, and
 * zoom uses a factor in [.1, 10] (>1 moves closer). Seek accepts [0, duration].
 * stats dimensions/bounds are the initial source scene's world-space AABB before
 * normalization, including node transforms, in glTF meters (units: 'meters').
 * Getters return detached snapshots; playing records intent during visibility
 * and reduced-motion suspension, and becomes false at a nonlooping clip's end.
 * modes() lists the display modes this asset supports ('uv' needs a UV0 map);
 * setMode rejects any other. setTurntable records intent; like playback it only
 * moves while visible and without reduced motion. Turntable starts off.
 */
export async function createAssetViewer({ host, bytes, label, signal, onStatus }) {
  if (!(host instanceof HTMLElement) || !(bytes instanceof ArrayBuffer) || !(signal instanceof AbortSignal)) throw new TypeError('Asset viewer requires a host, ArrayBuffer and AbortSignal.');
  if ((label !== undefined && typeof label !== 'string') || (onStatus !== undefined && typeof onStatus !== 'function')) throw new TypeError('Asset viewer label and status callback are invalid.');
  if (signal.aborted) throw abortError();
  owners.get(host)?.dispose();
  const owned = resourceOwner(), urls = new Set(), listeners = [];
  const manager = new THREE.LoadingManager();
  const document = host.ownerDocument, window = document.defaultView;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let disposed = false, epoch = 0, raf = null, lastTime = null, playing = false, dirty = true;
  let renderer, controls, controlsCleanup, mixer, action, gltf, resizeObserver, intersectionObserver, mutationObserver, canvas;
  let view = 'perspective', mode = 'rendered', selectedIndex = -1, speed = 1, loop = true, stoppedTime = 0;
  let clips = [], materialSlots = [], derivedMaterials = new Map(), hemisphere, lights = [], availableModes = MODES.slice(0, 4), checker = null, turntable = false;
  let rejectPending, loadFailure, resolutionMedia, intersectionKnown = false, intersecting = false, lastVisible = false, width = 0, height = 0, fitNeeded = true, maxDimension = 8192;
  // True once the user (or the orbit/pan/zoom API) moves the camera away from the
  // automatic framing; a resize then keeps that camera instead of refitting.
  let cameraEdited = false;
  let scene, camera, model, normalizedBox, metrics = { triangles: 0, meshes: 0, materials: 0, animations: 0, renderFrames: 0 };
  const status = message => { try { onStatus?.(message); } catch { /* Consumer status must not break ownership. */ } };
  const listen = (target, type, listener, options) => {
    target.addEventListener(type, listener, options);
    listeners.push(() => target.removeEventListener(type, listener, options));
  };
  const checkActive = () => { if (disposed || signal.aborted) throw abortError(); };
  function stopFrame() {
    epoch++;
    if (raf !== null) window.cancelAnimationFrame(raf);
    raf = null;
    lastTime = null;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    stoppedTime = action?.time ?? 0;
    stopFrame();
    rejectPending?.(abortError());
    resizeObserver?.disconnect();
    intersectionObserver?.disconnect();
    mutationObserver?.disconnect();
    listeners.splice(0).forEach(remove => remove());
    controlsCleanup?.();
    if (mixer && gltf) { mixer.stopAllAction(); mixer.uncacheRoot(gltf.scene); }
    manager.abort();
    owned.dispose();
    for (const url of urls) { THREE.Cache.remove(`image-bitmap:${url}`); URL.revokeObjectURL(url); }
    urls.clear();
    renderer?.dispose();
    renderer?.forceContextLoss();
    canvas?.remove();
    scene?.clear();
    action = controlsCleanup = hemisphere = checker = null;
    lights = []; materialSlots = []; derivedMaterials.clear(); turntable = false;
    gltf = renderer = controls = mixer = scene = camera = model = normalizedBox = null;
    if (owners.get(host)?.dispose === dispose) owners.delete(host);
  }
  owners.set(host, { dispose });
  listen(signal, 'abort', dispose, { once: true });
  const cancelled = new Promise((_, reject) => { rejectPending = reject; });
  manager.setURLModifier(url => {
    if (disposed || !urls.has(url)) {
      loadFailure = previewError('Asset preview only allows owned embedded texture blobs.');
      throw loadFailure;
    }
    return url;
  });
  manager.onError = () => { loadFailure = previewError('An embedded asset texture could not be decoded.'); };
  const loader = new GLTFLoader(manager);
  loader.register(parser => {
    // Use per-parser hooks, never global URL or fetch monkeypatches.
    for (const method of ['getDependency', 'loadGeometries', 'loadImageSource']) {
      const original = parser[method].bind(parser);
      const watched = new WeakSet();
      parser[method] = (...args) => {
        let result;
        try { result = original(...args); }
        finally {
          if (method === 'loadGeometries') {
            // Keep successful siblings owned on either a sync parse error or a
            // later Promise.all rejection from another primitive.
            for (const entry of Object.values(parser.primitiveCache)) {
              if (!watched.has(entry.promise)) {
                watched.add(entry.promise);
                entry.promise.then(owned.capture, () => {});
              }
            }
          }
        }
        return Promise.resolve(result).then(owned.capture);
      };
    }
    const assign = parser.assignFinalMaterial.bind(parser);
    parser.assignFinalMaterial = object => { assign(object); owned.capture(object); };
    const assignTexture = parser.assignTexture.bind(parser);
    parser.assignTexture = (...args) => assignTexture(...args).then(value => { for (const texture of Object.values(args[0])) if (texture?.isTexture) owned.capture(texture); return value; });
    return {
      name: 'ARCANE_owned_embedded_resources',
      async beforeRoot() {
        checkActive();
        if ((parser.json.buffers ?? []).some(buffer => buffer.uri !== undefined) || (parser.json.images ?? []).some(image => image.uri !== undefined)) {
          throw previewError('Asset preview requires embedded buffers and textures; external URLs are disabled.');
        }
        if ((parser.json.materials?.length ?? 0) > MAX_MATERIALS) throw previewError('Asset exceeds the 64 material preview limit.');
        for (const image of parser.json.images ?? []) {
          if (image.bufferView === undefined || !/^image\/(png|jpeg|webp|avif)$/.test(image.mimeType ?? '')) throw previewError('Asset has an unsupported embedded texture.');
          const data = await parser.getDependency('bufferView', image.bufferView);
          checkActive();
          const url = URL.createObjectURL(new Blob([data], { type: image.mimeType }));
          urls.add(url);
          image.uri = url;
          delete image.bufferView;
        }
      },
      afterRoot(result) {
        result.scenes.forEach(owned.capture);
        checkActive();
        if (loadFailure) throw loadFailure;
      },
    };
  });

  function hostVisible() {
    if (disposed || document.visibilityState !== 'visible' || !intersecting || !host.isConnected || width <= 0 || height <= 0) return false;
    for (let node = host; node instanceof HTMLElement; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (node.hidden || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0 || style.contentVisibility === 'hidden') return false;
    }
    return true;
  }
  const playingClip = () => playing && !!action && clips[selectedIndex].duration > 0 && !motion.matches;
  // The turntable is continuous motion: it records intent but stays still under reduced motion.
  const spinning = () => turntable && !motion.matches && !!controls;
  const animate = () => playingClip() || spinning();
  function requestRender() {
    dirty = true;
    schedule();
  }
  function schedule() {
    const visible = !!renderer && hostVisible();
    if (visible && !lastVisible) dirty = true;
    lastVisible = visible;
    if (!visible) { stopFrame(); return; }
    if (raf !== null || (!dirty && !animate())) return;
    const frameEpoch = epoch;
    raf = window.requestAnimationFrame(time => {
      raf = null;
      if (frameEpoch !== epoch || !hostVisible()) { lastTime = null; return; }
      try {
        if (animate()) {
          const delta = lastTime === null ? 0 : Math.min((time - lastTime) / 1000, .1);
          lastTime = time;
          if (playingClip()) {
            mixer.update(delta);
            validateScene(gltf.scene);
            if (!loop && action.paused) playing = false;
          }
          if (spinning()) { controls.autoRotate = true; controls.update(delta); }
        } else lastTime = null;
        draw();
        schedule();
      } catch (error) { status(`3D preview stopped: ${safeReason(error)}`); dispose(); }
    });
  }
  function draw() {
    if (fitNeeded) { fitCamera(); fitNeeded = false; }
    updateClip();
    renderer.render(scene, camera);
    metrics.renderFrames++;
    if (renderer.info.render.calls > MAX_DRAWS) throw previewError('Asset exceeds the 256 draw-call preview limit.');
    dirty = false;
    // A synchronous measurement or fitting controls may have consumed a queued
    // paused redraw. Do not leave that redundant frame scheduled after drawing.
    if (!animate()) stopFrame();
  }
  function updateProjection() {
    const aspect = width / height;
    if (camera.isPerspectiveCamera) camera.aspect = aspect;
    else { const half = (camera.top - camera.bottom) / 2; camera.left = -half * aspect; camera.right = half * aspect; }
    camera.updateProjectionMatrix();
  }
  function updateClip() {
    const box = new THREE.Box3().setFromObject(model);
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    const distance = camera.position.distanceTo(box.getCenter(new THREE.Vector3()));
    camera.near = Math.max(.0001, distance - radius * 1.25);
    camera.far = Math.max(camera.near + .1, distance + radius * 2.5);
    camera.updateProjectionMatrix();
  }
  function fitCamera() {
    normalizedBox.setFromObject(model);
    const center = normalizedBox.getCenter(new THREE.Vector3());
    const half = normalizedBox.getSize(new THREE.Vector3()).multiplyScalar(.5);
    const direction = view === 'front' ? new THREE.Vector3(0, 0, 1) : view === 'side' ? new THREE.Vector3(1, 0, 0) : view === 'top' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, .65, 1.2).normalize();
    const right = new THREE.Vector3().crossVectors(camera.up, direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right);
    const aspect = width > 0 && height > 0 ? width / height : 1;
    const tanY = Math.tan(THREE.MathUtils.degToRad(38 / 2)), tanX = tanY * aspect;
    let distance = 0;
    let projectedX = 0, projectedY = 0;
    // Project all eight half-box corners in camera space, including their depth.
    for (const x of [-half.x, half.x]) for (const y of [-half.y, half.y]) for (const z of [-half.z, half.z]) {
      const corner = new THREE.Vector3(x, y, z);
      distance = Math.max(distance, Math.abs(corner.dot(right)) / tanX + corner.dot(direction), Math.abs(corner.dot(up)) / tanY + corner.dot(direction));
      projectedX = Math.max(projectedX, Math.abs(corner.dot(right)));
      projectedY = Math.max(projectedY, Math.abs(corner.dot(up)));
    }
    distance *= 1.18;
    if (camera.isOrthographicCamera) {
      const span = Math.max(projectedY, projectedX / aspect, .001) * 1.18;
      camera.left = -span * aspect; camera.right = span * aspect;
      camera.top = span; camera.bottom = -span;
      camera.zoom = 1;
    } else camera.aspect = aspect;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.cursor.copy(center);
    controls.minDistance = Math.max(.02, half.length() * .15);
    controls.maxDistance = Math.max(distance * 8, 10);
    controls.maxTargetRadius = Math.max(half.length() * 5, 2);
    controls.minZoom = .125;
    controls.maxZoom = 50;
    camera.position.copy(center).addScaledVector(direction, distance);
    controls.update();
    controls.saveState();
    cameraEdited = false; // controls.update() above reported this fit as a change.
  }
  function measure() {
    if (disposed) return;
    const bounds = host.getBoundingClientRect();
    const nextWidth = host.clientWidth, nextHeight = host.clientHeight;
    // Once IntersectionObserver has reported, retain its ancestor clipping result.
    // A viewport-only rectangle must not wake a host clipped by overflow parents.
    if (!intersectionKnown) intersecting = bounds.bottom > 0 && bounds.right > 0 && bounds.top < window.innerHeight && bounds.left < window.innerWidth;
    if (nextWidth !== width || nextHeight !== height) {
      // Refit only while the camera is still the automatic framing. A camera the
      // user orbited, panned or zoomed is kept; only its projection follows the size.
      if (width && height && nextWidth && nextHeight && !cameraEdited) fitNeeded = true;
      width = nextWidth; height = nextHeight; dirty = true;
    }
    const visible = !!renderer && hostVisible();
    let resized = false;
    if (renderer && width > 0 && height > 0) {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(MAX_PIXELS / (width * height)), maxDimension / width, maxDimension / height);
      const pixelWidth = Math.max(1, Math.floor(width * dpr)), pixelHeight = Math.max(1, Math.floor(height * dpr));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        dirty = true;
        // Hidden hosts retain their last image. Apply the pending backing size
        // only when visible, then redraw before this layout is presented.
        if (visible) { renderer.setSize(pixelWidth, pixelHeight, false); resized = true; }
      }
      updateProjection();
    }
    // ResizeObserver runs after layout and before paint. Redraw an established
    // visible viewer synchronously after a resize, dirty update or re-entry;
    // waiting for rAF can present the cleared or stale image for one frame.
    if (visible && metrics.renderFrames > 0 && (resized || dirty || !lastVisible)) {
      try { draw(); lastVisible = true; }
      catch (error) { status(`3D preview stopped: ${safeReason(error)}`); dispose(); return; }
    }
    schedule();
  }
  function reset() { if (!disposed && controls) { fitCamera(); fitNeeded = false; requestRender(); } }
  function controlsChanged() { cameraEdited = true; requestRender(); }
  function configureControls() {
    controlsCleanup?.();
    controls = new OrbitControls(camera, canvas);
    const controlsRoot = canvas.getRootNode(), ownedControls = controls;
    controlsCleanup = () => {
      ownedControls.removeEventListener('change', controlsChanged);
      ownedControls.dispose();
      // Vendor disconnect resolves getRootNode again; also remove from the
      // original root when a host was detached or reparented.
      controlsRoot.removeEventListener('keydown', ownedControls._interceptControlDown, { capture: true });
      controlsRoot.removeEventListener('keyup', ownedControls._interceptControlUp, { capture: true });
    };
    controls.enableDamping = false;
    controls.enablePan = true;
    controls.autoRotate = false; // The turntable turns it on per frame while it may move.
    controls.autoRotateSpeed = TURNTABLE_SPEED;
    controls.cursorStyle = 'grab';
    controls.addEventListener('change', controlsChanged);
  }
  function setView(value) {
    if (disposed) return;
    choice(value, VIEWS);
    view = value;
    camera = view === 'perspective' ? new THREE.PerspectiveCamera(38, 1, .01, 100) : new THREE.OrthographicCamera(-1, 1, 1, -1, .01, 100);
    if (view === 'top') camera.up.set(0, 0, -1);
    configureControls();
    reset();
  }
  // One cached replacement per (inspection mode, source material); owned and disposed with the viewer.
  function inspectionMaterial(value, material, hasUv) {
    const kind = value === 'uv' && !hasUv ? 'clay' : value;
    let cache = derivedMaterials.get(kind);
    if (!cache) derivedMaterials.set(kind, cache = new Map());
    if (!cache.has(material)) {
      const shared = { side: material.side, flatShading: !!material.flatShading };
      const made = kind === 'normals' ? new THREE.MeshNormalMaterial(shared)
        : kind === 'uv' ? new THREE.MeshStandardMaterial({ ...shared, color: 0xffffff, map: checker ??= uvChecker(renderer, owned), roughness: .8, metalness: 0 })
        : new THREE.MeshStandardMaterial({ ...shared, color: 0x9e9698, roughness: .85, metalness: 0 });
      cache.set(material, owned.capture(keepCutout(made, material)));
    }
    return cache.get(material);
  }
  function setMode(value) {
    if (disposed) return;
    choice(value, availableModes);
    if (mode === value) return;
    for (const slot of materialSlots) {
      const hasUv = !!slot.object.geometry?.getAttribute?.('uv');
      const convert = material => {
        if (!material) return material;
        if (value === 'clay' || value === 'normals' || value === 'uv') return inspectionMaterial(value, material, hasUv);
        if ('wireframe' in material) {
          const enabled = value === 'wireframe' || slot.wireframes.get(material);
          if (material.wireframe !== enabled) { material.wireframe = enabled; material.needsUpdate = true; }
        }
        return material;
      };
      slot.object.material = Array.isArray(slot.material) ? slot.material.map(convert) : convert(slot.material);
    }
    mode = value;
    requestRender();
  }
  function setLighting(value) {
    if (disposed) return;
    choice(value, Object.keys(LIGHTING));
    const preset = LIGHTING[value];
    hemisphere.intensity = preset.hemisphere;
    lights.forEach((light, index) => { light.intensity = preset.lights[index]; });
    scene.environmentIntensity = preset.environment;
    renderer.toneMappingExposure = preset.exposure;
    requestRender();
  }
  function setTurntable(enabled) {
    if (disposed) return;
    boolean(enabled);
    turntable = enabled;
    controls.autoRotateSpeed = TURNTABLE_SPEED;
    controls.autoRotate = spinning();
    stopFrame(); requestRender();
  }
  function orbit(horizontal, vertical) {
    if (disposed) return;
    number(horizontal, -Math.PI * 2, Math.PI * 2); number(vertical, -Math.PI * 2, Math.PI * 2);
    controls.rotateLeft(horizontal); controls.rotateUp(vertical);
  }
  function pan(horizontal, vertical) {
    if (disposed) return;
    number(horizontal, -10_000, 10_000); number(vertical, -10_000, 10_000);
    if (width > 0 && height > 0) controls.pan(horizontal, vertical);
  }
  function zoom(factor) {
    if (disposed) return;
    number(factor, .1, 10);
    controls.dollyIn(1 / factor);
  }
  function animationState() {
    return { index: selectedIndex, time: action?.time ?? stoppedTime, duration: clips[selectedIndex]?.duration ?? 0, playing: !disposed && playing, speed, loop };
  }
  function sampleAnimation(time) {
    action.reset().setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1).setEffectiveTimeScale(speed).play();
    action.clampWhenFinished = true;
    action.time = time;
    try { mixer.update(0); validateScene(gltf.scene); }
    catch (error) { status(`3D preview stopped: ${safeReason(error)}`); dispose(); throw error; }
    stopFrame();
    requestRender();
  }
  function selectAnimation(index) {
    if (disposed) return;
    number(index, 0, clips.length - 1);
    if (!Number.isInteger(index)) throw new RangeError('Animation index must be an integer.');
    mixer.stopAllAction();
    selectedIndex = index;
    action = mixer.clipAction(gltf.animations[index]);
    if (clips[index].duration === 0) playing = false;
    sampleAnimation(0);
  }
  function seekAnimation(seconds) {
    if (disposed) return;
    number(seconds, 0, clips[selectedIndex]?.duration ?? 0);
    if (!action) return;
    sampleAnimation(seconds);
  }
  function setAnimationPlaying(enabled) {
    if (disposed) return;
    boolean(enabled);
    playing = enabled && !!action && clips[selectedIndex].duration > 0;
    if (playing && action.time >= clips[selectedIndex].duration) sampleAnimation(0);
    stopFrame(); requestRender();
  }
  function setAnimationSpeed(value) {
    if (disposed) return;
    number(value, .25, 2);
    speed = value;
    action?.setEffectiveTimeScale(speed);
    stopFrame(); requestRender();
  }
  function setAnimationLoop(enabled) {
    if (disposed) return;
    boolean(enabled);
    loop = enabled;
    if (action) sampleAnimation(action.time);
  }
  function keyboard(event) {
    if (disposed || !controls || !hostVisible() || event.altKey || event.ctrlKey || event.metaKey) return;
    switch (event.key) {
      case 'ArrowLeft': event.shiftKey ? pan(-24, 0) : orbit(.12, 0); break;
      case 'ArrowRight': event.shiftKey ? pan(24, 0) : orbit(-.12, 0); break;
      case 'ArrowUp': event.shiftKey ? pan(0, -24) : orbit(0, .12); break;
      case 'ArrowDown': event.shiftKey ? pan(0, 24) : orbit(0, -.12); break;
      case '+': case '=': controls.dollyOut(.85); break;
      case '-': case '_': controls.dollyIn(.85); break;
      case 'Home': case 'r': case 'R': reset(); break;
      default: return;
    }
    event.preventDefault();
  }
  try {
    status('Loading 3D preview…');
    gltf = await Promise.race([loader.parseAsync(bytes, ''), cancelled]);
    checkActive();
    for (const root of gltf.scenes) validateScene(root, true);
    const validated = validateScene(gltf.scene);
    if (!validated.meshes || validated.box.isEmpty()) throw previewError('Asset has no renderable mesh.');
    const size = validated.box.getSize(new THREE.Vector3()), extent = Math.max(size.x, size.y, size.z);
    if (!(extent > 0) || !Number.isFinite(extent)) throw previewError('Asset has degenerate bounds.');
    for (const clip of gltf.animations) {
      if (!finite([clip.duration]) || clip.duration < 0 || clip.tracks.some(track => !finite(track.times) || !finite(track.values))) throw previewError('Asset has invalid animation data.');
    }
    clips = gltf.animations.map((clip, index) => ({ index, name: clip.name, duration: clip.duration }));
    metrics = { ...metrics, triangles: validated.triangles, meshes: validated.meshes, materials: validated.materials, animations: gltf.animations.length,
      dimensions: vector(size), bounds: { min: vector(validated.box.min), max: vector(validated.box.max) }, units: 'meters' };
    gltf.scene.traverse(object => {
      if (!object.material) return;
      const material = object.material, materials = Array.isArray(material) ? material : [material];
      materialSlots.push({ object, material, wireframes: new Map(materials.map(value => [value, !!value?.wireframe])) });
    });
    // Inspection modes need a source UV0 map to be honest; without one the UV checker is not offered.
    if (materialSlots.some(slot => slot.object.geometry?.getAttribute?.('uv'))) availableModes = MODES.slice();
    scene = new THREE.Scene();
    scene.background = new THREE.Color('#141012'); // Warm near-black studio ground.
    model = new THREE.Group();
    model.scale.setScalar(1 / extent);
    model.position.copy(validated.box.getCenter(new THREE.Vector3())).multiplyScalar(-1 / extent);
    model.add(gltf.scene);
    scene.add(model);
    model.updateMatrixWorld(true);
    normalizedBox = new THREE.Box3().setFromObject(model);
    // Actual studio illumination only: no pedestal, grid, or replacement mesh.
    hemisphere = new THREE.HemisphereLight(0xdce6ff, 0x333945, 2.2);
    scene.add(hemisphere);
    for (const [color, intensity, position] of [[0xe8efff, 3.8, [3, 4, 5]], [0x9fbaff, 2.4, [-4, 1, -2]], [0xffffff, 1.3, [1, -2, 3]]]) {
      const light = new THREE.DirectionalLight(color, intensity);
      light.position.set(...position);
      scene.add(light);
      lights.push(light);
    }
    camera = new THREE.PerspectiveCamera(38, 1, .01, 100);
    canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${label || 'Asset'} — interactive 3D preview`);
    canvas.setAttribute('aria-description', 'Drag to orbit. Right-drag or Shift and arrow keys pan. Scroll or press plus and minus to zoom. Arrow keys orbit. Home or R resets the view.');
    canvas.style.cssText = 'display:block;width:100%;height:100%;outline-offset:-3px;';
    const context = canvas.getContext('webgl2', { alpha: false, antialias: true, powerPreference: 'low-power' });
    if (!context) throw previewError('WebGL2 is unavailable for this 3D preview.');
    maxDimension = Math.min(context.getParameter(context.MAX_RENDERBUFFER_SIZE), context.getParameter(context.MAX_TEXTURE_SIZE));
    renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true, alpha: false });
    renderer.setPixelRatio(1); // Explicit capped backing size is managed by measure().
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    scene.environment = studioEnvironment(renderer, owned);
    // OrbitControls binds a key interceptor to getRootNode(). Attach first so
    // construction and disposal both resolve to the same document root.
    host.append(canvas);
    configureControls();
    if (gltf.animations.length) {
      mixer = new THREE.AnimationMixer(gltf.scene);
      // Clips may be alternate takes; show the first rather than blending all takes.
      selectAnimation(0);
    }
    listen(canvas, 'keydown', keyboard);
    listen(canvas, 'webglcontextlost', event => { event.preventDefault(); status('WebGL context lost. Reopen the 3D preview to continue.'); dispose(); });
    resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(host);
    intersectionObserver = new IntersectionObserver(entries => {
      intersectionKnown = true;
      const entry = entries[entries.length - 1];
      intersecting = entry.isIntersecting && entry.intersectionRatio > 0;
      // A hidden resize may have deferred the backing store. Measure before
      // scheduling a newly intersecting host, so its first visible frame fits.
      measure();
    }, { threshold: [0, Number.EPSILON] });
    intersectionObserver.observe(host);
    // Ancestor visibility changes do not always resize or trigger intersection.
    const ancestors = new WeakSet();
    const observeAncestors = () => {
      for (let node = host; node; node = node.parentElement) {
        if (!ancestors.has(node)) {
          mutationObserver.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
          ancestors.add(node);
        }
      }
    };
    mutationObserver = new MutationObserver(records => {
      if (records.some(record => record.type === 'attributes' ? ancestors.has(record.target) : [...record.addedNodes, ...record.removedNodes].some(node => node === host || node.contains?.(host)))) {
        observeAncestors();
        measure();
      }
    });
    observeAncestors();
    // Detect detachment without observing all attributes in the desktop document.
    mutationObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    listen(document, 'visibilitychange', () => { dirty = true; stopFrame(); measure(); });
    // An ancestor's opacity animation or transition (for example the preview
    // panel's entrance) changes visibility without any resize, intersection or
    // attribute change. Re-check when one ends, or the canvas stays undrawn.
    const settled = event => { if (event.target instanceof Node && event.target.contains(host)) measure(); };
    for (const type of ['animationend', 'animationcancel', 'transitionend', 'transitioncancel']) listen(document, type, settled, { capture: true, passive: true });
    listen(motion, 'change', () => { if (controls) controls.autoRotate = spinning(); stopFrame(); requestRender(); });
    listen(window, 'resize', measure);
    listen(window, 'scroll', measure, { passive: true, capture: true });
    const watchResolution = () => {
      resolutionMedia?.removeEventListener('change', resolutionChanged);
      resolutionMedia = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      resolutionMedia.addEventListener('change', resolutionChanged);
    };
    const resolutionChanged = () => { if (!disposed) { watchResolution(); measure(); } };
    listeners.push(() => resolutionMedia?.removeEventListener('change', resolutionChanged));
    watchResolution();
    measure();
    status('3D preview ready.');
    checkActive();
    rejectPending = null;
    return {
      reset, setView, setMode, setLighting, setTurntable, orbit, pan, zoom,
      modes: () => availableModes.slice(),
      turntable: () => !disposed && turntable,
      setWireframe(enabled) { if (!disposed) { boolean(enabled); setMode(enabled ? 'wireframe' : 'rendered'); } },
      setAnimationPlaying, selectAnimation, seekAnimation, setAnimationSpeed, setAnimationLoop,
      animations: () => clips.map(clip => ({ ...clip })),
      animationState,
      dispose,
      hasAnimations: gltf.animations.length > 0,
      stats: () => ({ ...metrics, dimensions: { ...metrics.dimensions }, bounds: { min: { ...metrics.bounds.min }, max: { ...metrics.bounds.max } } }),
    };
  } catch (error) {
    dispose();
    if (error.name !== 'AbortError') status(`3D preview unavailable: ${safeReason(error)}`);
    throw error;
  } finally { rejectPending = null; }
}
