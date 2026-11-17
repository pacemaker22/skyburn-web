// Skyburn Phase 0 - Renderer (Task 0.4): raw WebGL2, no library. Perspective + view matrices,
// resize with devicePixelRatio scaling and dynamic resolution scale. Geometry is uploaded once
// at init; the frame path only binds and draws (zero allocation).

import {
  TERRAIN_VS, TERRAIN_FS, OCEAN_VS, OCEAN_FS, JET_VS, JET_FS, SKY_VS, SKY_FS,
  PARTICLE_VS, PARTICLE_FS, LINE_VS, LINE_FS,
} from './shaders/basic.glsl.js';

// ---- Column-major mat4 helpers (exported for unit tests; all out-param, no allocation) ----

export function mat4Identity(out) {
  out.fill(0);
  out[0] = 1; out[5] = 1; out[10] = 1; out[15] = 1;
  return out;
}

export function mat4Multiply(out, a, b) {
  // out = a * b (column-major)
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

export function mat4Perspective(out, fovyRad, aspect, near, far) {
  const f = 1 / Math.tan(fovyRad / 2);
  const nf = 1 / (near - far);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

export function mat4LookAt(out, ex, ey, ez, cx, cy, cz, ux, uy, uz) {
  let zx = ex - cx, zy = ey - cy, zz = ez - cz;
  let len = Math.sqrt(zx * zx + zy * zy + zz * zz) || 1;
  zx /= len; zy /= len; zz /= len;
  let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
  len = Math.sqrt(xx * xx + xy * xy + xz * xz) || 1;
  xx /= len; xy /= len; xz /= len;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * ex + xy * ey + xz * ez);
  out[13] = -(yx * ex + yy * ey + yz * ez);
  out[14] = -(zx * ex + zy * ey + zz * ez);
  out[15] = 1;
  return out;
}

export function mat4Invert(out, m) {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (det === 0) { out.fill(0); return out; }
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

// Model matrix from yaw/pitch/roll (radians) + translation. Yaw about Y, pitch about X, roll about Z.
export function mat4FromYPR(out, yaw, pitch, roll, x, y, z) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  // R = Ry(yaw) * Rx(pitch) * Rz(roll)
  const m00 = cy * cr + sy * sp * sr;
  const m01 = -cy * sr + sy * sp * cr;
  const m02 = sy * cp;
  const m10 = cp * sr;
  const m11 = cp * cr;
  const m12 = -sp;
  const m20 = -sy * cr + cy * sp * sr;
  const m21 = sy * sr + cy * sp * cr;
  const m22 = cy * cp;
  out[0] = m00; out[1] = m10; out[2] = m20; out[3] = 0;
  out[4] = m01; out[5] = m11; out[6] = m21; out[7] = 0;
  out[8] = m02; out[9] = m12; out[10] = m22; out[11] = 0;
  out[12] = x; out[13] = y; out[14] = z; out[15] = 1;
  // normalize -0 to 0 for bitwise-stable state (deterministic replay, Object.is equality)
  for (let i = 0; i < 16; i++) {
    if (out[i] === 0) out[i] = 0;
  }
  return out;
}

// ---- Renderer ----

const FOG_COLOR = new Float32Array([0.76, 0.84, 0.90]);
const SUN_DIR = new Float32Array([0.42, 0.55, -0.72]); // normalized below

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      depth: true,
      powerPreference: 'high-performance',
    });
    if (!gl) {
      const err = new Error('WebGL2 not supported - Skyburn requires WebGL2.');
      err.userFacing = true;
      throw err;
    }
    this.gl = gl;
    this.canvas = canvas;
    this.renderScale = 1;          // dynamic resolution scale (PRD Task 0.4)
    this.dpr = 1;
    this.drawCalls = 0;
    this.triangles = 0;

    this._progTerrain = this._compile(TERRAIN_VS, TERRAIN_FS);
    this._progOcean = this._compile(OCEAN_VS, OCEAN_FS);
    this._progJet = this._compile(JET_VS, JET_FS);
    this._progSky = this._compile(SKY_VS, SKY_FS);
    this._progParticles = this._compile(PARTICLE_VS, PARTICLE_FS); // Phase 1
    this._progLine = this._compile(LINE_VS, LINE_FS);              // Phase 1 (tracers)

    // normalize sun dir
    const s = SUN_DIR;
    const l = Math.sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]);
    s[0] /= l; s[1] /= l; s[2] /= l;

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE); // Phase 0: procedural meshes, keep both faces (cheap at this scale)

    // preallocated matrices
    this._view = new Float32Array(16);
    this._proj = new Float32Array(16);
    this._viewProj = new Float32Array(16);
    this._invVP = new Float32Array(16);
    this._model = new Float32Array(16);

    // empty VAO for the fullscreen sky triangle (gl_VertexID drives it)
    this._emptyVao = gl.createVertexArray();

    this._terrain = null; // {vao, idxCount}
    this._ocean = null;
    this._jetLodSets = null; // Phase 3A: [ [lod0, lod1, lod2] per shape family ]
    this._carrier = null; // Phase 1: {vao, idxCount}
    this._particles = null; // Phase 1: {vao, vbo, max}
    this._lines = null;     // Phase 1: {vao, vbo, maxVerts}
  }

  _compile(vsSrc, fsSrc) {
    const gl = this.gl;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSrc);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      throw new Error('Vertex shader error: ' + gl.getShaderInfoLog(vs));
    }
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSrc);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      throw new Error('Fragment shader error: ' + gl.getShaderInfoLog(fs));
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Program link error: ' + gl.getProgramInfoLog(prog));
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return { prog, u: this._uniforms(prog) };
  }

  _uniforms(prog) {
    const gl = this.gl;
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    const u = {};
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i);
      u[info.name] = gl.getUniformLocation(prog, info.name);
    }
    return u;
  }

  // Upload interleaved geometry: pos(3)+normal(3)+color(3), stride 36 bytes. Indices Uint32/Uint16.
  _uploadInterleaved(verts, idx, idxFmt, strideFloats) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const strideB = strideFloats * 4;
    gl.enableVertexAttribArray(0); // aPos
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, strideB, 0);
    gl.enableVertexAttribArray(1); // aNormal
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, strideB, 12);
    gl.enableVertexAttribArray(2); // aColor
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, strideB, 24);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, idxCount: idx.length, ibo, vbo };
  }

  // Upload position-only geometry (ocean): pos(3), stride 12 bytes.
  _uploadPositions(verts, idx) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, idxCount: idx.length, ibo, vbo };
  }

  setTerrain(mesh) { this._terrain = this._uploadInterleaved(mesh.verts, mesh.idx, this.gl.UNSIGNED_INT, mesh.stride); }
  setOcean(mesh) { this._ocean = this._uploadPositions(mesh.verts, mesh.idx); }
  // Phase 3A: jet LOD sets keyed by ents.variant (one set per shape family).
  // sets = [ [lod0, lod1, lod2] per shape ]; scene.jetKind[i] selects the set.
  setJetLodSets(sets) {
    this._jetLodSets = sets.map((set) => set.map(
      (m) => this._uploadInterleaved(m.verts, m.idx, this.gl.UNSIGNED_SHORT, m.stride)));
  }
  // Phase 0/1 single-set API kept as a wrapper (set 0).
  setJetLods(meshes) { this.setJetLodSets([meshes]); }

  // Phase 1: static carrier mesh (same interleaved layout as jets).
  setCarrier(mesh) {
    this._carrier = this._uploadInterleaved(mesh.verts, mesh.idx, this.gl.UNSIGNED_SHORT, mesh.stride);
  }

  // Phase 2: ship meshes by variant index [0]=missile boat (ents.variant 2), [1]=oil rig (3).
  setShipMeshes(meshes) {
    this._shipMeshes = meshes.map(
      (m) => this._uploadInterleaved(m.verts, m.idx, this.gl.UNSIGNED_SHORT, m.stride));
  }

  // Phase 2: one shared ground-unit mesh (SAM / hangar / radar silhouettes).
  setGroundMesh(mesh) {
    this._ground = this._uploadInterleaved(mesh.verts, mesh.idx, this.gl.UNSIGNED_SHORT, mesh.stride);
  }

  // Phase 1: particle pool binding - one dynamic VBO holding the system's staging layout
  // [x,y,z,size,r,g,b,alpha] (8 floats/point). Updated per frame with bufferSubData(srcOffset,
  // length) - no view allocation, no re-upload of unused tail.
  setParticles(ps) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, ps.staging.byteLength, gl.DYNAMIC_DRAW);
    const strideB = 32;
    gl.enableVertexAttribArray(0); // aPos
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, strideB, 0);
    gl.enableVertexAttribArray(1); // aSize
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, strideB, 12);
    gl.enableVertexAttribArray(2); // aColor
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, strideB, 16);
    gl.enableVertexAttribArray(3); // aAlpha
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, strideB, 28);
    gl.bindVertexArray(null);
    this._particles = { vao, vbo, max: ps.max, sys: ps };
  }

  // Phase 1: tracer line pool capacity (7 floats per vertex: x,y,z,r,g,b,a).
  setLineCapacity(maxVerts) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, maxVerts * 7 * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); // aPos
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1); // aColor
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
    gl.bindVertexArray(null);
    this._lines = { vao, vbo, maxVerts };
  }

  // Resize handling with devicePixelRatio scaling + dynamic resolution (PRD Task 0.4).
  resize(cssWidth, cssHeight, dpr) {
    this.dpr = dpr || (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
    const w = Math.max(1, Math.floor(cssWidth * this.dpr * this.renderScale));
    const h = Math.max(1, Math.floor(cssHeight * this.dpr * this.renderScale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
    this._aspect = w / h;
  }

  setRenderScale(s) {
    this.renderScale = Math.min(1, Math.max(0.4, s));
  }

  // One frame: sky -> terrain -> ocean -> carrier -> jets -> particles -> tracers.
  // scene = preallocated view: { jetCount, jetPos F32(3N), jetRot F32(3N), jetDist F32(N),
  // carrierX, carrierY, carrierZ, carrierYaw }. Matrices/flows as Phase 0 (no allocation here).
  drawFrame(camPos, camTarget, fovyRad, scene, timeSec) {
    const gl = this.gl;
    this.drawCalls = 0;
    this.triangles = 0;

    mat4LookAt(this._view, camPos[0], camPos[1], camPos[2], camTarget[0], camTarget[1], camTarget[2], 0, 1, 0);
    mat4Perspective(this._proj, fovyRad, this._aspect || 1, 2, 50000);
    mat4Multiply(this._viewProj, this._proj, this._view);
    mat4Invert(this._invVP, this._viewProj);

    gl.clearColor(FOG_COLOR[0], FOG_COLOR[1], FOG_COLOR[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // --- sky (fullscreen triangle, no depth) ---
    gl.disable(gl.DEPTH_TEST);
    const sky = this._progSky;
    gl.useProgram(sky.prog);
    gl.bindVertexArray(this._emptyVao);
    gl.uniformMatrix4fv(sky.u.uInvVP, false, this._invVP);
    gl.uniform3f(sky.u.uCamPos, camPos[0], camPos[1], camPos[2]);
    gl.uniform3f(sky.u.uSunDir, SUN_DIR[0], SUN_DIR[1], SUN_DIR[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    this.drawCalls++;

    // --- terrain ---
    if (this._terrain) {
      const t = this._progTerrain;
      gl.useProgram(t.prog);
      gl.bindVertexArray(this._terrain.vao);
      gl.uniformMatrix4fv(t.u.uViewProj, false, this._viewProj);
      gl.uniform3f(t.u.uSunDir, SUN_DIR[0], SUN_DIR[1], SUN_DIR[2]);
      gl.uniform3f(t.u.uCamPos, camPos[0], camPos[1], camPos[2]);
      gl.uniform3f(t.u.uFogColor, FOG_COLOR[0], FOG_COLOR[1], FOG_COLOR[2]);
      gl.drawElements(gl.TRIANGLES, this._terrain.idxCount, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
      this.drawCalls++;
      this.triangles += this._terrain.idxCount / 3;
    }

    // --- ocean ---
    if (this._ocean) {
      const o = this._progOcean;
      gl.useProgram(o.prog);
      gl.bindVertexArray(this._ocean.vao);
      gl.uniformMatrix4fv(o.u.uViewProj, false, this._viewProj);
      gl.uniform1f(o.u.uTime, timeSec);
      gl.uniform3f(o.u.uSunDir, SUN_DIR[0], SUN_DIR[1], SUN_DIR[2]);
      gl.uniform3f(o.u.uCamPos, camPos[0], camPos[1], camPos[2]);
      gl.uniform3f(o.u.uFogColor, FOG_COLOR[0], FOG_COLOR[1], FOG_COLOR[2]);
      gl.drawElements(gl.TRIANGLES, this._ocean.idxCount, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
      this.drawCalls++;
      this.triangles += this._ocean.idxCount / 3;
    }

    // --- carrier Nemesis (Task 1.7): yaw-only model matrix, drawn with the jet program ---
    if (this._carrier) {
      mat4FromYPR(this._model, scene.carrierYaw, 0, 0, scene.carrierX, scene.carrierY, scene.carrierZ);
      const j = this._progJet;
      gl.useProgram(j.prog);
      gl.bindVertexArray(this._carrier.vao);
      gl.uniformMatrix4fv(j.u.uViewProj, false, this._viewProj);
      gl.uniformMatrix4fv(j.u.uModel, false, this._model);
      gl.uniform3f(j.u.uSunDir, SUN_DIR[0], SUN_DIR[1], SUN_DIR[2]);
      gl.uniform3f(j.u.uCamPos, camPos[0], camPos[1], camPos[2]);
      gl.uniform3f(j.u.uFogColor, FOG_COLOR[0], FOG_COLOR[1], FOG_COLOR[2]);
      gl.drawElements(gl.TRIANGLES, this._carrier.idxCount, gl.UNSIGNED_SHORT, 0);
      gl.bindVertexArray(null);
      this.drawCalls++;
      this.triangles += this._carrier.idxCount / 3;
    }

    // --- Phase 2: ships (boats, rig) and ground units, drawn with the jet program ---
    if (this._shipMeshes && scene.shipCount > 0) {
      const j = this._progJet;
      gl.useProgram(j.prog);
      for (let i = 0; i < scene.shipCount; i++) {
        const mesh = this._shipMeshes[scene.shipKind[i]] || this._shipMeshes[0];
        mat4FromYPR(this._model, scene.shipRot[i], 0, 0,
          scene.shipPos[i * 3], scene.shipPos[i * 3 + 1], scene.shipPos[i * 3 + 2]);
        gl.bindVertexArray(mesh.vao);
        gl.uniformMatrix4fv(j.u.uViewProj, false, this._viewProj);
        gl.uniformMatrix4fv(j.u.uModel, false, this._model);
        gl.uniform3f(j.u.uSunDir, SUN_DIR[0], SUN_DIR[1], SUN_DIR[2]);
        gl.uniform3f(j.u.uCamPos, camPos[0], camPos[1], camPos[2]);
        gl.uniform3f(j.u.uFogColor, FOG_COLOR[0], FOG_COLOR[1], FOG_COLOR[2]);
        gl.drawElements(gl.TRIANGLES, mesh.idxCount, gl.UNSIGNED_SHORT, 0);
        this.drawCalls++;
        this.triangles += mesh.idxCount / 3;
      }
      gl.bindVertexArray(null);
    }
    if (this._ground && scene.groundCount > 0) {
      const j = this._progJet;
      gl.useProgram(j.prog);
      for (let i = 0; i < scene.groundCount; i++) {
        mat4FromYPR(this._model, scene.groundRot[i], 0, 0,
          scene.groundPos[i * 3], scene.groundPos[i * 3 + 1], scene.groundPos[i * 3 + 2]);
        gl.bindVertexArray(this._ground.vao);
        gl.uniformMatrix4fv(j.u.uViewProj, false, this._viewProj);
        gl.uniformMatrix4fv(j.u.uModel, false, this._model);
        gl.uniform3f(j.u.uSunDir, SUN_DIR[0], SUN_DIR[1], SUN_DIR[2]);
        gl.uniform3f(j.u.uCamPos, camPos[0], camPos[1], camPos[2]);
        gl.uniform3f(j.u.uFogColor, FOG_COLOR[0], FOG_COLOR[1], FOG_COLOR[2]);
        gl.drawElements(gl.TRIANGLES, this._ground.idxCount, gl.UNSIGNED_SHORT, 0);
        this.drawCalls++;
        this.triangles += this._ground.idxCount / 3;
      }
      gl.bindVertexArray(null);
    }

    // --- jets with per-shape LOD sets picked by variant + distance (Tasks 0.6 + 3A.2) ---
    if (this._jetLodSets) {
      const j = this._progJet;
      gl.useProgram(j.prog);
      const n = scene.jetCount;
      for (let i = 0; i < n; i++) {
        const d = scene.jetDist[i];
        const lod = d < 1200 ? 0 : (d < 3500 ? 1 : 2);
        const set = this._jetLodSets[scene.jetKind ? scene.jetKind[i] : 0] || this._jetLodSets[0];
        const mesh = set[lod] || set[0];
        mat4FromYPR(this._model, scene.jetRot[i * 3], scene.jetRot[i * 3 + 1],
          scene.jetRot[i * 3 + 2], scene.jetPos[i * 3], scene.jetPos[i * 3 + 1], scene.jetPos[i * 3 + 2]);
        gl.bindVertexArray(mesh.vao);
        gl.uniformMatrix4fv(j.u.uViewProj, false, this._viewProj);
        gl.uniformMatrix4fv(j.u.uModel, false, this._model);
        gl.uniform3f(j.u.uSunDir, SUN_DIR[0], SUN_DIR[1], SUN_DIR[2]);
        gl.uniform3f(j.u.uCamPos, camPos[0], camPos[1], camPos[2]);
        gl.uniform3f(j.u.uFogColor, FOG_COLOR[0], FOG_COLOR[1], FOG_COLOR[2]);
        gl.drawElements(gl.TRIANGLES, mesh.idxCount, gl.UNSIGNED_SHORT, 0);
        this.drawCalls++;
        this.triangles += mesh.idxCount / 3;
      }
      gl.bindVertexArray(null);
    }
    // --- particles (Task 1.8): one VBO, two blend ranges (alpha kinds, then additive) ---
    if (this._particles) {
      const ps = this._particles.sys;
      const count = ps.stage();
      if (count > 0) {
        const gl2 = this.gl;
        gl2.useProgram(this._progParticles.prog);
        const p = this._progParticles;
        gl2.uniformMatrix4fv(p.u.uViewProj, false, this._viewProj);
        gl2.uniform1f(p.u.uPointScale, (this.canvas.height || 1) / (2 * Math.tan(fovyRad / 2)));
        gl2.bindVertexArray(this._particles.vao);
        gl2.bindBuffer(gl2.ARRAY_BUFFER, this._particles.vbo);
        gl2.bufferSubData(gl2.ARRAY_BUFFER, 0, ps.staging, 0, count * 8);
        gl2.depthMask(false);
        gl2.enable(gl2.BLEND);
        const nA = ps.stagedAlphaCount;
        if (nA > 0) {
          gl2.blendFunc(gl2.SRC_ALPHA, gl2.ONE_MINUS_SRC_ALPHA);
          gl2.uniform1f(p.u.uSoft, 1.0);
          gl2.drawArrays(gl2.POINTS, 0, nA);
        }
        if (count > nA) {
          gl2.blendFunc(gl2.SRC_ALPHA, gl2.ONE);
          gl2.uniform1f(p.u.uSoft, 0.0);
          gl2.drawArrays(gl2.POINTS, nA, count - nA);
        }
        gl2.disable(gl2.BLEND);
        gl2.depthMask(true);
        gl2.bindVertexArray(null);
        this.drawCalls += nA > 0 ? 2 : 1;
      }
    }
  }

  // Tracer lines (Task 1.3): main stages [x,y,z,r,g,b,a] * 2 verts per tracer; LINES draw.
  drawTracers(data, vertCount) {
    if (!this._lines || vertCount <= 0) return;
    const gl = this.gl;
    gl.useProgram(this._progLine.prog);
    const l = this._progLine;
    gl.uniformMatrix4fv(l.u.uViewProj, false, this._viewProj);
    gl.bindVertexArray(this._lines.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._lines.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, vertCount * 7);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
    gl.drawArrays(gl.LINES, 0, vertCount);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    this.drawCalls++;
  }

  // World -> CSS pixel coordinates for HUD target boxes (Task 1.9). Writes into out
  // [cssX, cssY, inFront(0/1)]. Uses this frame's viewProj; call after drawFrame began
  // (viewProj is rebuilt at the start of drawFrame). Zero allocation.
  project(out, camPos, x, y, z) {
    const m = this._viewProj;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (w <= 0.0001) { out[2] = 0; return out; }
    const cx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    const cy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    const rect = this.canvas.getBoundingClientRect ? this.canvas.getBoundingClientRect() : null;
    const cw = rect ? rect.width : (this.canvas.width || 1);
    const ch = rect ? rect.height : (this.canvas.height || 1);
    out[0] = (cx * 0.5 + 0.5) * cw;
    out[1] = (1 - (cy * 0.5 + 0.5)) * ch;
    out[2] = 1;
    void camPos;
    return out;
  }
}

// ---- Procedural low-poly jet (Task 0.6, original geometry, no external model) ----
// 3 LODs via scaling detail: LOD0 ~120 tris, LOD1 ~60, LOD2 ~36.
// Interleaved layout [px,py,pz, nx,ny,nz, r,g,b], stride 9 floats, Uint16 indices.

const JET_COLORS = {
  body: [0.62, 0.64, 0.67],
  nose: [0.56, 0.58, 0.61],
  canopy: [0.16, 0.23, 0.32],
  wing: [0.60, 0.62, 0.65],
  fin: [0.58, 0.60, 0.63],
  nozzle: [0.25, 0.25, 0.27],
};

function pushBox(out, cx, cy, cz, sx, sy, sz, rotY, col) {
  const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
  const c = Math.cos(rotY), s = Math.sin(rotY);
  // 8 corners, rotated about Y then translated
  const px = [hx, hx, hx, hx, -hx, -hx, -hx, -hx];
  const py = [hy, hy, -hy, -hy, hy, hy, -hy, -hy];
  const pz = [-hz, hz, hz, -hz, -hz, hz, hz, -hz];
  const vx = new Float32Array(8);
  const vz = new Float32Array(8);
  for (let i = 0; i < 8; i++) {
    vx[i] = px[i] * c + pz[i] * s + cx;
    vz[i] = -px[i] * s + pz[i] * c + cz;
  }
  const vy = new Float32Array(8);
  for (let i = 0; i < 8; i++) vy[i] = py[i] + cy;
  // faces as quads (two triangles each): indices into the 8 corners
  const faces = [
    [1, 2, 6, 5], // +x
    [4, 7, 3, 0], // -x
    [4, 5, 6, 7], // +y
    [0, 3, 2, 1], // -y
    [5, 6, 2, 1], // +z (rear)
    [0, 3, 7, 4], // -z (front)
  ];
  const base = out.vertCount;
  for (let f = 0; f < 6; f++) {
    const q = faces[f];
    // flat normal from first triangle
    const ax = vx[q[1]] - vx[q[0]], ay = vy[q[1]] - vy[q[0]], az = vz[q[1]] - vz[q[0]];
    const bx = vx[q[2]] - vx[q[0]], by = vy[q[2]] - vy[q[0]], bz = vz[q[2]] - vz[q[0]];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (let k = 0; k < 4; k++) {
      out.verts.push(vx[q[k]], vy[q[k]], vz[q[k]], nx, ny, nz, col[0], col[1], col[2]);
      out.vertCount++;
    }
    const b2 = base + f * 4;
    out.idx.push(b2, b2 + 1, b2 + 2, b2, b2 + 2, b2 + 3);
  }
}

export function buildJetLod(level) {
  const out = { verts: [], idx: [], vertCount: 0 };
  const C = JET_COLORS;
  if (level === 0) {
    pushBox(out, 0, 0.05, -5.4, 0.55, 0.5, 3.2, 0, C.nose);      // nose
    pushBox(out, 0, 0, -1.2, 1.05, 0.95, 4.6, 0, C.body);        // front body
    pushBox(out, 0, 0.58, -2.1, 0.72, 0.5, 1.9, 0, C.canopy);    // canopy
    pushBox(out, 2.75, -0.12, 0.9, 4.5, 0.12, 2.1, -0.38, C.wing); // right wing
    pushBox(out, -2.75, -0.12, 0.9, 4.5, 0.12, 2.1, 0.38, C.wing); // left wing
    pushBox(out, 0, 0.85, 4.5, 0.14, 1.7, 1.4, 0, C.fin);        // vertical fin
    pushBox(out, 1.25, 0, 4.9, 2.3, 0.1, 1.1, -0.22, C.fin);     // right stabilator
    pushBox(out, -1.25, 0, 4.9, 2.3, 0.1, 1.1, 0.22, C.fin);     // left stabilator
    pushBox(out, 0, 0, 6.35, 0.85, 0.85, 0.8, 0, C.nozzle);      // nozzle
  } else if (level === 1) {
    pushBox(out, 0, 0.02, -3.4, 0.75, 0.7, 6.4, 0, C.nose);
    pushBox(out, 0, 0, 2.4, 1.05, 0.95, 5.2, 0, C.body);
    pushBox(out, 2.75, -0.12, 1.1, 4.5, 0.14, 2.1, -0.38, C.wing);
    pushBox(out, -2.75, -0.12, 1.1, 4.5, 0.14, 2.1, 0.38, C.wing);
    pushBox(out, 0, 0.8, 4.6, 0.14, 1.6, 1.3, 0, C.fin);
  } else {
    pushBox(out, 0, 0, 0.2, 1.0, 0.9, 12.4, 0, C.body);
    pushBox(out, 2.6, -0.1, 1.2, 4.2, 0.14, 2.0, -0.38, C.wing);
    pushBox(out, -2.6, -0.1, 1.2, 4.2, 0.14, 2.0, 0.38, C.wing);
  }
  return {
    verts: new Float32Array(out.verts),
    idx: new Uint16Array(out.idx),
    stride: 9,
  };
}

// ---- Phase 2 mission meshes (original procedural geometry, same pushBox conventions) ----

// Missile boat (ents.variant 2): hull, deckhouse, mast, aft missile launcher.
export function buildShipLod() {
  const out = { verts: [], idx: [], vertCount: 0 };
  const HULL = [0.26, 0.28, 0.31], DECK = [0.36, 0.39, 0.42],
    TOWER = [0.44, 0.47, 0.51], DARK = [0.15, 0.16, 0.18];
  pushBox(out, 0, 1.4, 0, 7.5, 2.8, 34, 0, HULL);          // hull
  pushBox(out, 0, 3.4, 2, 6.2, 1.2, 22, 0, DECK);          // main deck
  pushBox(out, 0, 5.6, 6, 4.4, 3.2, 7, 0, TOWER);          // deckhouse
  pushBox(out, 0, 9.4, 6, 0.7, 3.4, 0.7, 0, DARK);         // mast
  pushBox(out, 0, 4.6, -11, 3.4, 1.6, 5.5, 0, DARK);       // launcher block
  pushBox(out, 0, 6.1, -11, 1.9, 1.4, 3.6, -0.35, DARK);   // raised launcher rails
  return { verts: new Float32Array(out.verts), idx: new Uint16Array(out.idx), stride: 9 };
}

// Offshore oil rig (ents.variant 3): four legs, cellar deck, modules, derrick, helipad.
export function buildRigLod() {
  const out = { verts: [], idx: [], vertCount: 0 };
  const LEG = [0.32, 0.30, 0.27], DECK = [0.42, 0.45, 0.48],
    MOD = [0.55, 0.50, 0.38], DERRICK = [0.30, 0.32, 0.35], PAD = [0.58, 0.60, 0.62];
  const lx = 30, lz = 30;
  for (let i = 0; i < 4; i++) {
    const x = (i & 1) ? lx : -lx, z = (i & 2) ? lz : -lz;
    pushBox(out, x, 11, z, 7, 26, 7, 0, LEG);              // legs (hull interval not modeled)
  }
  pushBox(out, 0, 26, 0, 78, 5, 78, 0, DECK);              // cellar deck
  pushBox(out, -18, 31, -16, 22, 8, 20, 0, MOD);           // living quarters module
  pushBox(out, 16, 30, 14, 18, 6, 16, 0, MOD);             // process module
  pushBox(out, 8, 46, -12, 8, 34, 8, 0, DERRICK);          // derrick tower
  pushBox(out, 8, 65, -12, 3, 3, 3, 0, DERRICK);           // crown block
  pushBox(out, 26, 30.5, -22, 24, 1.4, 24, 0, PAD);        // helipad
  return { verts: new Float32Array(out.verts), idx: new Uint16Array(out.idx), stride: 9 };
}

// Ground unit silhouette (ents.variant 4-6): bunker slab, radar mast, angled SAM rack.
export function buildGroundLod() {
  const out = { verts: [], idx: [], vertCount: 0 };
  const BASE = [0.35, 0.34, 0.30], MAST = [0.24, 0.25, 0.27], RACK = [0.52, 0.42, 0.22];
  pushBox(out, 0, 1.1, 0, 11, 2.2, 11, 0, BASE);           // bunker base
  pushBox(out, -3, 4.6, -3, 0.8, 5.5, 0.8, 0, MAST);       // radar mast
  pushBox(out, -3, 7.6, -3, 4.2, 0.6, 1.1, 0, MAST);       // radar panel
  pushBox(out, 2.5, 3.1, 2.5, 5.5, 1.5, 2.2, -0.5, RACK);  // angled missile rack
  return { verts: new Float32Array(out.verts), idx: new Uint16Array(out.idx), stride: 9 };
}

