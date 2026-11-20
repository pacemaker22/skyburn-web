// PNG pixel-statistics analyzer (no dependencies). Reports average color, band means,
// and simple color-class percentages so a screenshot can be verified numerically.
// Usage: node tools/png_stats.mjs <file.png>
import fs from 'node:fs';
import zlib from 'node:zlib';

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error('unsupported PNG (depth ' + bitDepth + ' color ' + colorType + ')');
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const row = raw.slice(p, p + stride); p += stride;
    const dst = out.slice(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? dst[x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = (x >= bpp && y > 0) ? out[(y - 1) * stride + x - bpp] : 0;
      let v = row[x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v = (v + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255;
      }
      dst[x] = v;
    }
  }
  return { w, h, bpp, data: out };
}

const img = decodePng(fs.readFileSync(process.argv[2] || 'smoke.png'));
const { w, h, bpp, data } = img;
const px = (x, y) => {
  const o = (y * w + x) * bpp;
  return [data[o], data[o + 1], data[o + 2]];
};
let sr = 0, sg = 0, sb = 0, n = 0;
const classes = { skyBlue: 0, warm: 0, dark: 0, white: 0, gray: 0, green: 0, other: 0 };
const stepX = Math.max(1, Math.floor(w / 320));
const stepY = Math.max(1, Math.floor(h / 320));
const bands = [0, 0, 0, 0, 0, 0].map(() => [0, 0, 0, 0]); // 6 vertical bands RGB sums + count
for (let y = 0; y < h; y += stepY) {
  for (let x = 0; x < w; x += stepX) {
    const [r, g, b] = px(x, y);
    sr += r; sg += g; sb += b; n++;
    const bi = Math.min(5, Math.floor((y / h) * 6));
    bands[bi][0] += r; bands[bi][1] += g; bands[bi][2] += b; bands[bi][3]++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (b > r + 15 && b > 90) classes.skyBlue++;
    else if (r > 210 && g > 150 && b < 150 && r > b + 60) classes.warm++;
    else if (mx < 30) classes.dark++;
    else if (mn > 225) classes.white++;
    else if (g > r + 12 && g > b + 12) classes.green++;
    else if (mx - mn < 18) classes.gray++;
    else classes.other++;
  }
}
console.log('size:', w + 'x' + h, ' sample:', n);
console.log('avg RGB:', (sr / n).toFixed(1), (sg / n).toFixed(1), (sb / n).toFixed(1));
const pct = (k) => (100 * classes[k] / n).toFixed(1) + '%';
console.log('classes: skyBlue=' + pct('skyBlue'), 'warm/sun=' + pct('warm'), 'dark=' + pct('dark'),
  'white=' + pct('white'), 'green=' + pct('green'), 'gray=' + pct('gray'), 'other=' + pct('other'));
const bl = bands.map((b, i) => 'band' + (i + 1) + ' rgb(' +
  (b[0] / b[3]).toFixed(0) + ',' + (b[1] / b[3]).toFixed(0) + ',' + (b[2] / b[3]).toFixed(0) + ')');
console.log('vertical bands (top->bottom):', bl.join('  '));
// luma variance as "terrain variation" proxy in the bottom third
let lm = 0, lm2 = 0, cnt = 0;
for (let y = Math.floor(h * 0.66); y < h; y += stepY) {
  for (let x = 0; x < w; x += stepX) {
    const [r, g, b] = px(x, y);
    const l = 0.3 * r + 0.6 * g + 0.1 * b;
    lm += l; lm2 += l * l; cnt++;
  }
}
lm /= cnt;
console.log('bottom-third luma mean/var:', lm.toFixed(1), (lm2 / cnt - lm * lm).toFixed(1));
