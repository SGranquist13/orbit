import { useLayoutEffect, useRef } from "react";
import * as THREE from "three";
import { clamp, easeOut, prog, rng, smooth, type Aspect } from "../lib";
import { T } from "../timeline";

const CELL = 3; // size of one dither pixel on screen
const N_DISC = 70000;
const R_HOLE = 1.0;

const DISC_VERT = /* glsl */ `
attribute float aR;
attribute float aPhi;
attribute float aSeed;
attribute float aH;
uniform float uTime;
uniform float uForm;
uniform float uLens;
uniform float uSize;
varying float vI;
void main() {
  float omega = 2.1 / pow(aR, 1.5);
  float phi = aPhi + omega * uTime;
  float spread = (1.0 - uForm);
  // Before the disc forms, every particle is thrown out on a seeded swirl and falls in.
  float swirl = spread * (2.0 + 5.0 * aSeed);
  float r = aR * (1.0 + spread * (1.5 + 3.0 * aSeed));
  phi += swirl;
  vec3 p = vec3(r * cos(phi), aH * (0.018 + 0.011 * r) * (1.0 + spread * 14.0), r * sin(phi));
  // Beaming: the side moving toward the camera is brighter.
  float beam = 0.62 + 0.55 * (-sin(phi) * 0.0 + cos(phi + 0.6));
  float heat = pow(1.6 / aR, 1.35) * 1.9;
  vI = clamp(heat * beam, 0.0, 3.0);
  if (uLens > 0.5) {
    // Light from the far side of the disc bent over the hole: an arc above, a dimmer one below.
    float far = step(p.z, 0.0);
    float th = atan(abs(p.z) + 0.001, p.x);
    float rho = 1.13 + 0.5 * (aR - 1.6) / 3.4 * (0.5 + 0.5 * aSeed);
    float dir = aSeed > 0.78 ? -1.0 : 1.0;
    p = vec3(cos(th) * rho * (dir < 0.0 ? 0.96 : 1.0), dir * sin(th) * rho * (dir < 0.0 ? 0.82 : 1.0), 0.2);
    vI *= far * (dir < 0.0 ? 0.55 : 1.0) * 0.8;
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * (1.0 + 0.5 * aSeed) * (9.0 / -mv.z);
}
`;
const DISC_FRAG = /* glsl */ `
varying float vI;
uniform float uFade;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.15, length(c));
  gl_FragColor = vec4(vec3(vI * 0.085 * a * uFade), 1.0);
}
`;

const POST_VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const POST_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tex;
uniform vec2 res;
uniform float gain;
const float B[16] = float[16](0.,8.,2.,10., 12.,4.,14.,6., 3.,11.,1.,9., 15.,7.,13.,5.);
void main() {
  vec2 px = floor(vUv * res);
  float lum = pow(clamp(texture2D(tex, (px + 0.5) / res).r * gain, 0.0, 1.0), 0.85);
  int i = int(mod(px.x, 4.0)) + 4 * int(mod(px.y, 4.0));
  float th = (B[i] + 0.5) / 16.0;
  float on = step(th, lum);
  vec3 ink = vec3(0.925, 0.925, 0.937);
  vec3 bg = vec3(5.0, 5.0, 6.0) / 255.0;
  gl_FragColor = vec4(mix(bg, ink, on), 1.0);
}
`;

interface Rig {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  rt: THREE.WebGLRenderTarget;
  post: THREE.Mesh;
  postScene: THREE.Scene;
  postCam: THREE.OrthographicCamera;
  disc: THREE.Points;
  lens: THREE.Points;
  planet: THREE.Mesh;
  ring: THREE.Mesh;
  uniforms: { time: { value: number }; form: { value: number }; fade: { value: number } };
  w: number;
  h: number;
}
let rig: Rig | null = null;

function build(w: number, h: number): Rig {
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, alpha: false });
  renderer.setPixelRatio(1);
  renderer.setSize(w, h);
  renderer.domElement.style.cssText = `position:absolute;inset:0;width:${w}px;height:${h}px`;
  const rw = Math.ceil(w / CELL), rh = Math.ceil(h / CELL);
  const rt = new THREE.WebGLRenderTarget(rw, rh, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });

  // Seeded disc.
  const rand = rng(20260);
  const aR = new Float32Array(N_DISC), aPhi = new Float32Array(N_DISC), aSeed = new Float32Array(N_DISC), aH = new Float32Array(N_DISC);
  const pos = new Float32Array(N_DISC * 3);
  for (let i = 0; i < N_DISC; i++) {
    // Denser toward the inner edge.
    const u = rand();
    aR[i] = 1.55 + Math.pow(u, 1.9) * 3.9;
    aPhi[i] = rand() * Math.PI * 2;
    aSeed[i] = rand();
    aH[i] = (rand() + rand() + rand() - 1.5) * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aR", new THREE.BufferAttribute(aR, 1));
  geo.setAttribute("aPhi", new THREE.BufferAttribute(aPhi, 1));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(aSeed, 1));
  geo.setAttribute("aH", new THREE.BufferAttribute(aH, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);
  const uniforms = { time: { value: 0 }, form: { value: 0 }, fade: { value: 1 } };
  const mk = (lens: number) =>
    new THREE.ShaderMaterial({
      vertexShader: DISC_VERT, fragmentShader: DISC_FRAG, transparent: true, depthWrite: false, depthTest: lens === 0,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: uniforms.time, uForm: uniforms.form, uFade: uniforms.fade, uLens: { value: lens }, uSize: { value: 2.6 } },
    });
  const disc = new THREE.Points(geo, mk(0));
  const lens = new THREE.Points(geo, mk(1));
  disc.frustumCulled = false;
  lens.frustumCulled = false;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  // The horizon hides what is behind it.
  const hole = new THREE.Mesh(new THREE.SphereGeometry(R_HOLE, 48, 32), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  scene.add(hole);
  // Photon ring: a thin bright circle facing the camera.
  const ring = new THREE.Mesh(new THREE.RingGeometry(R_HOLE * 1.015, R_HOLE * 1.075, 128), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, depthTest: false }));
  ring.renderOrder = 5;
  scene.add(ring);
  scene.add(disc, lens);

  // The planet: lit sphere on a tilted orbit; hidden by the horizon on the far side.
  const planet = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 32, 20),
    new THREE.ShaderMaterial({
      vertexShader: `varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
      fragmentShader: `varying vec3 vN; void main(){ float l = clamp(dot(vN, normalize(vec3(-0.6,0.5,0.7))) * 0.5 + 0.55, 0.0, 1.0); gl_FragColor = vec4(vec3(l*0.5), 1.0);} `,
    }),
  );
  scene.add(planet);

  const camera = new THREE.PerspectiveCamera(32, w / h, 0.1, 100);

  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const postScene = new THREE.Scene();
  const post = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({ vertexShader: POST_VERT, fragmentShader: POST_FRAG, uniforms: { tex: { value: rt.texture }, res: { value: new THREE.Vector2(rw, rh) }, gain: { value: 1.6 } }, depthTest: false }),
  );
  postScene.add(post);
  return { renderer, scene, camera, rt, post, postScene, postCam, disc, lens, planet, ring, uniforms, w, h };
}

