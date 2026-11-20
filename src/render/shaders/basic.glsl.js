// Skyburn Phase 4 graphics pass - GLSL ES 3.00 shaders as strings (PRD: /src/render/shaders/).
// All shaders are original. Art direction lock (stylized realistic): deep sky blue zenith ->
// light blue-white horizon, warm sun, white clouds, dark slate terrain, orange explosions.
// Fog is exp2-style, tuned for multi-km view distances, and always targets the horizon color.
// Every surface passes through the same ACES-fit tone map + slight saturation so the horizon
// seam between sky and fogged terrain stays invisible.

// ---- shared fragment grading: simple ACES fit + gentle saturation (applied last) ----
const GRADE_GLSL = `
vec3 sbGrade(vec3 col) {
  col *= 1.15;                                   // exposure before the film curve
  col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  return mix(vec3(lum), col, 1.10);              // slight saturation boost
}`;

export const TERRAIN_VS = `#version 300 es
precision highp float;
in vec3 aPos;
in vec3 aNormal;
in vec3 aColor;
uniform mat4 uViewProj;
out vec3 vNormal;
out vec3 vColor;
out vec3 vWorld;
void main() {
  vNormal = aNormal;
  vColor = aColor;
  vWorld = aPos;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

export const TERRAIN_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vColor;
in vec3 vWorld;
uniform vec3 uSunDir;
uniform vec3 uCamPos;
uniform vec3 uFogColor;
out vec4 frag;
${GRADE_GLSL}
void main() {
  vec3 n = normalize(vNormal);
  float diff = max(dot(n, uSunDir), 0.0);
  // Same directional sun as every object: warm sunlight + cool blue sky ambient (no flat white).
  vec3 sun = vec3(1.06, 0.99, 0.88);
  vec3 skyAmb = vec3(0.30, 0.36, 0.46);
  vec3 col = vColor * (skyAmb + sun * diff);
  float d = length(vWorld - uCamPos);
  float fog = 1.0 - exp(-d * d * 6e-9);
  frag = vec4(sbGrade(mix(col, uFogColor, fog)), 1.0);
}`;

export const OCEAN_VS = `#version 300 es
precision highp float;
in vec3 aPos;
uniform mat4 uViewProj;
uniform float uTime;
out vec3 vWorld;
out vec3 vNormal;
// Procedural Gerstner-ish sine waves. Height h(x,z,t) and analytic gradient g(x,z,t).
// 3 crossing wave trains, total amplitude ~2.1 m.
void main() {
  vec2 p = aPos.xz;
  float a = p.x * 0.012 + uTime * 1.10;
  float b = dot(p, vec2(0.009, 0.011)) - uTime * 0.90;
  float c = dot(p, vec2(-0.017, 0.006)) + uTime * 1.70;
  float h = sin(a) * 0.9 + sin(b) * 0.7 + sin(c) * 0.5;
  vec2 g = cos(a) * 0.9 * 0.012 * vec2(1.0, 0.0)
         + cos(b) * 0.7 * vec2(0.009, 0.011)
         + cos(c) * 0.5 * vec2(-0.017, 0.006);
  vec3 pos = vec3(aPos.x, aPos.y + h, aPos.z);
  vNormal = normalize(vec3(-g.x, 1.0, -g.y));
  vWorld = pos;
  gl_Position = uViewProj * vec4(pos, 1.0);
}`;

