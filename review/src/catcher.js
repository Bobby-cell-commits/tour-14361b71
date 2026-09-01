// Contact-shadow catcher — ported from the rig proven in Session B
// (prototypes/viewer-base-playcanvas/index.html, research/2026-08-26-viewer-base-catcher.md).
//
// Two live-switchable modes:
//   'plane'  — the engine's documented splat-ground path: official ShadowCatcher material
//              (shadowCatcher=true, multiplicative blend, depthWrite off) with drawBucket 0
//              so it draws AFTER the splat in the transparent pass. Always-on-top over the
//              splat => reproduces the known through-wall artifact class (kept for A/B).
//   'screen' — GSplatRelighting-style screen-space compositing: a camera-matched offscreen
//              pass renders ONLY a floor proxy plane (y=0) with a shadowCatcher material
//              into RGBA16F — shadow transmittance in RGB, VIEW DEPTH in A (outputPS
//              override; the default outputPS chunk is an empty extension point, and
//              LIT_SHADOW_CATCHER writes RGB after it — both verified in 2.21.4 source) —
//              and a gsplatModifyPS chunk darkens only splat fragments whose own ray depth
//              (1/gl_FragCoord.w) matches the proxy depth. A wall in front of a shadowed
//              floor patch mismatches by metres => no through-wall leak.
//
// Chunk ownership: this module OWNS gsplatModifyPS — in BOTH language maps (the gsplat
// path picks GLSL or WGSL per device and never transpiles, so the twins are set/deleted
// in lockstep) — while mode === 'screen'. Any future splat-shader effect must compose
// through this seam, not set the chunk directly (the spike rig's tint/catcher collision
// is the failure mode this rule prevents).
//
// Black-splat trap: setting gsplatModifyPS before the splat's first RENDERED frame turns
// the splat black with no console error (.claude/rules/known-issues.md). The rig deferred
// by wall-clock (800 ms), which a background tab's throttled rAF can defeat; here the gate
// counts actual renders ('postrender' — NB 'frameend' fires even on skipped frames) and
// queues the mode flip until the material is warm.
import {
  Entity, StandardMaterial, Color, Layer, RenderTarget, Texture,
  ADDRESS_CLAMP_TO_EDGE, FILTER_LINEAR, GAMMA_NONE, PIXELFORMAT_RGBA16F,
  PIXELFORMAT_SRGBA8, TONEMAP_NONE, SHADERLANGUAGE_GLSL, SHADERLANGUAGE_WGSL,
  BLEND_MULTIPLICATIVE, SHADOW_PCSS_32F, LAYERID_WORLD,
} from 'playcanvas';

const SHADOW_CHUNK_GLSL = /* glsl */`
uniform sampler2D uShadowRT;
uniform vec4 uScreenSize;
uniform float uShadowStrength;
uniform float uShadowDepthTol;

void modifySplatColor(vec2 gaussianUV, inout vec4 color) {
    vec4 s = textureLod(uShadowRT, gl_FragCoord.xy * uScreenSize.zw, 0.0);
    // s.rgb = shadow transmittance on the proxy (1 = fully lit), s.a = proxy view depth
    // (0 = pixel not covered by the proxy — the offscreen target clears to 0)
    float splatDepth = 1.0 / gl_FragCoord.w;
    float match = (s.a > 0.0)
        ? (1.0 - smoothstep(uShadowDepthTol * 0.5, uShadowDepthTol, abs(splatDepth - s.a)))
        : 0.0;
    color.rgb *= mix(1.0, s.r, match * uShadowStrength);
}`;

