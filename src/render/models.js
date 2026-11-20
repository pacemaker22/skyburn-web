// Skyburn Phase 3A - Procedural jet kitbash (Task 3A.2). Shared fuselage/wing/tail/canopy
// primitives assembled into 7 shape families, 3 LODs each - "all jets selectable distinct"
// without any external model. Pure data builder: no DOM, no WebGL, unit-testable in Node.
// Output layout matches the Phase 0 jet mesh exactly: interleaved
// [px,py,pz, nx,ny,nz, r,g,b] (stride 9), Uint16 indices, forward = -Z.

// Shape families (ordered = ents.variant index for jets; renderer uploads one LOD set each).
export const SHAPE_IDS = ['multi', 'twin', 'delta', 'canard', 'swept', 'attack', 'blackbird'];

// Default per-family paint (body/accent) when a jet def does not carry its own.
export const SHAPE_PAINT = {
  multi:     { body: [0.58, 0.60, 0.62], accent: [0.40, 0.42, 0.44] },
  twin:      { body: [0.52, 0.55, 0.58], accent: [0.35, 0.38, 0.41] },
  delta:     { body: [0.56, 0.56, 0.52], accent: [0.39, 0.39, 0.36] },
  canard:    { body: [0.52, 0.54, 0.51], accent: [0.36, 0.38, 0.35] },
  swept:     { body: [0.54, 0.56, 0.55], accent: [0.37, 0.39, 0.38] },
  attack:    { body: [0.44, 0.47, 0.40], accent: [0.30, 0.32, 0.27] },
  blackbird: { body: [0.12, 0.12, 0.14], accent: [0.08, 0.08, 0.10] },
};

const CANOPY = [0.16, 0.23, 0.32];
const NOZZLE = [0.25, 0.25, 0.27];