export const OCEAN_FS = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
uniform vec3 uSunDir;
uniform vec3 uCamPos;
uniform vec3 uFogColor;
out vec4 frag;
${GRADE_GLSL}
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uCamPos - vWorld);
  float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  vec3 deep = vec3(0.012, 0.080, 0.160);
  vec3 shallow = vec3(0.040, 0.200, 0.300);
  vec3 col = mix(deep, shallow, fres * 0.65);
  // Sun specular reflection: tight glitter core + broad warm path (art direction #7).
  vec3 hv = normalize(uSunDir + v);
  float specT = pow(max(dot(n, hv), 0.0), 260.0);
  float specB = pow(max(dot(n, hv), 0.0), 28.0) * 0.10;
  col += vec3(1.0, 0.93, 0.78) * (specT * 1.6 + specB);
  float d = length(vWorld - uCamPos);
  float fog = 1.0 - exp(-d * d * 6e-9);
  frag = vec4(sbGrade(mix(col, uFogColor, fog)), 1.0);
}`;

export const JET_VS = `#version 300 es
precision highp float;
in vec3 aPos;
in vec3 aNormal;
in vec3 aColor;
uniform mat4 uViewProj;
uniform mat4 uModel;
out vec3 vNormal;
out vec3 vColor;
out vec3 vWorld;
void main() {
  vec4 wp = uModel * vec4(aPos, 1.0);
  vWorld = wp.xyz;
  vNormal = mat3(uModel) * aNormal;
  vColor = aColor;
  gl_Position = uViewProj * wp;
}`;

export const JET_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vColor;
in vec3 vWorld;
uniform vec3 uSunDir;
uniform vec3 uCamPos;
uniform vec3 uFogColor;
uniform float uEmissive;   // graphics pass: unlit boost (missiles draw bright orange); default 0
out vec4 frag;
${GRADE_GLSL}
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uCamPos - vWorld);
  float diff = max(dot(n, uSunDir), 0.0);
  // cool ambient from sky, warm from sun
  vec3 amb = vColor * vec3(0.18, 0.22, 0.30);
  vec3 col = amb + vColor * diff * vec3(1.06, 1.0, 0.90);
  // Blinn-Phong sun highlight (subtle, keeps the Phase 3B look)
  vec3 hv = normalize(uSunDir + v);
  float spec = pow(max(dot(n, hv), 0.0), 48.0) * 0.30 * diff;
  col += vec3(1.0, 0.97, 0.90) * spec;
  // readability rule #1: darken the silhouette rim so jets read against sky AND ground
  float rim = pow(1.0 - max(dot(n, v), 0.0), 2.5);
  col *= 1.0 - 0.30 * rim;
  col += vColor * uEmissive;   // bright (unlit) bodies: guided missiles
  float d = length(vWorld - uCamPos);
  float fog = 1.0 - exp(-d * d * 6e-9);
  frag = vec4(sbGrade(mix(col, uFogColor, fog)), 1.0);
}`;

export const SKY_VS = `#version 300 es
precision highp float;
// Fullscreen triangle from gl_VertexID, no vertex buffers needed (WebGL2).
out vec2 vNdc;
const vec2 K[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() {
  vNdc = K[gl_VertexID];
  gl_Position = vec4(K[gl_VertexID], 1.0, 1.0);
}`;

export const SKY_FS = `#version 300 es
precision highp float;
in vec2 vNdc;
uniform mat4 uInvVP;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uZenith;    // Phase 3B: per-map sky gradient (maps.json atmosphere)
uniform vec3 uHorizon;
uniform float uTime;     // Phase 4 (Task 4.5): cloud drift
out vec4 frag;
${GRADE_GLSL}
// cheap 2D value noise (original) - cloud shapes only, no texture fetches
float hash12(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
void main() {
  vec4 pw = uInvVP * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(pw.xyz / pw.w - uCamPos);
  float up = clamp(dir.y * 1.7 + 0.12, 0.0, 1.0);
  vec3 col = mix(uHorizon, uZenith, pow(up, 0.9));
  float s = dot(dir, uSunDir);
  // warm yellow sun: broad halo + tight disc
  float glow = pow(max(s, 0.0), 200.0) * 0.50;
  float disc = smoothstep(0.99958, 0.99988, s);
  col += vec3(1.0, 0.86, 0.55) * glow;
  col = mix(col, vec3(1.0, 0.97, 0.86), disc);
  // High-altitude wisp layer only - the main cumulus clouds are instanced billboards
  // (renderer cloud pass). Ray-projected onto a virtual plane 1800 m up, drifting eastward.
  if (dir.y > 0.02) {
    vec2 cp = uCamPos.xz * 0.00055 + dir.xz / dir.y * 0.33;
    cp.x += uTime * 0.004;
    float n = vnoise(cp * 2.1) * 0.55 + vnoise(cp * 4.7 + 11.3) * 0.30
            + vnoise(cp * 9.3 + 27.7) * 0.15;
    float cov = smoothstep(0.66, 0.82, n) * smoothstep(0.02, 0.18, dir.y);
    float lit = 0.55 + 0.45 * clamp(s * 0.5 + 0.5, 0.0, 1.0);
    vec3 cloudCol = mix(vec3(0.66, 0.70, 0.78), vec3(1.0, 0.99, 0.96), lit);
    col = mix(col, cloudCol, cov * 0.55);
  }
  frag = vec4(sbGrade(col), 1.0);
}`;

// ---- Phase 1: GPU particles (gl.POINTS round sprites) + tracer lines ----

