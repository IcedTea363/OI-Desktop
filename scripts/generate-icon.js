#!/usr/bin/env node
'use strict';
/**
 * Downloads the official Open WebUI icon and generates:
 *   assets/icon.png             — 512×512 app (Dock) icon
 *   assets/tray-iconTemplate.png — 22×22 macOS menu-bar template image
 *
 * Falls back to a generated placeholder if the download fails.
 * Uses only Node.js built-ins — no npm deps.
 */

const zlib  = require('zlib');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── CRC32 ──────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return ((c ^ 0xFFFFFFFF) >>> 0);
}

function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const d = data || Buffer.alloc(0);
  const len = Buffer.alloc(4); len.writeUInt32BE(d.length, 0);
  const crcVal = Buffer.alloc(4); crcVal.writeUInt32BE(crc32(Buffer.concat([t, d])), 0);
  return Buffer.concat([len, t, d, crcVal]);
}

// ── PNG writer (RGBA pixels) ───────────────────────────────────────────────────
function encodePNG(width, height, pixels /* flat Uint8Array RGBA */) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0; // filter = None
    pixels.copy
      ? pixels.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride)
      : raw.set(pixels.slice(y * stride, (y + 1) * stride), y * (1 + stride) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 7 })),
    pngChunk('IEND'),
  ]);
}

// ── Minimal PNG decoder ────────────────────────────────────────────────────────
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePNG(buf) {
  // Verify signature
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error('Not a PNG');

  let pos = 8, width, height, bitDepth, colorType;
  const idatList = [], palette = [];

  while (pos < buf.length) {
    const len  = buf.readUInt32BE(pos); pos += 4;
    const type = buf.toString('ascii', pos, pos + 4); pos += 4;
    const data = buf.slice(pos, pos + len); pos += len + 4; // skip CRC

    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'PLTE') {
      for (let i = 0; i < data.length; i += 3)
        palette.push([data[i], data[i + 1], data[i + 2], 255]);
    } else if (type === 'IDAT') {
      idatList.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  // channels per color type: 0=G, 2=RGB, 3=idx, 4=GA, 6=RGBA
  const CH  = [1, 0, 3, 1, 2, 0, 4];
  const bpp = CH[colorType]; // bytes per pixel (bit depth assumed 8)
  const scanW = width * bpp;

  const raw = zlib.inflateSync(Buffer.concat(idatList));
  const rgba = Buffer.alloc(width * height * 4);
  let prevRow = Buffer.alloc(scanW, 0);

  for (let y = 0; y < height; y++) {
    const base = y * (scanW + 1);
    const filt = raw[base];
    const row  = Buffer.alloc(scanW);

    for (let i = 0; i < scanW; i++) {
      const x  = raw[base + 1 + i];
      const a  = i >= bpp ? row[i - bpp] : 0;
      const b  = prevRow[i];
      const c  = i >= bpp ? prevRow[i - bpp] : 0;
      switch (filt) {
        case 0: row[i] = x;                              break;
        case 1: row[i] = (x + a)              & 0xFF;    break;
        case 2: row[i] = (x + b)              & 0xFF;    break;
        case 3: row[i] = (x + ((a + b) >> 1)) & 0xFF;    break;
        case 4: row[i] = (x + paeth(a, b, c)) & 0xFF;    break;
      }
    }
    prevRow = row;

    for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * 4;
      const src = x * bpp;
      switch (colorType) {
        case 0: rgba[dst]=rgba[dst+1]=rgba[dst+2]=row[src]; rgba[dst+3]=255; break;
        case 2: rgba[dst]=row[src]; rgba[dst+1]=row[src+1]; rgba[dst+2]=row[src+2]; rgba[dst+3]=255; break;
        case 3: { const p=palette[row[src]]||[0,0,0,255]; rgba[dst]=p[0];rgba[dst+1]=p[1];rgba[dst+2]=p[2];rgba[dst+3]=p[3]; break; }
        case 4: rgba[dst]=rgba[dst+1]=rgba[dst+2]=row[src]; rgba[dst+3]=row[src+1]; break;
        case 6: rgba[dst]=row[src];rgba[dst+1]=row[src+1];rgba[dst+2]=row[src+2];rgba[dst+3]=row[src+3]; break;
      }
    }
  }
  return { width, height, data: rgba };
}

