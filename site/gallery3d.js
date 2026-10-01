import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const SPACING = 4.4;     // metres between artwork centres
const HANG_Y = 1.58;     // centre line of the hang
const WALL_H = 4.2;
const TRACK_Z = 1.75;    // ceiling track distance from wall
const TRACK_Y = 3.72;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (t) => t * t * (3 - 2 * t);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/* ------------------------------------------------------------------ */
/* small canvas helpers (heavy textures are pre-baked: tools/bake_textures.py) */
/* ------------------------------------------------------------------ */

function makeCanvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function edgeColour(img) {
  const c = makeCanvas(32);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, 32, 32);
  const d = g.getImageData(0, 0, 32, 32).data;
  let r = 0, gg = 0, b = 0, n = 0;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    if (x > 1 && x < 30 && y > 1 && y < 30) continue;
    const i = (y * 32 + x) * 4;
    r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++;
  }
  return new THREE.Color(`rgb(${Math.round(r / n)},${Math.round(gg / n)},${Math.round(b / n)})`).convertSRGBToLinear();
}

// soft elliptical wash that stands in for a spotlight's pool on the wall
function lightPoolTexture() {
  const c = makeCanvas(256);
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 110, 0, 128, 128, 128);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.75)');
  grd.addColorStop(0.8, 'rgba(255,255,255,0.18)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

function dustSprite() {
  const c = makeCanvas(64);
  const g = c.getContext('2d', { willReadFrequently: true });
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,248,235,1)');
  grd.addColorStop(0.35, 'rgba(255,248,235,0.35)');
  grd.addColorStop(1, 'rgba(255,248,235,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/* ------------------------------------------------------------------ */
/* shaders                                                             */
/* ------------------------------------------------------------------ */

const beamMaterial = () => new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
  uniforms: { uStrength: { value: 0 } },
  vertexShader: /* glsl */`
    varying vec2 vUv; varying vec3 vN; varying vec3 vV;
    void main() {
      vUv = uv;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vN = normalMatrix * normal;
      vV = -mv.xyz;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform float uStrength;
    varying vec2 vUv; varying vec3 vN; varying vec3 vV;
    void main() {
      vec3 n = vN / max(length(vN), 1e-4);
      vec3 v = vV / max(length(vV), 1e-4);
      float along = pow(clamp(vUv.y, 0.001, 1.0), 1.6);          // brightest at the lamp
      float edge = pow(clamp(abs(dot(n, v)), 0.001, 1.0), 2.2);  // soft cone silhouette
      float a = clamp(along * edge * 0.16 * uStrength, 0.0, 1.0);
      gl_FragColor = vec4(vec3(1.0, 0.95, 0.86) * a, a);
    }`,
});