// WGSL twin — the gsplat path hard-branches on device.isWebGPU when picking the chunk
// map and never transpiles a GLSL-only chunk (hybrid renderer: hard compile fail; quad
// renderer: silent no-op). WGSL constraints honored: 'match' is reserved (renamed m),
// no swizzle stores (reconstruct the vec4f), pcPosition is the processor-injected
// gl_FragCoord twin, the texture decl immediately followed by its sampler decl
// auto-pairs, uniforms are declared bare and referenced via uniform.<name>.
const SHADOW_CHUNK_WGSL = /* wgsl */`
var uShadowRT: texture_2d<f32>;
var uShadowRTSampler: sampler;
uniform uScreenSize: vec4f;
uniform uShadowStrength: f32;
uniform uShadowDepthTol: f32;
fn modifySplatColor(gaussianUV: vec2f, color: ptr<function, vec4f>) {
    let s: vec4f = textureSampleLevel(uShadowRT, uShadowRTSampler, pcPosition.xy * uniform.uScreenSize.zw, 0.0);
    let splatDepth: f32 = 1.0 / pcPosition.w;
    var m: f32 = 0.0;
    if (s.a > 0.0) {
        m = 1.0 - smoothstep(uniform.uShadowDepthTol * 0.5, uniform.uShadowDepthTol, abs(splatDepth - s.a));
    }
    let c: vec4f = *color;
    *color = vec4f(c.rgb * mix(vec3f(1.0), vec3f(s.r), m * uniform.uShadowStrength), c.a);
}`;

const WARM_RENDERS = 3;   // rendered frames before the chunk may land on the splat material
const SETTLE_RENDERS = 12; // frames pumped AFTER a chunk apply — the unified splat renders
                           // BLACK for several frames post-flip, and under render-on-demand
                           // (autoRender=false) nothing else pumps them, so the black state
                           // is PERMANENT on an idle page without this burst

