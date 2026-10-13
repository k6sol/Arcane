import * as THREE from '/vendor/three/build/three.module.js';
import { GLTFLoader } from '/vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from '/vendor/three/examples/jsm/controls/OrbitControls.js';

const owners = new WeakMap();
const MAX_TRIANGLES = 2_000_000;
const MAX_MATERIALS = 64;
const MAX_DRAWS = 256;
const MAX_COORDINATE = 1e12;
const MAX_PIXELS = 4_000_000;
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

function validateScene(root, scanGeometry = false) {
  root.updateMatrixWorld(true);
  const materials = new Set(), geometries = new Set();
  let triangles = 0, meshes = 0, draws = 0, transmission = false;
  root.traverse(object => {
    if (!finite(object.matrixWorld.elements)) throw new Error('Asset contains unbounded or non-finite world transforms.');
    if (!object.geometry) return;
    const geometry = object.geometry, position = geometry.getAttribute('position');
    if (!position || !Number.isSafeInteger(position.count)) throw new Error('Asset has invalid geometry.');
    const instances = object.isInstancedMesh ? object.count : 1;
    if (!Number.isSafeInteger(instances) || instances < 0) throw new Error('Asset has invalid instance counts.');
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
      throw new Error('Asset exceeds preview limits (2M triangles, 64 materials, 256 draw calls).');
    }
    if (scanGeometry && !geometries.has(geometry)) {
      geometries.add(geometry);
      for (const attribute of [...Object.values(geometry.attributes), ...Object.values(geometry.morphAttributes).flat()]) {
        // Read underlying interleaved arrays without allocating another large copy.
        const array = attribute.isInterleavedBufferAttribute ? attribute.data.array : attribute.array;
        for (let i = 0; i < array.length; i++) {
          if (!Number.isFinite(array[i]) || Math.abs(array[i]) > MAX_COORDINATE) throw new Error('Asset contains invalid vertex data.');
        }
      }
      if (geometry.index) {
        for (const index of geometry.index.array) if (index >= position.count) throw new Error('Asset has out-of-range vertex indices.');
      }
      // Do not trust accessor min/max supplied by the file.
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
    }
    if (object.isSkinnedMesh) {
      if (!finite(object.bindMatrix.elements) || !finite(object.bindMatrixInverse.elements) || object.skeleton.boneInverses.some(matrix => !finite(matrix.elements))) {
        throw new Error('Asset contains invalid skin transforms.');
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
      if (!finite(object.instanceMatrix.array)) throw new Error('Asset contains invalid instance transforms.');
      object.computeBoundingBox();
      object.computeBoundingSphere();
    }
  });
  // Transmission needs an additional scene pass; reserve its actual GPU cost.
  if (transmission && draws * 2 > MAX_DRAWS) throw new Error('Asset exceeds the 256 draw-call preview limit.');
  const box = new THREE.Box3().setFromObject(root);
  if (!box.isEmpty() && (!finite(box.min.toArray()) || !finite(box.max.toArray()))) throw new Error('Asset has unbounded or non-finite bounds.');
  return { box, triangles, meshes, materials: materials.size };
}

/**
 * Call only after preview intent and GLB prevalidation. onStatus receives readable
 * status strings. Animation starts paused; reduced motion also suspends playback.
 * Abort settles promptly, while late loader dependencies are still disposed.
 */
