// Skyburn Phase 0 - GLSL ES 3.00 shaders as strings (PRD: /src/render/shaders/ - GLSL as strings).
// All shaders are original. Sky gradient + sun disc, heightmap terrain, procedural ocean waves,
// Lambert jet material. Fog shared: exp2-style, tuned for multi-km view distances.

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
void main() {
  vec3 n = normalize(vNormal);
  float diff = max(dot(n, uSunDir), 0.0);
  vec3 col = vColor * (0.34 + 0.78 * diff);
  float d = length(vWorld - uCamPos);
  float fog = 1.0 - exp(-d * d * 6e-9);
  frag = vec4(mix(col, uFogColor, fog), 1.0);
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
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uCamPos - vWorld);
  float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  vec3 deep = vec3(0.016, 0.086, 0.150);
  vec3 shallow = vec3(0.05, 0.22, 0.30);
  vec3 col = mix(deep, shallow, fres * 0.65);
  vec3 hv = normalize(uSunDir + v);
  float spec = pow(max(dot(n, hv), 0.0), 220.0);
  col += vec3(1.0, 0.95, 0.82) * spec * 1.4;
  float d = length(vWorld - uCamPos);
  float fog = 1.0 - exp(-d * d * 6e-9);
  frag = vec4(mix(col, uFogColor, fog), 1.0);
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
out vec4 frag;
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uCamPos - vWorld);
  float diff = max(dot(n, uSunDir), 0.0);
  // cool ambient from sky, warm from sun
  vec3 amb = vColor * vec3(0.16, 0.20, 0.27);
  vec3 col = amb + vColor * diff * vec3(1.05, 1.0, 0.92);
  // Phase 4 (Task 4.5 polish): Blinn-Phong sun highlight + rim light + tonemap.
  // Kept subtle so the Phase 3B look is preserved (deferred polish, not a new feature).
  vec3 hv = normalize(uSunDir + v);
  float spec = pow(max(dot(n, hv), 0.0), 48.0) * 0.30 * diff;
  col += vec3(1.0, 0.97, 0.90) * spec;
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  col += vec3(0.42, 0.56, 0.80) * rim * 0.16;
  // gentle filmic curve + gamma-ish contrast: keeps highlights from clipping hard
  col = col * (1.0 + col * 0.15) / (1.0 + col * 0.35);
  float d = length(vWorld - uCamPos);
  float fog = 1.0 - exp(-d * d * 6e-9);
  frag = vec4(mix(col, uFogColor, fog), 1.0);
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
  float up = clamp(dir.y * 1.6 + 0.10, 0.0, 1.0);
  vec3 col = mix(uHorizon, uZenith, up);
  float s = dot(dir, uSunDir);
  float glow = pow(max(s, 0.0), 320.0) * 0.55;
  float disc = smoothstep(0.99955, 0.99988, s);
  col += vec3(1.0, 0.92, 0.75) * glow;
  col = mix(col, vec3(1.0, 0.97, 0.88), disc);
  // Phase 4 (Task 4.5): procedural cloud layer (the polish deferred from Phase 3B).
  // Ray-projected onto a virtual plane 1800 m up: billboard-soft cumulus shapes from
  // 3 octaves of value noise drifting slowly eastward. Fades out at the horizon.
  if (dir.y > 0.015) {
    vec2 cp = uCamPos.xz * 0.00055 + dir.xz / dir.y * 0.33;
    cp.x += uTime * 0.004;
    float n = vnoise(cp * 2.1) * 0.55 + vnoise(cp * 4.7 + 11.3) * 0.30
            + vnoise(cp * 9.3 + 27.7) * 0.15;
    float cov = smoothstep(0.58, 0.78, n) * smoothstep(0.015, 0.16, dir.y);
    float lit = 0.55 + 0.45 * clamp(s * 0.5 + 0.5, 0.0, 1.0);
    vec3 cloudCol = mix(vec3(0.62, 0.66, 0.74), vec3(1.0, 0.99, 0.96), lit);
    col = mix(col, cloudCol, cov * 0.85);
  }
  frag = vec4(col, 1.0);
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