export function createCatcher(app, camera, { requestRender = () => {}, floorSize = 12 } = {}) {
  const cfg = { mode: 'off', strength: 0.8, tol: 0.35, euler: [50, -100, 0], debugRT: false };

  // shared shadow-only directional light (intensity 0 per the official ShadowCatcher docs —
  // it then only casts shadows and never lights anything)
  const shadowSun = new Entity('shadow-sun');
  shadowSun.addComponent('light', {
    type: 'directional', color: new Color(1, 1, 1), intensity: 0, castShadows: true,
    shadowIntensity: 1.0, shadowResolution: 2048, shadowDistance: 25,
    shadowType: SHADOW_PCSS_32F, shadowBias: 0.1, normalOffsetBias: 0.05,
    penumbraSize: 0.06, penumbraFalloff: 4, shadowSamples: 16, shadowBlockerSamples: 16,
  });
  shadowSun.setEulerAngles(...cfg.euler);
  shadowSun.enabled = false;
  app.root.addChild(shadowSun);

  // mode 'plane': official ShadowCatcher idiom
  const planeCatcherMat = new StandardMaterial();
  planeCatcherMat.blendType = BLEND_MULTIPLICATIVE;
  planeCatcherMat.shadowCatcher = true;
  planeCatcherMat.useSkybox = false;
  planeCatcherMat.depthWrite = false;
  planeCatcherMat.diffuse.set(0, 0, 0);
  planeCatcherMat.specular.set(0, 0, 0);
  planeCatcherMat.update();
  const planeCatcher = new Entity('plane-catcher');
  planeCatcher.addComponent('render', { type: 'plane', castShadows: false, material: planeCatcherMat });
  planeCatcher.setLocalScale(floorSize, 1, floorSize);
  planeCatcher.enabled = false;
  app.root.addChild(planeCatcher);
  planeCatcher.render.meshInstances.forEach(mi => { mi.drawBucket = 0; });

  // mode 'screen': offscreen layer + proxy floor + camera-matched RT camera
  const shadowLayer = new Layer({ name: 'ShadowCatch' });
  app.scene.layers.push(shadowLayer);
  const proxyMat = new StandardMaterial();
  proxyMat.shadowCatcher = true;
  proxyMat.useSkybox = false;
  proxyMat.diffuse.set(0, 0, 0);
  proxyMat.specular.set(0, 0, 0);
  // keep transmittance in RGB (LIT_SHADOW_CATCHER writes it after outputPS), store linear
  // view depth in A as the coverage-cum-depth channel — the depth match key
  proxyMat.getShaderChunks(SHADERLANGUAGE_GLSL).set('outputPS', /* glsl */`
      gl_FragColor.a = 1.0 / gl_FragCoord.w;
  `);
  proxyMat.getShaderChunks(SHADERLANGUAGE_WGSL).set('outputPS', /* wgsl */`
      output.color.a = 1.0 / pcPosition.w;
  `);
  proxyMat.shaderChunksVersion = '2.8';
  proxyMat.update();
  const proxyFloor = new Entity('proxy-floor');
  proxyFloor.addComponent('render', { type: 'plane', castShadows: false, material: proxyMat });
  proxyFloor.setLocalScale(floorSize, 1, floorSize);
  proxyFloor.enabled = false;
  app.root.addChild(proxyFloor);
  proxyFloor.render.layers = [shadowLayer.id];

  const rtCam = new Entity('shadow-rt-cam');
  rtCam.addComponent('camera', {
    layers: [shadowLayer.id], priority: -1, clearColor: new Color(0, 0, 0, 0),
    fov: camera.camera.fov, nearClip: camera.camera.nearClip, farClip: camera.camera.farClip,
    toneMapping: TONEMAP_NONE, gammaCorrection: GAMMA_NONE,
  });
  rtCam.enabled = false;
  camera.addChild(rtCam);   // inherits the main camera's world transform

  let shadowTex = null, shadowRT = null;
  const rtFormat = app.graphicsDevice.getRenderableHdrFormat?.([PIXELFORMAT_RGBA16F], true) ?? PIXELFORMAT_SRGBA8;
  if (rtFormat !== PIXELFORMAT_RGBA16F) console.warn('[viewer] shadow RT fell back to SRGBA8 — depth-in-alpha degraded');
  if (app.graphicsDevice.isWebGPU && !app.graphicsDevice.textureFloatFilterable) console.warn('[viewer] adapter lacks float32-filterable — shadow RT sampling degrades to NEAREST (blocky depth match)');
  function updateShadowRT() {
    const d = app.graphicsDevice;
    const w = Math.max(1, Math.floor(d.width)), h = Math.max(1, Math.floor(d.height));
    if (shadowTex && shadowTex.width === w && shadowTex.height === h) return;
    shadowRT?.destroy(); shadowTex?.destroy();
    shadowTex = new Texture(d, {
      name: 'ShadowCatchTex', width: w, height: h, format: rtFormat, mipmaps: false,
      minFilter: FILTER_LINEAR, magFilter: FILTER_LINEAR,
      addressU: ADDRESS_CLAMP_TO_EDGE, addressV: ADDRESS_CLAMP_TO_EDGE,
    });
    shadowRT = new RenderTarget({ name: 'ShadowCatchRT', colorBuffer: shadowTex, depth: true });
    rtCam.camera.renderTarget = shadowRT;
  }

  // screen mode: casters are registered manually on the offscreen layer (addShadowCasters
  // requires mi.castShadow; entity disable does NOT auto-remove manual registrations).
  // Two slots so the legacy single-object path and the staging document can't clobber
  // each other: setCasterEntity owns the legacy slot, setCasters the placement list.
  // All casters accumulate into ONE registration on the single shadow map — a fragment
  // is binary in/out of shadow, so overlapping shadows cannot double-darken.
  let registered = [];
  let legacyCaster = null;
  let listCasters = [];
  function refreshCasters() {
    if (registered.length) { shadowLayer.removeShadowCasters(registered); registered = []; }
    for (const ent of [...listCasters, legacyCaster]) {
      if (!ent) continue;
      const renders = ent.findComponents('render');
      for (const r of renders) r.castShadows = true;
      if (cfg.mode === 'screen' && ent.enabled) {
        for (const r of renders) registered.push(...r.meshInstances);
      }
    }
    if (registered.length) shadowLayer.addShadowCasters(registered);
    requestRender();
  }
  function setCasterEntity(e) { legacyCaster = e; refreshCasters(); }
  function setCasters(list) { listCasters = (list ?? []).filter(Boolean); refreshCasters(); }

  // --- warm-frame gate for the gsplatModifyPS chunk ---
  let rendersSeen = 0, pendingMode = null, settleLeft = 0;
  app.on('postrender', () => {
    rendersSeen++;
    if (pendingMode !== null && rendersSeen >= WARM_RENDERS) {
      const m = pendingMode; pendingMode = null;
      applyMode(m);
    } else if (pendingMode !== null) {
      requestRender();   // keep frames coming until the material is warm
    } else if (settleLeft > 0) {
      settleLeft--; requestRender();   // post-flip settle burst (see SETTLE_RENDERS)
    }
  });

  function applyMode(mode) {
    cfg.mode = mode;
    const mat = app.scene.gsplat.material;
    const glsl = mat.getShaderChunks(SHADERLANGUAGE_GLSL);
    const wgsl = mat.getShaderChunks(SHADERLANGUAGE_WGSL);
    if (mode === 'screen') {
      const cur = glsl.get('gsplatModifyPS');
      if (cur && cur !== SHADOW_CHUNK_GLSL) console.warn('[viewer] gsplatModifyPS held by another owner — catcher overriding');
      glsl.set('gsplatModifyPS', SHADOW_CHUNK_GLSL);
      wgsl.set('gsplatModifyPS', SHADOW_CHUNK_WGSL);
    } else {
      glsl.delete('gsplatModifyPS');
      wgsl.delete('gsplatModifyPS');
    }
    mat.update();
    shadowSun.enabled = mode !== 'off';
    shadowSun.light.layers = mode === 'screen' ? [shadowLayer.id] : [LAYERID_WORLD];
    shadowSun.light.shadowIntensity = mode === 'plane' ? 0.8 : 1.0;
    planeCatcher.enabled = mode === 'plane';
    proxyFloor.enabled = mode === 'screen';
    if (mode === 'screen') updateShadowRT();
    rtCam.enabled = mode === 'screen';
    refreshCasters();
    // hidden tabs' rAF is throttled — force-settle real frames so a mode flip doesn't
    // read as ~10 s of black splat when screenshotting from a background tab
    if (document.hidden) for (let i = 0; i < 3; i++) { app.update(1 / 60); app.render(); }
    settleLeft = SETTLE_RENDERS;   // visible tabs settle via rAF-paced postrender pumps
    requestRender();
    console.log('[viewer] shadow', JSON.stringify({ ...cfg, pending: pendingMode }));
  }

  function setMode(mode) {
    if (!['off', 'plane', 'screen'].includes(mode)) return;
    if (mode === cfg.mode && pendingMode === null) return;
    if (rendersSeen < WARM_RENDERS) { pendingMode = mode; requestRender(); return; }
    pendingMode = null;
    applyMode(mode);
  }

  // sun DIRECTION only — opacity/strength is a separate concern (the rig's setLighting
  // mutated the shared shadowCfg; this seam is why that coupling is gone)
  function setSun(o = {}) {
    if (o.euler) shadowSun.setEulerAngles(...o.euler);
    else if (o.position && o.lookAt) { shadowSun.setPosition(...o.position); shadowSun.lookAt(...o.lookAt); }
    const e = shadowSun.getEulerAngles();
    cfg.euler = [e.x, e.y, e.z].map(v => +v.toFixed(1));
    requestRender();
  }

  function set(o = {}) {
    if (typeof o === 'string') o = { mode: o };
    if (o.strength !== undefined) cfg.strength = o.strength;
    if (o.tol !== undefined) cfg.tol = o.tol;
    if (o.debugRT !== undefined) cfg.debugRT = o.debugRT;
    if (o.euler) setSun({ euler: o.euler });
    if (o.penumbra !== undefined) shadowSun.light.penumbraSize = o.penumbra;
    if (o.intensity !== undefined) shadowSun.light.shadowIntensity = o.intensity;
    if (o.mode !== undefined) setMode(o.mode);
    requestRender();
  }

  // per-frame: push params into the splat material (official re-dirty idiom) + debug RT
  function update() {
    if (cfg.mode !== 'screen') return;
    updateShadowRT();
    const mat = app.scene.gsplat.material;
    if (shadowTex) {
      mat.setParameter('uShadowRT', shadowTex);
      mat.setParameter('uShadowStrength', cfg.strength);
      mat.setParameter('uShadowDepthTol', cfg.tol);
      mat.update();   // re-dirty so params reach the renderer's material copy
    }
    if (cfg.debugRT && shadowTex) app.drawTexture(0.6, -0.6, 0.7, 0.7, shadowTex);
  }

  function state() {
    return {
      ...cfg, pending: pendingMode, casters: registered.length,
      rt: shadowTex ? [shadowTex.width, shadowTex.height] : null,
    };
  }

  return { set, setMode, setSun, setCasterEntity, setCasters, refreshCasters, update, state };
}