/** Where the hole sits and how big it is, per aspect and scene (hero opener vs. closing lock-up). */
function placement(aspect: Aspect, w: number, h: number, closer: number) {
  const hero = aspect === "4x5" ? { cx: w / 2, cy: h * 0.5, scale: 1.0 } : { cx: w / 2, cy: h * 0.5, scale: 1.0 };
  const end = aspect === "4x5" ? { cx: w / 2, cy: h * 0.255, scale: 0.55 } : { cx: w / 2, cy: h * 0.27, scale: 0.62 };
  const k = smooth(closer);
  return { cx: hero.cx + (end.cx - hero.cx) * k, cy: hero.cy + (end.cy - hero.cy) * k, scale: hero.scale + (end.scale - hero.scale) * k };
}

export function BlackHoleLayer({ w, h, aspect, t }: { w: number; h: number; aspect: Aspect; t: number }) {
  const host = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!rig || rig.w !== w || rig.h !== h) rig = build(w, h);
    const r = rig;
    if (host.current && r.renderer.domElement.parentElement !== host.current) host.current.appendChild(r.renderer.domElement);

    const closing = t >= T.closerWipe;
    const closer = closing ? 1 : 0;
    const p = placement(aspect, w, h, closer);
    r.uniforms.time.value = t;
    r.uniforms.form.value = closing ? 1 : smooth(prog(t, 0.2, 3.1));
    r.uniforms.fade.value = closing ? 1 : easeOut(prog(t, 0, 0.9));

    // Camera: slightly above the disc plane, rolled like the brand mark.
    const dist = 15;
    const roll = (-15 * Math.PI) / 180;
    const zoom = (aspect === "4x5" ? 1.0 : 1.18) * p.scale * (1 + 0.06 * prog(t, 0, 4));
    r.camera.fov = 32;
    r.camera.position.set(0, 4.6, dist);
    r.camera.up.set(Math.sin(-roll), Math.cos(roll), 0);
    r.camera.lookAt(0, 0, 0);
    r.camera.aspect = w / h;
    // Fit: the disc's outer edge (~5.5) spans about 0.78 of the short side at zoom 1.
    const short = Math.min(w, h);
    const view = (2 * dist * Math.tan((32 * Math.PI) / 360)) * (h / short) * (1 / (0.78 * zoom)) * (5.5 / 5.5);
    r.camera.fov = (2 * Math.atan(view / 2 / dist) * 180) / Math.PI;
    r.camera.setViewOffset(w, h, -(p.cx - w / 2), -(p.cy - h / 2), w, h);
    r.camera.updateProjectionMatrix();

    // Planet arcs behind the horizon around t=3 s.
    const a = -Math.PI / 2 + (t - 2.9) * 0.95;
    const tilt = (-15 * Math.PI) / 180;
    const ox = 4.7 * Math.cos(a), oz = 4.7 * Math.sin(a);
    r.planet.position.set(ox * Math.cos(tilt) - 0.0, ox * Math.sin(tilt) * 0.0 + 0.6 * Math.sin(a + 0.4), oz);
    r.planet.visible = true;
    r.ring.lookAt(r.camera.position);
    (r.ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * clamp(r.uniforms.form.value * 1.4);

    const gl = r.renderer;
    gl.setRenderTarget(r.rt);
    gl.setClearColor(0x000000, 1);
    gl.clear();
    gl.render(r.scene, r.camera);
    gl.setRenderTarget(null);
    gl.render(r.postScene, r.postCam);
  });

  return <div ref={host} style={{ position: "absolute", inset: 0, width: w, height: h, background: "#050506" }} />;
}