// ── Bilinear sampling ──────────────────────────────────────────────────────────
function bilinear(src, sw, sh, dx, dy, dw, dh) {
  const sx = (dx + .5) * sw / dw - .5, sy = (dy + .5) * sh / dh - .5;
  const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy));
  const x1 = Math.min(x0 + 1, sw - 1),   y1 = Math.min(y0 + 1, sh - 1);
  const fx = sx - x0, fy = sy - y0;
  const out = new Array(4);
  for (let c = 0; c < 4; c++) {
    out[c] = Math.round(
      src[(y0*sw+x0)*4+c] * (1-fx)*(1-fy) +
      src[(y0*sw+x1)*4+c] *    fx *(1-fy) +
      src[(y1*sw+x0)*4+c] * (1-fx)*   fy  +
      src[(y1*sw+x1)*4+c] *    fx *   fy
    );
  }
  return out;
}

// ── Compose downloaded icon onto 512×512 canvas ────────────────────────────────
function makeAppIcon(srcImg) {
  const SIZE = 512, PAD = SIZE * 0.1;
  const drawW = SIZE - PAD * 2, drawH = SIZE - PAD * 2;
  const BG = [15, 15, 15]; // near-black background

  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      // Rounded-rect mask (radius = 22.5% of size — matches macOS app icon spec)
      const r  = SIZE * 0.225;
      const ix = Math.min(x, SIZE - 1 - x), iy = Math.min(y, SIZE - 1 - y);
      const inRect = ix >= r || iy >= r
        || Math.hypot(ix - r, iy - r) <= r;
      if (!inRect) { pixels[i+3] = 0; continue; }

      if (x < PAD || x >= SIZE - PAD || y < PAD || y >= SIZE - PAD) {
        pixels[i] = BG[0]; pixels[i+1] = BG[1]; pixels[i+2] = BG[2]; pixels[i+3] = 255;
        continue;
      }

      const [sr, sg, sb, sa] = bilinear(srcImg.data, srcImg.width, srcImg.height,
                                         x - PAD, y - PAD, drawW, drawH);
      const alpha = sa / 255;
      // Alpha-composite over background
      pixels[i]   = Math.round(sr * alpha + BG[0] * (1 - alpha));
      pixels[i+1] = Math.round(sg * alpha + BG[1] * (1 - alpha));
      pixels[i+2] = Math.round(sb * alpha + BG[2] * (1 - alpha));
      pixels[i+3] = 255;
    }
  }
  return encodePNG(SIZE, SIZE, pixels);
}

// ── 22×22 white template tray icon from source ─────────────────────────────────
function makeTrayIcon(srcImg) {
  const SIZE = 22;
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const [r, g, b, a] = bilinear(srcImg.data, srcImg.width, srcImg.height,
                                     x, y, SIZE, SIZE);
      // Compute luminance and use it as the template opacity
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      // For icons with dark backgrounds: use the non-background pixels as the mask.
      // Detect background as dark+opaque pixels and make them transparent.
      const isDarkBg = r < 40 && g < 40 && b < 40 && a > 200;
      if (isDarkBg) { pixels[i+3] = 0; continue; }
      const tplAlpha = Math.round((a / 255) * Math.max(lum / 180, 0.3) * 255);
      pixels[i] = 255; pixels[i+1] = 255; pixels[i+2] = 255;
      pixels[i+3] = Math.min(255, tplAlpha);
    }
  }
  return encodePNG(SIZE, SIZE, pixels);
}