export const PARTICLE_VS = `#version 300 es
precision highp float;
in vec3 aPos;
in float aSize;
in vec3 aColor;
in float aAlpha;
uniform mat4 uViewProj;
uniform float uPointScale;   // viewport height / 2 / tan(fov/2)
out vec3 vColor;
out float vAlpha;
void main() {
  vec4 clip = uViewProj * vec4(aPos, 1.0);
  gl_Position = clip;
  float w = max(clip.w, 0.1);
  gl_PointSize = clamp(aSize * uPointScale / w, 1.0, 220.0);
  vColor = aColor;
  vAlpha = aAlpha;
}`;

export const PARTICLE_FS = `#version 300 es
precision highp float;
in vec3 vColor;
in float vAlpha;
uniform float uSoft;   // 1.0 = soft smoke disc, 0.0 = hard bright core
out vec4 frag;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d) * 4.0;              // 0 center -> 1 at edge
  if (r2 > 1.0) discard;
  float soft = mix(1.0, 1.0 - smoothstep(0.15, 1.0, r2), uSoft);
  frag = vec4(vColor, vAlpha * soft);
}`;

export const LINE_VS = `#version 300 es
precision highp float;
in vec3 aPos;
in vec4 aColor;   // rgb + alpha (tracers fade along the segment)
uniform mat4 uViewProj;
out vec4 vColor;
void main() {
  gl_Position = uViewProj * vec4(aPos, 1.0);
  vColor = aColor;
}`;

export const LINE_FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 frag;
void main() {
  frag = vColor;
}`;

// ---- Graphics pass: instanced cloud billboards (30-50 soft white sprites, one draw) ----
// Four corners come from gl_VertexID (no per-vertex buffer); per-instance data arrives via
// divisor-1 attributes: [center xyz (3f), size (1f), seed (1f)] stride 20 bytes.

export const CLOUD_VS = `#version 300 es
precision highp float;
in vec3 aInstPos;    // instance center (world m)
in float aInstSize;  // billboard radius (m)
in float aInstSeed;  // per-instance variation [0,1)
uniform mat4 uViewProj;
uniform vec3 uRight; // camera right (billboard axis 1)
uniform vec3 uUp;    // camera up (billboard axis 2)
out vec2 vUV;
out vec3 vWorld;
out float vSeed;
const vec2 C[4] = vec2[4](vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0), vec2(1.0, 1.0));
void main() {
  vec2 c = C[gl_VertexID];
  vec3 world = aInstPos + (uRight * c.x + uUp * c.y) * aInstSize;
  vUV = c;
  vWorld = world;
  vSeed = aInstSeed;
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

export const CLOUD_FS = `#version 300 es
precision highp float;
in vec2 vUV;
in vec3 vWorld;
in float vSeed;
uniform vec3 uCamPos;
uniform vec3 uFogColor;
out vec4 frag;
${GRADE_GLSL}
void main() {
  float r = length(vUV);
  if (r > 1.0) discard;
  // soft two-lobe falloff with per-instance irregularity -> puffy, not flat discs
  float a = 1.0 - smoothstep(0.30, 1.0, r);
  a *= 0.72 + 0.28 * vSeed;
  // top-lit shading toward the sun side, slightly warm white (art direction: white clouds)
  float lit = 0.5 + 0.5 * vUV.y;
  vec3 col = mix(vec3(0.78, 0.82, 0.89), vec3(1.05, 1.03, 0.99), lit);
  // fade into the horizon color with distance (same fog as every surface)
  float d = length(vWorld - uCamPos);
  float fog = 1.0 - exp(-d * d * 6e-9);
  a *= clamp(1.0 - fog * 1.6, 0.0, 1.0);
  col = mix(col, uFogColor, fog);
  frag = vec4(sbGrade(col), a * 0.85);
}`;

// ---- Graphics pass: silhouette outline (inverted hull) for jets / ground targets ----
// Pairs with JET_VS: main.js scales the model matrix ~4.5% about the entity origin, the
// renderer culls front faces and blends this dark shell around the silhouette. Fades out
// with the shared fog so distant outlines melt into the haze instead of floating.

export const OUTLINE_FS = `#version 300 es
precision highp float;
in vec3 vWorld;   // from JET_VS (vNormal/vColor intentionally unconsumed)
uniform vec3 uCamPos;
uniform vec3 uFogColor;
out vec4 frag;
void main() {
  float d = length(vWorld - uCamPos);
  float fog = 1.0 - exp(-d * d * 6e-9);
  vec3 dark = vec3(0.045, 0.075, 0.115);   // dark slate edge (readability rule #1)
  frag = vec4(mix(dark, uFogColor, fog), 0.85 * (1.0 - fog));
}`;