// Single full-screen pass: guards HDR overflow, tone maps (Khronos PBR Neutral keeps the
// artwork's colours faithful), converts to sRGB, then adds the lens character.
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uGrain: { value: 0.045 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uGrain;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    vec3 neutral(vec3 color) {
      const float start = 0.76, desat = 0.15;
      float x = min(color.r, min(color.g, color.b));
      color -= x < 0.08 ? x - 6.25 * x * x : 0.04;
      float peak = max(color.r, max(color.g, color.b));
      if (peak < start) return color;
      float d = 1.0 - start;
      float newPeak = 1.0 - d * d / (peak + d - start);
      color *= newPeak / peak;
      float g = 1.0 - 1.0 / (desat * (peak - newPeak) + 1.0);
      return mix(color, vec3(newPeak), g);
    }
    vec3 hdr(vec2 uv) {
      // min/max drop NaN on D3D/ANGLE, so this also scrubs bad pixels
      return min(max(texture2D(tDiffuse, uv).rgb, vec3(0.0)), vec3(24.0));
    }
    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      vec2 off = c * r2 * 0.012;                       // faint chromatic fringe toward the corners
      vec3 col = vec3(hdr(vUv + off).r, hdr(vUv).g, hdr(vUv - off).b);
      col = neutral(col);
      col = mix(1.055 * pow(col, vec3(1.0 / 2.4)) - 0.055, col * 12.92, step(col, vec3(0.0031308)));
      col *= mix(1.0, smoothstep(0.85, 0.18, r2 * 1.6), 0.55);  // vignette
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col += (hash(vUv * vec2(1920.0, 1080.0) + fract(uTime) * 100.0) - 0.5) * uGrain * (1.0 - lum * 0.7);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

/* ------------------------------------------------------------------ */
/* scene                                                               */
/* ------------------------------------------------------------------ */

export function initGallery({ canvas, works, onStation, onReady, onLoadProgress, onPick }) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // phones and tablets get a lighter scene (no mirror pass, smaller shadows)
  const lite = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 600;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  } catch (e) {
    return null;
  }
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
  const integrated = lite || /intel|uhd|iris|hd graphics|mali|adreno|powervr|swiftshader|llvmpipe|microsoft basic/i.test(gpu);
  let dpr = Math.min(devicePixelRatio, lite ? 1.25 : integrated ? 1 : 1.5);
  renderer.setPixelRatio(dpr);
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping; // keeps the artwork's own colours faithful
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // smaller, faster shader than PCFSoft; softened via shadow.radius
  // nothing in the room moves, so shadow maps are drawn once after loading instead of every frame
  renderer.shadowMap.autoUpdate = false;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0d0e0f');
  scene.fog = new THREE.Fog('#0d0e0f', 14, 34);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.22;

  const camera = new THREE.PerspectiveCamera(40, canvas.clientWidth / canvas.clientHeight, 0.05, 80);

  const n = works.length;
  const wallStart = -9, wallEnd = (n - 1) * SPACING + 9;
  const wallLen = wallEnd - wallStart;
  const wallMid = (wallStart + wallEnd) / 2;

  const manager = new THREE.LoadingManager();
  manager.onProgress = (_u, loaded, total) => onLoadProgress && onLoadProgress(loaded / total);
  // ImageBitmapLoader decodes images off the main thread, so loading doesn't stall scrolling
  const bitmaps = typeof createImageBitmap === 'function'
    ? new THREE.ImageBitmapLoader(manager).setOptions({ imageOrientation: 'flipY' })
    : null;
  const images = new THREE.ImageLoader(manager);
  const loadTex = (url, onLoad) => {
    const t = new THREE.Texture();
    if (bitmaps) t.flipY = false; // already flipped during decode
    (bitmaps || images).load(url, (img) => {
      t.image = img;
      t.needsUpdate = true;
      onLoad && onLoad(t);
    });
    return t;
  };
  const tiled = (url, rx, ry, srgb = false) => {
    const t = loadTex(url);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx, ry);
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };

  /* room shell ----------------------------------------------------- */
  const plasterNormal = tiled('assets/tex/plaster-normal.jpg', wallLen / 2.5, WALL_H / 2.5);
  const wallMat = new THREE.MeshStandardMaterial({
    color: '#4b5157', roughness: 0.93, metalness: 0,
    normalMap: plasterNormal, normalScale: new THREE.Vector2(0.05, 0.05),
  });
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(wallLen, WALL_H), wallMat);
  wall.position.set(wallMid, WALL_H / 2, 0);
  wall.receiveShadow = true;
  scene.add(wall);

  // skirting
  const skirt = new THREE.Mesh(
    new THREE.BoxGeometry(wallLen, 0.11, 0.018),
    new THREE.MeshStandardMaterial({ color: '#2a2e31', roughness: 0.6 })
  );
  skirt.position.set(wallMid, 0.055, 0.009);
  skirt.receiveShadow = true;
  scene.add(skirt);

  // ceiling
  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(wallLen, 16),
    new THREE.MeshStandardMaterial({ color: '#0e0f10', roughness: 1 })
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(wallMid, WALL_H, 8);
  scene.add(ceiling);

  // floor: mirror underneath a semi-opaque polished concrete skin
  const concrete = {
    map: tiled('assets/tex/concrete.jpg', wallLen / 3.2, 16 / 3.2, true),
    rough: tiled('assets/tex/concrete-rough.jpg', wallLen / 3.2, 16 / 3.2),
  };
  let reflector = null;
  let reflScale = 0.4; // mirror resolution relative to the screen
  if (!lite) {
    reflector = new Reflector(new THREE.PlaneGeometry(wallLen, 16), {
      textureWidth: Math.round(canvas.clientWidth * dpr * reflScale),
      textureHeight: Math.round(canvas.clientHeight * dpr * reflScale),
      color: 0xb4b4b4,
      clipBias: 0.003,
    });
    reflector.rotation.x = -Math.PI / 2;
    reflector.position.set(wallMid, 0, 8);
    scene.add(reflector);
  }
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(wallLen, 16),
    new THREE.MeshStandardMaterial({
      map: concrete.map, roughnessMap: concrete.rough, roughness: 1, metalness: 0,
      transparent: !!reflector, opacity: reflector ? 0.5 : 1,
    })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(wallMid, 0.002, 8);
  floor.receiveShadow = true;
  scene.add(floor);

  // ceiling track
  const metalDark = new THREE.MeshStandardMaterial({ color: '#141516', roughness: 0.35, metalness: 0.85 });
  const track = new THREE.Mesh(new THREE.BoxGeometry(wallLen, 0.035, 0.05), metalDark);
  track.position.set(wallMid, TRACK_Y + 0.12, TRACK_Z);
  scene.add(track);

  // a little fill so the room never goes fully black
  scene.add(new THREE.HemisphereLight('#9aa3ad', '#2a2a2a', 0.4));

  /* artworks + lighting ----------------------------------------------- */
  // Only the 2–3 works nearest the camera get a real shadow-casting spotlight (a pool that
  // follows the walk). Every other lamp is faked cheaply: a baked light pool on the wall and
  // a self-lit canvas. Per-pixel cost stays flat no matter how many works hang on the wall.
  const POOL = lite ? 2 : 3;
  const pickables = [];
  const lamps = [];

  const frameMats = {
    black: new THREE.MeshStandardMaterial({ color: '#111213', roughness: 0.45, metalness: 0.1 }),
    oak: new THREE.MeshStandardMaterial({ color: '#8d8a84', roughness: 0.7, metalness: 0 }),
  };
  const glassMat = new THREE.MeshStandardMaterial({
    color: '#ffffff', roughness: 0.08, metalness: 0, transparent: true, opacity: 0.07, envMapIntensity: 2.5, depthWrite: false,
  });
  const poolTex = lightPoolTexture();
  const flareTex = dustSprite();

  const pool = [];
  for (let p = 0; p < POOL; p++) {
    const spot = new THREE.SpotLight('#fff6ec', 0, 9, 0.36, 0.6, 2);
    spot.castShadow = true;
    spot.shadow.mapSize.set(lite ? 512 : 1024, lite ? 512 : 1024);
    spot.shadow.bias = -0.0004;
    spot.shadow.normalBias = 0.02;
    spot.shadow.radius = 3;
    spot.shadow.camera.near = 0.5;
    spot.shadow.camera.far = 8;
    scene.add(spot, spot.target);
    pool.push({ spot, lamp: -1, level: 0 });
  }

  function addLamp(cx, artH, isPaint) {
    const aim = new THREE.Vector3(cx, HANG_Y - artH * 0.08, 0);
    const pos = new THREE.Vector3(cx, TRACK_Y, TRACK_Z);
    // drawings get a tighter, gentler beam so graphite doesn't wash out
    const angle = isPaint ? 0.36 : 0.27;
    const dist = pos.distanceTo(aim);

    // fixture: stem + can + glowing lens
    const fixture = new THREE.Group();
    fixture.position.copy(pos);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.12, 12), metalDark);
    stem.position.y = 0.06;
    fixture.add(stem);
    const head = new THREE.Group();
    const canGeo = new THREE.CylinderGeometry(0.05, 0.056, 0.17, 24, 1, true);
    canGeo.rotateX(Math.PI / 2);
    head.add(new THREE.Mesh(canGeo, metalDark));
    const lensMat = new THREE.MeshBasicMaterial({ color: '#000000' });
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.046, 24), lensMat);
    lens.position.z = 0.07;
    head.add(lens);
    fixture.add(head);
    scene.add(fixture);
    head.lookAt(aim);

    // soft halo on the lens (stands in for bloom at a fraction of the cost)
    const flareMat = new THREE.SpriteMaterial({
      map: flareTex, color: '#fff4e4', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    });
    const flare = new THREE.Sprite(flareMat);
    flare.position.copy(pos).addScaledVector(aim.clone().sub(pos).normalize(), 0.09);
    flare.scale.setScalar(0.3);
    scene.add(flare);

    // visible beam in the air
    const beamGeo = new THREE.ConeGeometry(Math.tan(angle) * dist * 0.9, dist, 32, 1, true);
    beamGeo.translate(0, -dist / 2, 0);
    beamGeo.rotateX(-Math.PI / 2);
    const beam = new THREE.Mesh(beamGeo, beamMaterial());
    beam.position.copy(pos);
    beam.lookAt(aim);
    beam.renderOrder = 2;
    scene.add(beam);

    // baked stand-in for the light pool, shown while this lamp has no real spotlight
    const pw = Math.tan(angle) * dist * 2.3;
    const poolMat = new THREE.MeshBasicMaterial({
      map: poolTex, color: '#fff2e0', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const poolMesh = new THREE.Mesh(new THREE.PlaneGeometry(pw, pw * 1.5), poolMat);
    poolMesh.position.set(cx, aim.y + pw * 0.12, 0.004);
    scene.add(poolMesh);

    const lamp = { x: cx, aim, angle, gain: isPaint ? 1 : 0.42, lensMat, flareMat, beam, poolMat, glow: [], warm: 0, real: 0 };
    lamps.push(lamp);
    return lamp;
  }

  works.forEach((w, i) => {
    const cx = i * SPACING;
    const isPaint = w.kind === 'paint';
    const group = new THREE.Group();
    group.position.set(cx, HANG_Y, 0);
    scene.add(group);
    const lamp = addLamp(cx, w.height, isPaint);

    const normalMap = loadTex('assets/tex/normal/' + w.src.split('/').pop());
    loadTex(w.src, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      const img = tex.image;
      const aspect = img.width / img.height;
      const h = w.height, wd = h * aspect;
      // emissive copy of the artwork = how it looks under the faked lamp
      const glowing = (params) => {
        const m = new THREE.MeshStandardMaterial({ ...params, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0 });
        lamp.glow.push(m);
        return m;
      };

      if (isPaint) {
        const depth = 0.038;
        const side = new THREE.MeshStandardMaterial({ color: edgeColour(img), roughness: 0.8 });
        const front = glowing({ map: tex, normalMap, normalScale: new THREE.Vector2(0.32, 0.32), roughness: 0.62, metalness: 0 });
        const back = new THREE.MeshStandardMaterial({ color: '#1a1a1a' });
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(wd, h, depth), [side, side, side, side, front, back]);
        mesh.position.z = depth / 2 + 0.012; // hangs off the wall on its stretcher
        mesh.castShadow = true;
        mesh.userData.index = i;
        group.add(mesh);
        pickables.push(mesh);
      } else {
        const mat = 0.075, fw = 0.032, fd = 0.03;
        const W = wd + mat * 2, H = h + mat * 2;
        const fm = frameMats[w.frame || 'black'];
        [
          [W + fw * 2, fw, 0, H / 2 + fw / 2],
          [W + fw * 2, fw, 0, -H / 2 - fw / 2],
          [fw, H, -W / 2 - fw / 2, 0],
          [fw, H, W / 2 + fw / 2, 0],
        ].forEach(([bw, bh, bx, by]) => {
          const bar = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, fd), fm);
          bar.position.set(bx, by, fd / 2 + 0.004);
          bar.castShadow = true;
          group.add(bar);
        });
        const boardMat = new THREE.MeshStandardMaterial({ color: '#efeee9', roughness: 0.95, emissive: '#efeee9', emissiveIntensity: 0 });
        lamp.glow.push(boardMat);
        const board = new THREE.Mesh(new THREE.PlaneGeometry(W, H), boardMat);
        board.position.z = 0.012;
        board.receiveShadow = true;
        group.add(board);
        const art = new THREE.Mesh(
          new THREE.PlaneGeometry(wd, h),
          glowing({ map: tex, normalMap, normalScale: new THREE.Vector2(0.25, 0.25), roughness: 0.85 })
        );
        art.position.z = 0.0125;
        art.receiveShadow = true;
        art.userData.index = i;
        group.add(art);
        pickables.push(art);
        const glass = new THREE.Mesh(new THREE.PlaneGeometry(W, H), glassMat);
        glass.position.z = fd - 0.002;
        glass.renderOrder = 3;
        group.add(glass);
        // invisible backing so the frame throws a full shadow
        const shadowCaster = new THREE.Mesh(new THREE.BoxGeometry(W, H, 0.01), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
        shadowCaster.position.z = 0.008;
        shadowCaster.castShadow = true;
        group.add(shadowCaster);
      }
    });
  });

  // hand the real spotlights to the lamps nearest the point the camera is looking at
  function assignPool(focusX, dt) {
    const wanted = lamps.map((_, i) => i)
      .sort((a, b) => Math.abs(lamps[a].x - focusX) - Math.abs(lamps[b].x - focusX))
      .slice(0, POOL);
    const free = pool.filter((p) => !wanted.includes(p.lamp));
    wanted.forEach((li) => {
      if (pool.some((p) => p.lamp === li)) return;
      const p = free.shift();
      const l = lamps[li];
      p.lamp = li;
      p.level = 0;
      p.spot.position.set(l.x, TRACK_Y, TRACK_Z);
      p.spot.target.position.copy(l.aim);
      p.spot.angle = l.angle;
      p.spot.updateMatrixWorld();
      p.spot.target.updateMatrixWorld();
      renderer.shadowMap.needsUpdate = true;
    });
    lamps.forEach((l) => { l.real = 0; });
    pool.forEach((p) => {
      p.level = reduced ? 1 : Math.min(1, p.level + dt * 5);
      const l = lamps[p.lamp];
      if (!l) return;
      l.real = p.level;
      p.spot.intensity = LAMP_PEAK * l.gain * l.warm * p.level;
    });
  }

  /* dust in the light -------------------------------------------- */
  const DUST = lite ? 260 : 700;
  const dustGeo = new THREE.BufferGeometry();
  const dustPos = new Float32Array(DUST * 3);
  const dustSeed = new Float32Array(DUST);
  for (let i = 0; i < DUST; i++) {
    dustPos[i * 3] = wallStart + Math.random() * wallLen;
    dustPos[i * 3 + 1] = 0.3 + Math.random() * 3.3;
    dustPos[i * 3 + 2] = 0.2 + Math.random() * 3.2;
    dustSeed[i] = Math.random() * 100;
  }
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    map: dustSprite(), size: 0.012, sizeAttenuation: true, transparent: true, opacity: 0,
    depthWrite: false, blending: THREE.AdditiveBlending, color: '#fff5e6',
  }));
  scene.add(dust);

  /* post ---------------------------------------------------------- */
  const size = new THREE.Vector2(canvas.clientWidth, canvas.clientHeight);
  const rt = new THREE.WebGLRenderTarget(size.x * dpr, size.y * dpr, {
    type: THREE.HalfFloatType,
    samples: lite ? 0 : integrated ? 2 : 4,
  });
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(dpr);
  composer.addPass(new RenderPass(scene, camera));
  const grade = new ShaderPass(FinalShader);
  composer.addPass(grade);

  /* camera path --------------------------------------------------- */
  // station s: -1 = establishing shot, 0..n-1 = in front of artwork i, n = end shot
  const last = (n - 1) * SPACING;
  const estPos = new THREE.Vector3(-6.2, 1.72, 5.6), estTgt = new THREE.Vector3(-1.6, 1.5, 0.3);
  const endPos = new THREE.Vector3(last + 3.2, 2.1, 8.6), endTgt = new THREE.Vector3(last - 5, 1.35, 0);
  const pos = new THREE.Vector3(), tgt = new THREE.Vector3();
  const tmpP = new THREE.Vector3(), tmpT = new THREE.Vector3();

  function viewForArt(s, outP, outT) {
    const i = Math.floor(s), f = s - i;
    const e = easeInOut(f);
    const x = (i + e) * SPACING;
    const walk = Math.sin(Math.PI * f);           // 0 at artworks, 1 mid-walk
    const art = works[clamp(Math.round(s), 0, n - 1)];
    const viewDist = art.kind === 'paint' ? 1.7 + art.height * 1.15 : 1.3 + art.height * 1.45;      // stand further back from big work
    outP.set(x, 1.62, viewDist + walk * 0.9);
    outT.set(x + walk * 1.1, HANG_Y - 0.02, 0);
  }

  function cameraAt(s) {
    if (s <= 0) {
      viewForArt(0, tmpP, tmpT);
      const k = smooth(clamp(-s, 0, 1));
      pos.lerpVectors(tmpP, estPos, k);
      tgt.lerpVectors(tmpT, estTgt, k);
    } else if (s >= n - 1) {
      viewForArt(n - 1, tmpP, tmpT);
      const k = smooth(clamp(s - (n - 1), 0, 1));
      pos.lerpVectors(tmpP, endPos, k);
      tgt.lerpVectors(tmpT, endTgt, k);
    } else {
      viewForArt(s, pos, tgt);
    }
  }

  /* interaction --------------------------------------------------- */
  let targetS = -1, s = -1;
  const mouse = new THREE.Vector2(), mouseSm = new THREE.Vector2();
  const ndc = new THREE.Vector2();
  const ray = new THREE.Raycaster();
  let hoverIndex = -1;

  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1);
    ndc.set(mouse.x, -mouse.y);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickables, false)[0];
    hoverIndex = hit ? hit.object.userData.index : -1;
    canvas.classList.toggle('pointing', hoverIndex >= 0);
  });
  canvas.addEventListener('pointerleave', () => { mouse.set(0, 0); hoverIndex = -1; });
  canvas.addEventListener('click', () => { if (hoverIndex >= 0 && onPick) onPick(hoverIndex); });

  /* lights-on sequence ------------------------------------------- */
  let lightsStart = -1;
  const LAMP_PEAK = 92;

  manager.onLoad = async () => {
    scene.traverse((o) => {
      const mats = o.material ? [].concat(o.material) : [];
      mats.forEach((m) => ['map', 'normalMap', 'roughnessMap'].forEach((k) => m[k] && renderer.initTexture(m[k])));
    });
    renderer.setRenderTarget(composer.renderTarget1);
    try { await renderer.compileAsync(scene, camera); } catch (e) { /* falls back to compiling on first draw */ }
    renderer.setRenderTarget(null);
    renderer.shadowMap.needsUpdate = true;
    // walk the camera along the wall once, unseen, so every piece's first draw happens now
    // (geometry uploads, mirror pass, post chain) rather than mid-scroll
    for (let k = -1; k <= n; k += 1.5) {
      cameraAt(k);
      camera.position.copy(pos);
      camera.lookAt(tgt);
      assignPool(tgt.x, 1);
      composer.render();
      await new Promise((r) => { requestAnimationFrame(r); setTimeout(r, 60); }); // rAF stalls in background tabs
    }
    lightsStart = performance.now();
    canvas.classList.add('ready');
    onReady && onReady();
  };

  /* loop ---------------------------------------------------------- */
  let running = true, lastStation = null;
  let idleFlip = false, slowTime = 0, sampleTime = 0;
  const minDpr = lite ? 0.6 : 0.7;
  const clock = new THREE.Clock();
  const lookTgt = new THREE.Vector3();

  function frame() {
    if (!running) return;
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;

    s += (targetS - s) * (reduced ? 1 : 1 - Math.exp(-dt * 3.2));
    mouseSm.lerp(mouse, reduced ? 1 : 1 - Math.exp(-dt * 2.5));
    cameraAt(s);
    camera.position.copy(pos);
    camera.position.x += mouseSm.x * 0.22;
    camera.position.y -= mouseSm.y * 0.1;
    if (!reduced) camera.position.y += Math.sin(t * 0.6) * 0.008; // breathing handheld drift
    lookTgt.copy(tgt);
    camera.lookAt(lookTgt);

    // lamps warm up one by one, rippling out from the first piece
    const since = lightsStart < 0 ? -1 : (performance.now() - lightsStart) / 1000;
    lamps.forEach((l, i) => {
      let k = 0;
      if (since >= 0) k = reduced ? 1 : clamp((since - 0.25 - i * 0.16) / 0.9, 0, 1);
      l.warm = k < 1 && k > 0 ? k * (0.85 + 0.15 * Math.sin(k * 40)) : k; // filament settle
      l.lensMat.color.setRGB(l.warm, 0.95 * l.warm, 0.88 * l.warm);
      l.flareMat.opacity = l.warm * 0.85;
      l.beam.material.uniforms.uStrength.value = l.warm;
    });
    assignPool(tgt.x, dt);
    // lamps without a real spotlight show the baked look instead
    lamps.forEach((l) => {
      const fake = l.warm * (1 - l.real);
      l.poolMat.opacity = fake * 0.42 * (0.55 + 0.45 * l.gain);
      l.glow.forEach((m) => { m.emissiveIntensity = fake * 0.5; });
    });
    dust.material.opacity = since >= 0 ? clamp(since - 0.8, 0, 1) * 0.55 : 0;

    if (!reduced) {
      const p = dust.geometry.attributes.position;
      for (let i = 0; i < DUST; i++) {
        const sd = dustSeed[i];
        p.array[i * 3] += Math.sin(t * 0.13 + sd) * 0.0006;
        p.array[i * 3 + 1] += Math.cos(t * 0.11 + sd * 1.7) * 0.0005 - 0.00008;
        if (p.array[i * 3 + 1] < 0.2) p.array[i * 3 + 1] = 3.5;
      }
      p.needsUpdate = true;
      grade.uniforms.uTime.value = t;
    }

    // at rest (camera settled, lights on) the scene only needs half-rate frames for dust and grain
    const moving = Math.abs(targetS - s) > 0.0005 || mouseSm.distanceToSquared(mouse) > 1e-6;
    const warming = since < lamps.length * 0.16 + 1.5;
    idleFlip = !idleFlip;
    if (moving || warming || idleFlip) {
      composer.render();
      adaptQuality(dt, moving);
    }

    const nearest = Math.round(s);
    const station = (nearest >= 0 && nearest < n && Math.abs(s - nearest) < 0.2) ? nearest : null;
    const stage = s < -0.6 ? 'intro' : s > n - 0.4 ? 'end' : 'walk';
    const key = station + stage;
    if (key !== lastStation) {
      lastStation = key;
      onStation && onStation(station, stage);
    }
  }
  frame();

  // adaptive resolution: if frames run long while walking, step the pixel ratio down
  function adaptQuality(dt, moving) {
    if (!moving || lightsStart < 0) return;
    sampleTime += dt;
    if (dt > 1 / 45) slowTime += dt;
    if (sampleTime < 1.2) return;
    if (slowTime / sampleTime > 0.4) stepDown();
    sampleTime = slowTime = 0;
  }

  // cheapest-looking losses first: a softer mirror, no mirror, then resolution
  function stepDown() {
    if (reflector && reflector.visible && reflScale > 0.25) { reflScale = 0.22; resize(); return; }
    if (reflector && reflector.visible) {
      reflector.visible = false;
      floor.material.transparent = false;
      floor.material.opacity = 1;
      floor.material.needsUpdate = true;
      return;
    }
    if (dpr > minDpr) {
      dpr = Math.max(minDpr, +(dpr - 0.2).toFixed(2));
      renderer.setPixelRatio(dpr);
      composer.setPixelRatio(dpr);
      resize();
    }
  }

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    // keep the artwork comfortably in frame on tall phone screens
    camera.fov = w / h < 0.8 ? 58 : w / h < 1.2 ? 48 : 40;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    if (reflector) reflector.getRenderTarget().setSize(Math.round(w * dpr * reflScale), Math.round(h * dpr * reflScale));
  }
  addEventListener('resize', resize);
  resize();

  return {
    setProgress(p) { if (!Number.isFinite(p)) return; targetS = -1 + clamp(p, 0, 1) * (n + 1); },
    pause() { running = false; },
    resume() { if (!running) { running = true; clock.getDelta(); frame(); } },
  };
}