// ── Fallback: generated icon (purple gradient, no download) ───────────────────
function makeFallbackAppIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const cx = size / 2, r = size * 0.45;
  const sw = size * 0.115, left = size * 0.21, right = size * 0.79;
  const top = size * 0.20, bot = size * 0.80;

  function distSeg(px, py, x1, y1, x2, y2) {
    const dx = x2-x1, dy = y2-y1, len2 = dx*dx+dy*dy;
    if (!len2) return Math.hypot(px-x1, py-y1);
    const t = Math.max(0, Math.min(1, ((px-x1)*dx+(py-y1)*dy)/len2));
    return Math.hypot(px-(x1+t*dx), py-(y1+t*dy));
  }
  function inN(x, y) {
    if (x>=left&&x<=left+sw&&y>=top&&y<=bot) return true;
    if (x>=right-sw&&x<=right&&y>=top&&y<=bot) return true;
    return distSeg(x,y,left+sw,top,right-sw,bot)<sw*0.52;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dist = Math.hypot(x - cx, y - cx);
      if (dist > r) { pixels[i+3]=0; continue; }
      const a = dist > r-1.5 ? Math.round((r-dist)/1.5*255) : 255;
      const t = dist/r;
      const bg = [Math.round(109-t*30), Math.round(40-t*10), Math.round(217-t*40)];
      if (inN(x,y)&&dist<r-4) {
        pixels[i]=255;pixels[i+1]=255;pixels[i+2]=255;pixels[i+3]=a;
      } else {
        pixels[i]=bg[0];pixels[i+1]=bg[1];pixels[i+2]=bg[2];pixels[i+3]=a;
      }
    }
  }
  return encodePNG(size, size, pixels);
}

function makeSimpleTrayFallback(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const cx = size/2, r = size*0.38;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y*size+x)*4, d = Math.hypot(x-cx, y-cx);
    if (d > r) { pixels[i+3]=0; continue; }
    const a = d > r-1.5 ? Math.round((r-d)/1.5*255) : 255;
    pixels[i]=255;pixels[i+1]=255;pixels[i+2]=255;pixels[i+3]=a;
  }
  return encodePNG(size, size, pixels);
}

// ── HTTP fetch helper ──────────────────────────────────────────────────────────
function fetchBuffer(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'OIDesktop-icon-fetcher/1.0' } }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && redirects > 0) {
        return fetchBuffer(res.headers.location, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  ()  => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Candidate URLs (highest-res first) ────────────────────────────────────────
const ICON_URLS = [
  'https://raw.githubusercontent.com/open-webui/open-webui/main/static/favicon.png',
  // SVG-derived PNG sometimes published separately:
  'https://raw.githubusercontent.com/open-webui/open-webui/main/static/logo.png',
];

// ── Main ───────────────────────────────────────────────────────────────────────
(async () => {
  const assetsDir = path.join(__dirname, '..', 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });

  const appIconPath  = path.join(assetsDir, 'icon.png');
  const trayIconPath = path.join(assetsDir, 'tray-iconTemplate.png');

  let srcImg = null;

  for (const url of ICON_URLS) {
    try {
      process.stdout.write(`  Fetching ${url} … `);
      const buf = await fetchBuffer(url);
      srcImg = decodePNG(buf);
      console.log(`ok (${srcImg.width}×${srcImg.height})`);
      break;
    } catch (e) {
      console.log(`failed: ${e.message}`);
    }
  }

  if (srcImg) {
    fs.writeFileSync(appIconPath,  makeAppIcon(srcImg));
    console.log('✓ Generated assets/icon.png (512×512, Open WebUI branding)');
    fs.writeFileSync(trayIconPath, makeTrayIcon(srcImg));
    console.log('✓ Generated assets/tray-iconTemplate.png (22×22 template)');
  } else {
    console.log('  No download succeeded — using generated fallback icons.');
    fs.writeFileSync(appIconPath,  makeAppIcon512Fallback());
    fs.writeFileSync(trayIconPath, makeSimpleTrayFallback(22));
    console.log('✓ Generated fallback icons.');
  }
})().catch(e => { console.error('Icon generation failed:', e.message); });

function makeAppIcon512Fallback() { return makeFallbackAppIcon(512); }