export async function createAssetViewer({ host, bytes, label, signal, onStatus }) {
  if (!(host instanceof HTMLElement) || !(bytes instanceof ArrayBuffer) || !signal?.addEventListener) throw new TypeError('Asset viewer requires a host, ArrayBuffer and AbortSignal.');
  if (signal.aborted) throw abortError();
  owners.get(host)?.dispose();
  const owned = resourceOwner(), urls = new Set(), listeners = [];
  const manager = new THREE.LoadingManager();
  const document = host.ownerDocument, window = document.defaultView;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let disposed = false, epoch = 0, raf = null, lastTime = null, playing = false, dirty = true;
  let renderer, controls, mixer, gltf, resizeObserver, intersectionObserver, mutationObserver, canvas;
  let rejectPending, loadFailure, resolutionMedia, intersectionKnown = false, intersecting = false, lastVisible = false, width = 0, height = 0, fitNeeded = true, maxDimension = 8192;
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
    stopFrame();
    rejectPending?.(abortError());
    resizeObserver?.disconnect();
    intersectionObserver?.disconnect();
    mutationObserver?.disconnect();
    listeners.splice(0).forEach(remove => remove());
    controls?.dispose();
    if (mixer && gltf) { mixer.stopAllAction(); mixer.uncacheRoot(gltf.scene); }
    manager.abort();
    owned.dispose();
    for (const url of urls) { THREE.Cache.remove(`image-bitmap:${url}`); URL.revokeObjectURL(url); }
    urls.clear();
    renderer?.dispose();
    renderer?.forceContextLoss();
    canvas?.remove();
    scene?.clear();
    gltf = renderer = controls = mixer = scene = camera = model = normalizedBox = null;
    if (owners.get(host)?.dispose === dispose) owners.delete(host);
  }
  owners.set(host, { dispose });
  listen(signal, 'abort', dispose, { once: true });
  const cancelled = new Promise((_, reject) => { rejectPending = reject; });
  manager.setURLModifier(url => {
    if (disposed || !urls.has(url)) {
      loadFailure = new Error('Asset preview only allows owned embedded texture blobs.');
      throw loadFailure;
    }
    return url;
  });
  manager.onError = () => { loadFailure = new Error('An embedded asset texture could not be decoded.'); };
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
          throw new Error('Asset preview requires embedded buffers and textures; external URLs are disabled.');
        }
        if ((parser.json.materials?.length ?? 0) > MAX_MATERIALS) throw new Error('Asset exceeds the 64 material preview limit.');
        for (const image of parser.json.images ?? []) {
          if (image.bufferView === undefined || !/^image\/(png|jpeg|webp|avif)$/.test(image.mimeType ?? '')) throw new Error('Asset has an unsupported embedded texture.');
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
  const animate = () => playing && !!mixer && !motion.matches;
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
          mixer.update(lastTime === null ? 0 : Math.min((time - lastTime) / 1000, .1));
          lastTime = time;
          validateScene(gltf.scene);
        } else lastTime = null;
        if (fitNeeded) { fitCamera(); fitNeeded = false; }
        updateClip();
        renderer.render(scene, camera);
        metrics.renderFrames++;
        if (renderer.info.render.calls > MAX_DRAWS) throw new Error('Asset exceeds the 256 draw-call preview limit.');
        dirty = false;
        schedule();
      } catch (error) { status(`3D preview stopped: ${error.message}`); dispose(); }
    });
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
    const center = normalizedBox.getCenter(new THREE.Vector3());
    const half = normalizedBox.getSize(new THREE.Vector3()).multiplyScalar(.5);
    const direction = new THREE.Vector3(1, .65, 1.2).normalize();
    const right = new THREE.Vector3().crossVectors(camera.up, direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right);
    const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)), tanX = tanY * camera.aspect;
    let distance = 0;
    // Project all eight half-box corners in camera space, including their depth.
    for (const x of [-half.x, half.x]) for (const y of [-half.y, half.y]) for (const z of [-half.z, half.z]) {
      const corner = new THREE.Vector3(x, y, z);
      distance = Math.max(distance, Math.abs(corner.dot(right)) / tanX + corner.dot(direction), Math.abs(corner.dot(up)) / tanY + corner.dot(direction));
    }
    distance *= 1.18;
    controls.target.copy(center);
    controls.cursor.copy(center);
    controls.minDistance = Math.max(.02, half.length() * .15);
    controls.maxDistance = Math.max(distance * 8, 10);
    camera.position.copy(center).addScaledVector(direction, distance);
    controls.update();
    controls.saveState();
  }
  function measure() {
    if (disposed) return;
    const bounds = host.getBoundingClientRect();
    const nextWidth = host.clientWidth, nextHeight = host.clientHeight;
    // Once IntersectionObserver has reported, retain its ancestor clipping result.
    // A viewport-only rectangle must not wake a host clipped by overflow parents.
    if (!intersectionKnown) intersecting = bounds.bottom > 0 && bounds.right > 0 && bounds.top < window.innerHeight && bounds.left < window.innerWidth;
    if (nextWidth !== width || nextHeight !== height) {
      if (width && height && nextWidth && nextHeight) fitNeeded = true;
      width = nextWidth; height = nextHeight;
    }
    if (renderer && width > 0 && height > 0) {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(MAX_PIXELS / (width * height)), maxDimension / width, maxDimension / height);
      const pixelWidth = Math.max(1, Math.floor(width * dpr)), pixelHeight = Math.max(1, Math.floor(height * dpr));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { renderer.setSize(pixelWidth, pixelHeight, false); dirty = true; }
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
    schedule();
  }
  function reset() { if (!disposed && controls) { fitCamera(); requestRender(); } }
  function keyboard(event) {
    if (disposed || !controls || !hostVisible() || event.altKey || event.ctrlKey || event.metaKey) return;
    switch (event.key) {
      case 'ArrowLeft': controls.rotateLeft(.12); break;
      case 'ArrowRight': controls.rotateLeft(-.12); break;
      case 'ArrowUp': controls.rotateUp(.12); break;
      case 'ArrowDown': controls.rotateUp(-.12); break;
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
    if (!validated.meshes || validated.box.isEmpty()) throw new Error('Asset has no renderable mesh.');
    const size = validated.box.getSize(new THREE.Vector3()), extent = Math.max(size.x, size.y, size.z);
    if (!(extent > 0) || !Number.isFinite(extent)) throw new Error('Asset has degenerate bounds.');
    for (const clip of gltf.animations) {
      if (!Number.isFinite(clip.duration) || clip.duration < 0 || clip.tracks.some(track => !finite(track.times) || !finite(track.values))) throw new Error('Asset has invalid animation data.');
    }
    metrics = { ...metrics, triangles: validated.triangles, meshes: validated.meshes, materials: validated.materials, animations: gltf.animations.length };
    scene = new THREE.Scene();
    scene.background = new THREE.Color('#181b20');
    model = new THREE.Group();
    model.scale.setScalar(1 / extent);
    model.position.copy(validated.box.getCenter(new THREE.Vector3())).multiplyScalar(-1 / extent);
    model.add(gltf.scene);
    scene.add(model);
    model.updateMatrixWorld(true);
    normalizedBox = new THREE.Box3().setFromObject(model);
    // Actual studio illumination only: no pedestal, grid, or replacement mesh.
    scene.add(new THREE.HemisphereLight(0xdce6ff, 0x333945, 2.2));
    for (const [color, intensity, position] of [[0xe8efff, 3.8, [3, 4, 5]], [0x9fbaff, 2.4, [-4, 1, -2]], [0xffffff, 1.3, [1, -2, 3]]]) {
      const light = new THREE.DirectionalLight(color, intensity);
      light.position.set(...position);
      scene.add(light);
    }
    camera = new THREE.PerspectiveCamera(38, 1, .01, 100);
    canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${label || 'Asset'} — interactive 3D preview`);
    canvas.setAttribute('aria-description', 'Drag to orbit. Scroll or press plus and minus to zoom. Arrow keys orbit. Home or R resets the view.');
    canvas.style.cssText = 'display:block;width:100%;height:100%;outline-offset:-3px;';
    const context = canvas.getContext('webgl2', { alpha: false, antialias: true, powerPreference: 'low-power' });
    if (!context) throw new Error('WebGL2 is unavailable for this 3D preview.');
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
    controls = new OrbitControls(camera, canvas);
    const controlsRoot = canvas.getRootNode(), ownedControls = controls;
    // Three r186 disconnect() resolves getRootNode() again. Preserve cleanup of
    // these vendor interceptors even when the host was detached or reparented.
    listeners.push(() => {
      controlsRoot.removeEventListener('keydown', ownedControls._interceptControlDown, { capture: true });
      controlsRoot.removeEventListener('keyup', ownedControls._interceptControlUp, { capture: true });
    });
    controls.enableDamping = false;
    controls.enablePan = false;
    controls.autoRotate = false;
    controls.cursorStyle = 'grab';
    controls.addEventListener('change', requestRender);
    listeners.push(() => controls.removeEventListener('change', requestRender));
    if (gltf.animations.length) {
      mixer = new THREE.AnimationMixer(gltf.scene);
      // Clips may be alternate takes; show the first rather than blending all takes.
      mixer.clipAction(gltf.animations[0]).play();
      mixer.update(0);
    }
    listen(canvas, 'keydown', keyboard);
    listen(canvas, 'webglcontextlost', event => { event.preventDefault(); status('WebGL context lost. Reopen the 3D preview to continue.'); dispose(); });
    resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(host);
    intersectionObserver = new IntersectionObserver(entries => {
      intersectionKnown = true;
      const entry = entries[entries.length - 1];
      intersecting = entry.isIntersecting && entry.intersectionRatio > 0;
      schedule();
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
    listen(motion, 'change', () => { stopFrame(); requestRender(); });
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
      reset,
      setWireframe(enabled) {
        if (disposed) return;
        gltf.scene.traverse(object => {
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            if (material && 'wireframe' in material) { material.wireframe = !!enabled; material.needsUpdate = true; }
          }
        });
        requestRender();
      },
      setAnimationPlaying(enabled) { if (!disposed) { playing = !!enabled; stopFrame(); requestRender(); } },
      dispose,
      hasAnimations: gltf.animations.length > 0,
      stats: () => ({ ...metrics }),
    };
  } catch (error) {
    dispose();
    if (error.name !== 'AbortError') status(`3D preview unavailable: ${error.message}`);
    throw error;
  } finally { rejectPending = null; }
}