// Box with rotation about Y then Z (cant), flat normals, two triangles per face.
// Same vertex conventions as renderer.pushBox plus the rotZ cant for twin fins.
function pushBox(out, cx, cy, cz, sx, sy, sz, rotY, col, rotZ) {
  const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
  const c = Math.cos(rotY), s = Math.sin(rotY);
  const rc = Math.cos(rotZ || 0), rs = Math.sin(rotZ || 0);
  const px = [hx, hx, hx, hx, -hx, -hx, -hx, -hx];
  const py = [hy, hy, -hy, -hy, hy, hy, -hy, -hy];
  const pz = [-hz, hz, hz, -hz, -hz, hz, hz, -hz];
  const vx = [], vy = [], vz = [];
  for (let i = 0; i < 8; i++) {
    const xr = px[i] * c + pz[i] * s;
    const zr = -px[i] * s + pz[i] * c;
    const yr = py[i] * rc - zr * rs;   // cant about Z (roll the fin outward)
    const zr2 = py[i] * rs + zr * rc;
    vx.push(xr + cx); vy.push(yr + cy); vz.push(zr2 + cz);
  }
  const faces = [
    [1, 2, 6, 5], [4, 7, 3, 0], [4, 5, 6, 7], [0, 3, 2, 1], [5, 6, 2, 1], [0, 3, 7, 4],
  ];
  const base = out.vertCount;
  for (let f = 0; f < 6; f++) {
    const q = faces[f];
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

// Tapered fuselage section along Z: back cross-section [bSx, bSy] at +len/2,
// front cross-section [fSx, fSy] at -len/2 (nose cones, tail tapers, chines).
function pushWedge(out, cx, cy, cz, bSx, bSy, fSx, fSy, len, col) {
  const hbSx = bSx * 0.5, hbSy = bSy * 0.5, hfSx = fSx * 0.5, hfSy = fSy * 0.5;
  const zb = cz + len * 0.5, zf = cz - len * 0.5;
  // 8 corners: 0-3 back (bl, br, tr, tl), 4-7 front
  const vx = [cx - hbSx, cx + hbSx, cx + hbSx, cx - hbSx, cx - hfSx, cx + hfSx, cx + hfSx, cx - hfSx];
  const vy = [cy - hbSy, cy - hbSy, cy + hbSy, cy + hbSy, cy - hfSy, cy - hfSy, cy + hfSy, cy + hfSy];
  const vz = [zb, zb, zb, zb, zf, zf, zf, zf];
  const faces = [
    [0, 1, 5, 4],   // bottom
    [3, 7, 6, 2],   // top
    [1, 2, 6, 5],   // right
    [0, 4, 7, 3],   // left
    [4, 5, 6, 7],   // front cap
    [0, 3, 2, 1],   // back cap
  ];
  const base = out.vertCount;
  for (let f = 0; f < 6; f++) {
    const q = faces[f];
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

// Swept wing as a thin tapered box rotated about Y (Phase 0 convention, parameterized).
function pushWing(out, side, cx, cy, cz, span, chord, sweepRad, thick, col) {
  const x = cx + side * span * 0.5;
  pushBox(out, x, cy, cz, span, thick, chord, -side * sweepRad, col);
}

// ---- Shared part builders (fuselage-level composition) ----

function addCanopy(out, z, w, h, C) {
  pushBox(out, 0, 0.55 + h * 0.25, z, w, h, 1.9, 0, C.canopy);
}

function addWings(out, span, chord, sweep, y, z, C, level) {
  pushWing(out, 1, span * 0.5, y, z, span, chord, sweep, level === 0 ? 0.12 : 0.16, C.wing);
  pushWing(out, -1, span * 0.5, y, z, span, chord, sweep, level === 0 ? 0.12 : 0.16, C.wing);
}

function addNozzles(out, count, sep, len, C) {
  const z = len * 0.48;
  if (count === 2) {
    pushBox(out, sep, 0, z, 0.75, 0.75, 0.8, 0, C.nozzle);
    pushBox(out, -sep, 0, z, 0.75, 0.75, 0.8, 0, C.nozzle);
  } else {
    pushBox(out, 0, 0, z, 0.85, 0.85, 0.8, 0, C.nozzle);
  }
}

// ---- buildJetKitLod(kit, level): kit = { shape, paint?, accent? } ----
// level 0 ~ full detail, 1 ~ medium, 2 ~ silhouette. Returns the shared mesh format.
export function buildJetKitLod(kit, level) {
  const shape = SHAPE_IDS.indexOf(kit.shape) >= 0 ? kit.shape : 'multi';
  const pal = SHAPE_PAINT[shape];
  const C = {
    body: kit.paint || pal.body,
    wing: kit.paint || pal.body,
    fin: kit.accent || pal.accent,
    canopy: CANOPY,
    nozzle: NOZZLE,
  };
  const out = { verts: [], idx: [], vertCount: 0 };

  if (shape === 'multi') {
    // Single tail, mid-set wings, bubble canopy (F-16 / F-35 / JF-17 / F-5).
    if (level === 0) {
      pushWedge(out, 0, 0.05, -4.4, 1.0, 0.85, 0.16, 0.14, 3.4, C.body);  // nose cone
      pushBox(out, 0, 0, -0.7, 1.05, 0.95, 4.6, 0, C.body);               // front body
      pushBox(out, 0, 0, 3.4, 0.92, 0.85, 3.4, 0, C.body);                // aft body
      addCanopy(out, -1.9, 0.68, 0.5, C);
      pushBox(out, 0.78, -0.28, -0.6, 0.5, 0.55, 2.6, 0, C.fin);          // intake
      pushBox(out, -0.78, -0.28, -0.6, 0.5, 0.55, 2.6, 0, C.fin);
      addWings(out, 4.4, 2.1, 0.40, -0.1, 0.6, C, level);
      pushBox(out, 0, 0.92, 4.4, 0.14, 1.6, 1.3, 0, C.fin);               // fin
      pushWing(out, 1, 1.15, 0, 4.9, 2.1, 1.0, 0.28, 0.1, C.fin);         // stabilators
      pushWing(out, -1, 1.15, 0, 4.9, 2.1, 1.0, 0.28, 0.1, C.fin);
      addNozzles(out, 1, 0, 6.6, C);
    } else if (level === 1) {
      pushWedge(out, 0, 0, -3.2, 1.0, 0.9, 0.3, 0.28, 4.4, C.body);
      pushBox(out, 0, 0, 2.4, 1.0, 0.9, 5.6, 0, C.body);
      addWings(out, 4.4, 2.0, 0.40, -0.1, 0.8, C, level);
      pushBox(out, 0, 0.9, 4.5, 0.14, 1.55, 1.2, 0, C.fin);
    } else {
      pushBox(out, 0, 0, 0.2, 0.95, 0.85, 11.4, 0, C.body);
      addWings(out, 4.2, 2.0, 0.40, -0.1, 1.0, C, level);
    }
  } else if (shape === 'twin') {
    // Wide fuselage, canted twin fins, big wings (F-15/F-22/Su-27/MiG-29/F-14).
    if (level === 0) {
      pushWedge(out, 0, 0.05, -4.6, 1.45, 0.9, 0.2, 0.16, 3.4, C.body);
      pushBox(out, 0, 0, -0.6, 1.5, 0.95, 4.8, 0, C.body);
      pushBox(out, 0, 0, 3.6, 1.3, 0.9, 3.6, 0, C.body);
      addCanopy(out, -2.1, 0.8, 0.5, C);
      pushBox(out, 0.85, -0.25, -0.4, 0.55, 0.6, 3.0, 0, C.fin);          // intakes
      pushBox(out, -0.85, -0.25, -0.4, 0.55, 0.6, 3.0, 0, C.fin);
      addWings(out, 4.8, 2.3, 0.42, -0.12, 0.8, C, level);
      pushBox(out, 0.7, 0.95, 4.6, 0.13, 1.7, 1.2, 0, C.fin, 0.30);       // twin fins
      pushBox(out, -0.7, 0.95, 4.6, 0.13, 1.7, 1.2, 0, C.fin, -0.30);
      pushWing(out, 1, 1.3, 0, 5.0, 2.3, 1.0, 0.30, 0.1, C.fin);
      pushWing(out, -1, 1.3, 0, 5.0, 2.3, 1.0, 0.30, 0.1, C.fin);
      addNozzles(out, 2, 0.5, 6.9, C);
    } else if (level === 1) {
      pushWedge(out, 0, 0, -3.4, 1.45, 0.95, 0.3, 0.3, 4.6, C.body);
      pushBox(out, 0, 0, 2.6, 1.4, 0.95, 6.0, 0, C.body);
      addWings(out, 4.8, 2.2, 0.42, -0.12, 1.0, C, level);
      pushBox(out, 0.7, 0.95, 4.7, 0.13, 1.65, 1.1, 0, C.fin, 0.30);
      pushBox(out, -0.7, 0.95, 4.7, 0.13, 1.65, 1.1, 0, C.fin, -0.30);
    } else {
      pushBox(out, 0, 0, 0.2, 1.4, 0.9, 12.2, 0, C.body);
      addWings(out, 4.6, 2.2, 0.42, -0.12, 1.2, C, level);
    }
  } else if (shape === 'delta') {
    // Tailless delta + single tall fin (Mirage 2000 / Draken / Kfir / Tejas).
    if (level === 0) {
      pushWedge(out, 0, 0.05, -4.2, 1.0, 0.9, 0.14, 0.14, 3.2, C.body);
      pushBox(out, 0, 0, -0.6, 1.05, 0.95, 4.6, 0, C.body);
      pushBox(out, 0, 0, 3.4, 0.95, 0.9, 3.6, 0, C.body);
      addCanopy(out, -1.9, 0.66, 0.48, C);
      addWings(out, 5.0, 3.1, 0.55, -0.08, 1.4, C, level);                // big delta
      pushBox(out, 0, 1.0, 4.5, 0.14, 1.8, 1.5, 0, C.fin);                // tall fin
      addNozzles(out, 1, 0, 6.6, C);
    } else if (level === 1) {
      pushWedge(out, 0, 0, -3.0, 1.0, 0.9, 0.3, 0.3, 4.2, C.body);
      pushBox(out, 0, 0, 2.4, 1.0, 0.9, 5.6, 0, C.body);
      addWings(out, 5.0, 3.0, 0.55, -0.08, 1.6, C, level);
      pushBox(out, 0, 1.0, 4.6, 0.14, 1.75, 1.4, 0, C.fin);
    } else {
      pushBox(out, 0, 0, 0.2, 1.0, 0.85, 11.6, 0, C.body);
      addWings(out, 4.8, 3.0, 0.55, -0.08, 1.8, C, level);
    }
  } else if (shape === 'canard') {
    // Canard foreplanes + delta main wing (Rafale / Typhoon / Gripen / J-10 / J-20).
    if (level === 0) {
      pushWedge(out, 0, 0.05, -4.4, 1.0, 0.9, 0.16, 0.14, 3.4, C.body);
      pushBox(out, 0, 0, -0.6, 1.05, 0.95, 4.8, 0, C.body);
      pushBox(out, 0, 0, 3.5, 0.95, 0.9, 3.6, 0, C.body);
      addCanopy(out, -2.0, 0.68, 0.48, C);
      pushWing(out, 1, 1.05, 0.28, -2.9, 1.5, 0.75, 0.36, 0.09, C.fin);   // canards
      pushWing(out, -1, 1.05, 0.28, -2.9, 1.5, 0.75, 0.36, 0.09, C.fin);
      addWings(out, 4.8, 2.9, 0.52, -0.08, 1.2, C, level);
      pushBox(out, 0, 0.95, 4.6, 0.14, 1.7, 1.4, 0, C.fin);
      addNozzles(out, 1, 0, 6.7, C);
    } else if (level === 1) {
      pushWedge(out, 0, 0, -3.2, 1.0, 0.9, 0.3, 0.3, 4.4, C.body);
      pushBox(out, 0, 0, 2.5, 1.0, 0.9, 5.8, 0, C.body);
      addWings(out, 4.8, 2.8, 0.52, -0.08, 1.4, C, level);
      pushBox(out, 0, 0.95, 4.7, 0.14, 1.65, 1.3, 0, C.fin);
    } else {
      pushBox(out, 0, 0, 0.2, 1.0, 0.85, 11.8, 0, C.body);
      addWings(out, 4.6, 2.8, 0.52, -0.08, 1.6, C, level);
    }
  } else if (shape === 'swept') {
    // Long thin fuselage, high tail, smaller wings (F-4/MiG-21/MiG-25/Tornado/F-104).
    if (level === 0) {
      pushWedge(out, 0, 0, -5.0, 0.85, 0.8, 0.12, 0.12, 4.0, C.body);     // long nose
      pushBox(out, 0, 0, -0.6, 0.95, 0.9, 5.2, 0, C.body);
      pushBox(out, 0, 0, 3.8, 0.9, 0.85, 3.8, 0, C.body);
      addCanopy(out, -2.2, 0.6, 0.44, C);
      pushBox(out, 0.62, -0.22, -0.2, 0.42, 0.5, 3.2, 0, C.fin);
      pushBox(out, -0.62, -0.22, -0.2, 0.42, 0.5, 3.2, 0, C.fin);
      addWings(out, 4.0, 2.0, 0.50, -0.1, 0.9, C, level);
      pushBox(out, 0, 1.28, 4.9, 0.13, 2.0, 1.5, 0, C.fin);               // high fin
      pushWing(out, 1, 1.0, 0, 5.3, 2.0, 1.0, 0.32, 0.1, C.fin);
      pushWing(out, -1, 1.0, 0, 5.3, 2.0, 1.0, 0.32, 0.1, C.fin);
      addNozzles(out, 2, 0.32, 7.0, C);
    } else if (level === 1) {
      pushWedge(out, 0, 0, -3.6, 0.85, 0.8, 0.25, 0.25, 5.0, C.body);
      pushBox(out, 0, 0, 2.8, 0.92, 0.85, 6.2, 0, C.body);
      addWings(out, 4.0, 2.0, 0.50, -0.1, 1.1, C, level);
      pushBox(out, 0, 1.28, 5.0, 0.13, 1.95, 1.4, 0, C.fin);
    } else {
      pushBox(out, 0, 0, 0.2, 0.9, 0.8, 12.8, 0, C.body);
      addWings(out, 3.9, 2.0, 0.50, -0.1, 1.3, C, level);
    }
  } else if (shape === 'attack') {
    // Straight wide wings, twin engines, twin fins (A-10/Su-25/A-4/Harrier/Su-34).
    if (level === 0) {
      pushWedge(out, 0, 0.1, -4.0, 1.1, 1.0, 0.3, 0.3, 3.0, C.body);
      pushBox(out, 0, 0, -0.4, 1.2, 1.05, 4.4, 0, C.body);
      pushBox(out, 0, 0, 3.4, 1.05, 0.95, 4.0, 0, C.body);
      addCanopy(out, -1.6, 0.7, 0.5, C);
      pushBox(out, 0.95, 0.15, 3.6, 0.6, 0.75, 3.2, 0, C.fin);            // engine nacelles
      pushBox(out, -0.95, 0.15, 3.6, 0.6, 0.75, 3.2, 0, C.fin);
      addWings(out, 5.4, 2.6, 0.06, -0.1, 0.4, C, level);                 // straight wing
      pushBox(out, 1.75, 0.85, 5.0, 0.13, 1.6, 1.1, 0, C.fin, 0.18);      // twin fins
      pushBox(out, -1.75, 0.85, 5.0, 0.13, 1.6, 1.1, 0, C.fin, -0.18);
      pushWing(out, 1, 1.5, 0, 5.3, 2.4, 1.2, 0.10, 0.1, C.fin);
      pushWing(out, -1, 1.5, 0, 5.3, 2.4, 1.2, 0.10, 0.1, C.fin);
      addNozzles(out, 2, 0.95, 6.6, C);
    } else if (level === 1) {
      pushWedge(out, 0, 0, -2.9, 1.1, 1.0, 0.4, 0.4, 3.8, C.body);
      pushBox(out, 0, 0, 2.8, 1.15, 1.0, 6.0, 0, C.body);
      addWings(out, 5.4, 2.5, 0.06, -0.1, 0.6, C, level);
      pushBox(out, 1.75, 0.85, 5.1, 0.13, 1.55, 1.0, 0, C.fin, 0.18);
      pushBox(out, -1.75, 0.85, 5.1, 0.13, 1.55, 1.0, 0, C.fin, -0.18);
    } else {
      pushBox(out, 0, 0, 0.2, 1.15, 0.95, 11.2, 0, C.body);
      addWings(out, 5.2, 2.5, 0.06, -0.1, 0.8, C, level);
    }
  } else { // blackbird: chined body, huge delta, fins on nacelles (SR-71)
    if (level === 0) {
      pushWedge(out, 0, 0.05, -5.2, 1.7, 0.85, 0.16, 0.5, 5.0, C.body);   // chined nose
      pushBox(out, 0, 0, -0.4, 1.75, 0.9, 5.6, 0, C.body);
      pushBox(out, 0, 0, 4.0, 1.5, 0.85, 4.4, 0, C.body);
      addCanopy(out, -2.4, 0.6, 0.4, C);
      addWings(out, 5.8, 3.2, 0.60, -0.05, 1.6, C, level);                // huge delta
      pushBox(out, 2.1, 0.35, 3.4, 0.7, 0.85, 3.6, 0, C.fin);             // nacelles
      pushBox(out, -2.1, 0.35, 3.4, 0.7, 0.85, 3.6, 0, C.fin);
      pushBox(out, 2.1, 1.35, 4.9, 0.12, 1.9, 1.4, 0, C.fin, 0.14);       // fins on nacelles
      pushBox(out, -2.1, 1.35, 4.9, 0.12, 1.9, 1.4, 0, C.fin, -0.14);
      addNozzles(out, 2, 2.1, 7.2, C);
    } else if (level === 1) {
      pushWedge(out, 0, 0, -3.8, 1.7, 0.85, 0.3, 0.5, 5.4, C.body);
      pushBox(out, 0, 0, 3.0, 1.6, 0.85, 6.4, 0, C.body);
      addWings(out, 5.8, 3.1, 0.60, -0.05, 1.8, C, level);
      pushBox(out, 2.1, 1.35, 5.0, 0.12, 1.85, 1.3, 0, C.fin, 0.14);
      pushBox(out, -2.1, 1.35, 5.0, 0.12, 1.85, 1.3, 0, C.fin, -0.14);
    } else {
      pushBox(out, 0, 0, 0.2, 1.65, 0.85, 13.4, 0, C.body);
      addWings(out, 5.6, 3.0, 0.60, -0.05, 2.0, C, level);
    }
  }

  return { verts: new Float32Array(out.verts), idx: new Uint16Array(out.idx), stride: 9 };
}

// Variant index for the renderer (jets key per-shape LOD sets via ents.variant).
export function shapeIndexFor(jet) {
  const i = SHAPE_IDS.indexOf(jet && jet.shape);
  return i >= 0 ? i : 0;
}

// ---- Graphics pass extras (visual only, same pushBox conventions) ----

import { mulberry32 } from '../world/terrain.js';

// Guided-missile body (bright orange, pale nose, dark fins). Forward = -Z like every jet
// mesh, so MissileSystem yaw/pitch drive it directly through mat4FromYPR. ~30 tris, stride 9.
export function buildMissileLod() {
  const out = { verts: [], idx: [], vertCount: 0 };
  const BODY = [1.0, 0.42, 0.08];    // bright orange (readability rule #2)
  const NOSE = [1.0, 0.80, 0.58];    // warm pale tip
  const FIN = [0.16, 0.18, 0.20];    // dark slate fins
  pushBox(out, 0, 0, 0.4, 0.44, 0.44, 3.4, 0, BODY);   // body tube
  pushBox(out, 0, 0, -1.7, 0.30, 0.30, 0.9, 0, NOSE);  // nose block
  pushBox(out, 0.56, 0, 1.5, 0.95, 0.06, 0.8, 0, FIN); // right fin
  pushBox(out, -0.56, 0, 1.5, 0.95, 0.06, 0.8, 0, FIN); // left fin
  pushBox(out, 0, 0.56, 1.5, 0.06, 0.95, 0.8, 0, FIN); // top fin
  pushBox(out, 0, -0.56, 1.5, 0.06, 0.95, 0.8, 0, FIN); // bottom fin
  return { verts: new Float32Array(out.verts), idx: new Uint16Array(out.idx), stride: 9 };
}

// Instanced cloud billboard instances: one Float32Array(count * 5), layout [x, y, z, size, seed].
// Static ring layout around the island (1400-8400 m out, 2300-3700 m up) with a handful of
// loose clusters; deterministic via the seeded RNG so every boot shows the same sky. The art
// direction asks for 30-50 sprites -> default count 44. Built once at boot, never per frame.
export function buildCloudBillboards(count, seed) {
  const n = count || 44;
  const rand = mulberry32(seed === undefined ? 0xC10D : seed);
  const data = new Float32Array(n * 5);
  // 5 cluster anchors keep the sky from looking uniformly sprinkled
  const cx = new Float32Array(5), cz = new Float32Array(5);
  for (let k = 0; k < 5; k++) {
    const ang = rand() * Math.PI * 2;
    const rad = 1800 + rand() * 5200;
    cx[k] = Math.cos(ang) * rad;
    cz[k] = Math.sin(ang) * rad;
  }
  for (let i = 0; i < n; i++) {
    let x, z;
    if (i < 20) {
      const k = i % 5;
      x = cx[k] + (rand() - 0.5) * 2600;   // clustered members
      z = cz[k] + (rand() - 0.5) * 2600;
    } else {
      const ang = rand() * Math.PI * 2;    // scattered members
      const rad = 1400 + Math.pow(rand(), 0.8) * 7000;
      x = Math.cos(ang) * rad;
      z = Math.sin(ang) * rad;
    }
    const y = 2300 + rand() * 1400;
    const size = 280 + rand() * 420;
    data[i * 5] = x;
    data[i * 5 + 1] = y;
    data[i * 5 + 2] = z;
    data[i * 5 + 3] = size;
    data[i * 5 + 4] = rand();
  }
  return data;
}
