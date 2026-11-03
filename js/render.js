'use strict';
/* =====================================================================
   CITY.RA — render.js
   Grid-free terrain (bilinear-blended, hillshaded, textured chunks
   cached with LRU), roads, rails, bridges, trees, decals; entities,
   aircraft shadows, projectiles, particles, fog of war, night lighting,
   weather, placement ghost, selection overlays and the minimap.
   ===================================================================== */

const PALETTES = {
  summer: ['#1a4765', '#2a6c8e', '#c8b282', '#587838', '#365626', '#c6a466', '#766e64', '#86823e', '#82807a', '#4e6236'],
  autumn: ['#1a4765', '#2a6c8e', '#c8b282', '#76723a', '#684e24', '#c6a466', '#766e64', '#947e42', '#82807a', '#586034'],
  winter: ['#20445c', '#467a94', '#d6d2c8', '#dce2e4', '#b8c4c2', '#d6d0c0', '#9e9da0', '#d2d6d4', '#a4a6a4', '#c0c8c6'],
  dry:    ['#1a4765', '#2a6c8e', '#d0ba8a', '#868446', '#546630', '#cca868', '#7e7466', '#9e8e4c', '#88867e', '#646c42'],
};
const TREE_COL = { summer: ['#2a4a1e', '#3a6428', '#487630', '#548238'], autumn: ['#8a4a1e', '#b7782a', '#6a5a26', '#9a3a20'], winter: ['#6a756e', '#e8eeee', '#9aa6a0'], dry: ['#4f5f2a', '#6a7034', '#3c4a22'] };

// soldier positions inside a squad (metres, x forward), by squad size
const INF_FORM = [[0, 0], [0, 0], [0.8, -1.1, -0.8, 1.1], [1.4, 0, -0.9, -1.8, -0.9, 1.8], [1.6, 0, 0, -2, 0, 2, -1.8, 0], [1.6, 0, 0.2, -2.2, 0.2, 2.2, -1.8, -1, -1.8, 1]];
// drilled units (d.form = [ranks, files, file spacing m, rank spacing m]) stand in ranks facing forward
function formOf(d) {
  if (d._form) return d._form;
  if (!d.form) return (d._form = INF_FORM[Math.min(d.figs || 1, INF_FORM.length - 1)]);
  const [ranks, files, sx, sy] = d.form, F = [];
  for (let r = 0; r < ranks; r++) for (let f = 0; f < files; f++) F.push((ranks - 1) * sy / 2 - r * sy + (r % 2) * 0.15, (f - (files - 1) / 2) * sx + (r % 2 ? sx * 0.25 : 0));
  return (d._form = F);
}
const Render = {
  CH: 16, chunks: new Map(), order: [], maxChunks: 90, shake: 0, flash: 0, genBudget: 2,
  init(canvas) {
    this.cv = canvas; this.x = canvas.getContext('2d');
    this.fog = null; this.light = U.canvas(10, 10); this.lx = this.light.getContext('2d');
    this.grade = null; this.vig = null; this.lightValid = false; this.lightTick = 0;
    this.weather = []; for (let i = 0; i < 420; i++) this.weather.push({ x: Math.random(), y: Math.random(), s: Math.random() });
  },
  setMap(M) {
    this.terrDirty = true; this.terrT = null;
    this.M = M; this.chunks.clear(); this.order = [];
    this.pal = PALETTES[M.season] || PALETTES.summer;
    const N = M.w * M.h; this.tc = new Float32Array(N * 3); this.sh = new Float32Array(N);
    this.recolor(0, 0, M.w, M.h);
    this.fw = Math.max(1, Math.ceil(M.w / 2)); this.fh = Math.max(1, Math.ceil(M.h / 2));
    this.fog = U.canvas(this.fw, this.fh); this.fx = this.fog.getContext('2d'); this.fogImg = this.fx.createImageData(this.fw, this.fh);
    // minimap buffer capped at 256 px on the long side: full-res on a 1536 map
    // costs 2.3 M px per rebuild, this costs 65 k and looks identical at minimap size
    const msc = Math.min(1, 256 / Math.max(M.w, M.h));
    this.mw = Math.max(1, Math.round(M.w * msc)); this.mh = Math.max(1, Math.round(M.h * msc));
    this.mini = U.canvas(this.mw, this.mh); this.miniDirty = true;
    this.noise = new Noise(M.seed + 11);
    this.overview = null;
    if (!this.waterPat) this.buildWater();
  },
  buildWater() {
    const c = U.canvas(256, 256), g = c.getContext('2d'), n = new Noise(5);
    const img = g.createImageData(256, 256);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const v = n.fbm(x / 32, y / 18, 3), w = Math.sin((x + v * 60) / 9 + Math.sin(y / 23) * 2) * 0.5 + 0.5, o = (y * 256 + x) * 4;
      const hi = Math.pow(w, 8) * 70 * v;
      img.data[o] = 20 + v * 22 + hi; img.data[o + 1] = 62 + v * 30 + hi; img.data[o + 2] = 88 + v * 30 + hi * 0.9; img.data[o + 3] = 255;
    }
    // make the tile seamless by mirroring
    g.putImageData(img, 0, 0); const c2 = U.canvas(512, 512), g2 = c2.getContext('2d');
    g2.drawImage(c, 0, 0); g2.save(); g2.scale(-1, 1); g2.drawImage(c, -512, 0); g2.restore(); g2.save(); g2.scale(1, -1); g2.drawImage(c, 0, -512); g2.restore(); g2.save(); g2.scale(-1, -1); g2.drawImage(c, -512, -512); g2.restore();
    this.waterPat = c2;
  },
  treeKind(i, h) {
    const M = this.M, cl = M.cl ? CLIMATES[M.cl[i]] : (M.type === 'desert' ? 'arid' : M.type === 'highlands' ? 'boreal' : M.type === 'archipelago' ? 'savanna' : 'temperate');
    const r = hash2(i, h, 77);
    if (cl === 'polar' || cl === 'boreal') return r < 0.85 ? 'conifer' : 'broad';
    if (cl === 'arid') return r < 0.6 ? 'palm' : 'broad';
    if (cl === 'tropical') return r < 0.3 ? 'palm' : 'broad';
    if (cl === 'savanna') return r < 0.2 ? 'palm' : 'broad';
    if (M.hgt[i] > 0.64) return r < 0.75 ? 'conifer' : 'broad';
    return r < 0.22 ? 'conifer' : 'broad';
  },
  recolor(x0, y0, x1, y1) {
    const M = this.M, W = M.w, cols = this.pal.map((c) => COL.rgb(c));
    for (let y = Math.max(0, y0); y < Math.min(M.h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
      const i = y * W + x, t = M.terr[i], c = cols[t];
      let k = 1;
      if (t === TER.DEEP) k = 0.72 + (M.hgt[i] / SEA) * 0.42;
      else if (t === TER.SHALLOW) k = 0.88 + (M.hgt[i] / SEA) * 0.22;
      else k = 0.9 + (M.hgt[i] - SEA) * 0.28;
      // Richer subtle color shifts across biomes & micro-elevation
      const micro = (hash2(x, y, M.seed + 19) - 0.5) * 0.08;
      const ore = M.res[i] === 1 ? 0.78 : 1;
      this.tc[i * 3] = U.clamp(c[0] * (k + micro) * ore, 0, 255);
      this.tc[i * 3 + 1] = U.clamp(c[1] * (k + micro * 0.8) * ore, 0, 255);
      this.tc[i * 3 + 2] = U.clamp(c[2] * (k - micro * 0.5) * (M.res[i] === 1 ? 0.86 : 1), 0, 255);
      const hx = M.hgt[Math.min(W - 1, x + 1) + y * W] - M.hgt[Math.max(0, x - 1) + y * W];
      const hy = M.hgt[x + Math.min(M.h - 1, y + 1) * W] - M.hgt[x + Math.max(0, y - 1) * W];
      // Directional NW sun hillshading with ambient occlusion in steep slopes
      const slope = Math.hypot(hx, hy);
      this.sh[i] = TER_INFO[t].water ? 1 : U.clamp(1 - (hx * 2.1 + hy * 2.5) - slope * 0.45, 0.64, 1.3);
    }
  },
  invalidateTiles(list) { this.overview = null; const W = this.M.w; for (const i of list) this.invalidate(i % W, (i / W) | 0); this.miniDirty = true; },
  invalidate(tx, ty, r = 1) {
    const C = this.CH;
    for (let cy = Math.floor((ty - r) / C); cy <= Math.floor((ty + r) / C); cy++) for (let cx = Math.floor((tx - r) / C); cx <= Math.floor((tx + r) / C); cx++) this.chunks.delete(cx + ',' + cy);
  },
  clearTrees(tx, ty, w, h) { this.invalidate(tx + w / 2, ty + h / 2, Math.max(w, h)); },
  stampDecal(x, y, r, kind) {
    const C = this.CH * TILE;
    for (let cy = Math.floor((y - r) / C); cy <= Math.floor((y + r) / C); cy++) for (let cx = Math.floor((x - r) / C); cx <= Math.floor((x + r) / C); cx++) {
      const ch = this.chunks.get(cx + ',' + cy); if (!ch) continue;
      const g = ch.getContext('2d'); g.save(); g.translate(-cx * C, -cy * C); Decals.draw(g, x, y, r, kind); g.restore();
    }
  },

  chunk(cx, cy, allowGen) {
    const k = cx + ',' + cy; let c = this.chunks.get(k);
    if (c) return c;
    if (!allowGen || this.genLeft <= 0) return null;
    this.genLeft--;
    c = this.genChunk(cx, cy); this.chunks.set(k, c); this.order.push(k);
    if (this.order.length > this.maxChunks) { const old = this.order.shift(); if (old !== k) this.chunks.delete(old); }
    return c;
  },
  genChunk(cx, cy) {
    const M = this.M, W = M.w, H = M.h, C = this.CH, S = C * TILE, R = 2, P = S / R;
    const cv = U.canvas(S, S), g = cv.getContext('2d');
    if (!this.tmpC) { this.tmpC = U.canvas(P, P); this.tmpX = this.tmpC.getContext('2d'); }
    const img = this.tmpX.createImageData(P, P), D = img.data, tc = this.tc, sh = this.sh, nz = this.noise, seed = M.seed;
    const season = M.season, ctry = M.ctry, cid = ctry ? new Uint8Array(P * P) : null;
    for (let py = 0; py < P; py++) {
      const wy = cy * S + py * R + 1, fy = wy / TILE - 0.5, ty0 = Math.max(0, Math.min(H - 1, Math.floor(fy))), ty1 = Math.min(H - 1, ty0 + 1), ky = U.clamp(fy - ty0, 0, 1);
      for (let px = 0; px < P; px++) {
        const wx = cx * S + px * R + 1, fx = wx / TILE - 0.5;
        const tx0 = Math.max(0, Math.min(W - 1, Math.floor(fx))), tx1 = Math.min(W - 1, tx0 + 1), kx = U.clamp(fx - tx0, 0, 1);
        const a = ty0 * W + tx0, b = ty0 * W + tx1, c = ty1 * W + tx0, d = ty1 * W + tx1;
        // jitter blend weights for organic borders
        const j = (nz.v(wx / 23, wy / 23) - 0.5) * 0.5;
        const ux = U.clamp(kx + j, 0, 1), uy = U.clamp(ky - j, 0, 1);
        const w00 = (1 - ux) * (1 - uy), w10 = ux * (1 - uy), w01 = (1 - ux) * uy, w11 = ux * uy;
        let r = tc[a * 3] * w00 + tc[b * 3] * w10 + tc[c * 3] * w01 + tc[d * 3] * w11;
        let gg = tc[a * 3 + 1] * w00 + tc[b * 3 + 1] * w10 + tc[c * 3 + 1] * w01 + tc[d * 3 + 1] * w11;
        let bb = tc[a * 3 + 2] * w00 + tc[b * 3 + 2] * w10 + tc[c * 3 + 2] * w01 + tc[d * 3 + 2] * w11;
        const s = sh[a] * w00 + sh[b] * w10 + sh[c] * w01 + sh[d] * w11;
        const ti = (ux < 0.5 ? (uy < 0.5 ? a : c) : uy < 0.5 ? b : d), t = M.terr[ti];
        const gFine = (hash2(wx, wy, seed + 3) - 0.5) * 0.09;
        const gMed = (hash2(wx >> 1, wy >> 1, seed) - 0.5) * 0.08 + (nz.v(wx / 11, wy / 11) - 0.5) * 0.11;
        const gMacro = (nz.v(wx / 38, wy / 38) - 0.5) * 0.12;
        let n = gFine + gMed + gMacro;
        let dr = 0, dg = 0, db = 0;
        if (t === TER.DEEP || t === TER.SHALLOW) {
          n = (nz.v(wx / 14 + wy / 40, wy / 6) - 0.5) * 0.09;
        } else if (t === TER.SAND || t === TER.DESERT) {
          const ripple = Math.sin(wx / 6.5 + wy / 19 + nz.v(wx / 26, wy / 26) * 7) * 0.055;
          n += ripple;
          dr += ripple * 28; dg += ripple * 18;
        } else if (t === TER.ROCK) {
          const strata = Math.sin((wx * 0.7 + wy * 1.3) / 5.5 + nz.v(wx / 18, wy / 18) * 5) * 0.09;
          const crack = nz.v(wx / 4.5, wy / 4.5) > 0.72 ? -0.18 : 0;
          n += strata + crack + (nz.v(wx / 14, wy / 14) - 0.5) * 0.14;
          if (strata > 0.03) { dr += 8; dg += 6; db += 4; }
        } else if (t === TER.FOREST || t === TER.GRASS) {
          const lush = nz.v(wx / 18, wy / 18) - 0.5;
          const blade = (nz.v(wx / 3.5, wy / 3.5) - 0.5) * 0.11;
          n += blade;
          if (season !== 'winter') {
            dr -= lush * 16; dg += lush * 22; db -= lush * 12;
            if (t === TER.FOREST) { dr -= 5; dg -= 3; }
          }
        } else if (t === TER.MUD) {
          const wet = nz.v(wx / 9, wy / 9);
          n += (wet - 0.5) * 0.14;
          if (wet > 0.62) { dr -= 10; dg -= 8; db -= 4; }
        } else if (t === TER.URBAN) {
          const tileGrid = ((wx & 15) === 0 || (wy & 15) === 0) ? -0.06 : 0;
          n = (hash2(wx >> 2, wy >> 2, seed) - 0.5) * 0.05 + gFine * 0.5 + tileGrid;
        }
        if (season === 'winter' && t !== TER.DEEP && t !== TER.SHALLOW) n += (nz.v(wx / 6, wy / 6) - 0.5) * 0.06;
        const k = s * (1 + n), o = (py * P + px) * 4;
        D[o] = U.clamp(r * k + dr, 0, 255); D[o + 1] = U.clamp(gg * k + dg, 0, 255); D[o + 2] = U.clamp(bb * k + db, 0, 255); D[o + 3] = t === TER.DEEP ? 175 : t === TER.SHALLOW ? 205 : 255;
        if (cid) {
          const ia = ctry[a], ib = ctry[b], ic = ctry[c], id2 = ctry[d];
          if (ia === ib && ia === ic && ia === id2) cid[py * P + px] = ia;
          else {
            const sa = w00 + (ib === ia ? w10 : 0) + (ic === ia ? w01 : 0) + (id2 === ia ? w11 : 0), sb = w10 + (ia === ib ? w00 : 0) + (ic === ib ? w01 : 0) + (id2 === ib ? w11 : 0), sc = w01 + (ia === ic ? w00 : 0) + (ib === ic ? w10 : 0) + (id2 === ic ? w11 : 0), sd = w11 + (ia === id2 ? w00 : 0) + (ib === id2 ? w10 : 0) + (ic === id2 ? w01 : 0);
            const mx = Math.max(sa, sb, sc, sd); cid[py * P + px] = mx === sa ? ia : mx === sb ? ib : mx === sc ? ic : id2;
          }
        }
      }
    }
    if (cid) {
      for (let py = 0; py < P - 1; py++) for (let px = 0; px < P - 1; px++) {
        const i = py * P + px, v = cid[i], r2 = cid[i + 1], dn = cid[i + P];
        if (!v) { if ((r2 && r2 !== v) || (dn && dn !== v)) { /* sea side of a maritime border */ } continue; }
        if ((r2 && r2 !== v) || (dn && dn !== v)) for (const j of [i, i + 1, i + P]) { const o = j * 4; D[o] = D[o] * 0.4 + 214 * 0.6; D[o + 1] = D[o + 1] * 0.4 + 92 * 0.6; D[o + 2] = D[o + 2] * 0.4 + 70 * 0.6; }
      }
    }
    this.tmpX.putImageData(img, 0, 0); g.imageSmoothingEnabled = true; g.drawImage(this.tmpC, 0, 0, S, S);
    // vector overlays in world coordinates
    g.save(); g.translate(-cx * S, -cy * S);
    const x0 = cx * C - 1, y0 = cy * C - 1, x1 = cx * C + C + 1, y1 = cy * C + C + 1;
    this.drawDetail(g, x0, y0, x1, y1);
    this.drawShore(g, x0, y0, x1, y1);
    this.drawFarms(g, x0, y0, x1, y1);
    this.drawProps(g, cx * S - 64, cy * S - 64, cx * S + S + 64, cy * S + S + 64);
    this.drawRes(g, x0, y0, x1, y1);
    this.drawRoads(g, x0, y0, x1, y1);
    this.drawRail(g, x0, y0, x1, y1);
    this.drawBridges(g, x0, y0, x1, y1);
    for (const cr of M.craters) if (cr[0] > cx * S - 60 && cr[0] < cx * S + S + 60 && cr[1] > cy * S - 60 && cr[1] < cy * S + S + 60) Decals.draw(g, cr[0], cr[1], cr[2], cr[3]);
    this.drawTrees(g, x0, y0, x1, y1);
    this.drawPoles(g, cx * S - 40, cy * S - 40, cx * S + S + 40, cy * S + S + 40);
    g.restore();
    return cv;
  },
  inb(x, y) { return x >= 0 && y >= 0 && x < this.M.w && y < this.M.h; },
  drawDetail(g, x0, y0, x1, y1) {
    const M = this.M, W = M.w, winter = M.season === 'winter', autumn = M.season === 'autumn';
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (!this.inb(x, y)) continue; const i = y * W + x, t = M.terr[i];
      if (M.road[i] || M.occ[i]) {
        if (t === TER.URBAN && !M.road[i]) {
          // Subtle concrete plaza slabs & drainage grates around urban footprints
          g.strokeStyle = 'rgba(40,42,40,0.14)'; g.lineWidth = 0.7;
          g.strokeRect(x * TILE + 2, y * TILE + 2, TILE - 4, TILE - 4);
        }
        continue;
      }
      if (t === TER.URBAN) {
        // Realistic urban pavement blocks, curb seams, and manhole/park details
        g.fillStyle = winter ? 'rgba(195,200,202,0.35)' : 'rgba(122,120,114,0.32)';
        g.fillRect(x * TILE + 1, y * TILE + 1, TILE - 2, TILE - 2);
        g.strokeStyle = 'rgba(50,50,48,0.22)'; g.lineWidth = 0.8;
        g.beginPath();
        g.moveTo(x * TILE, y * TILE + 16); g.lineTo(x * TILE + TILE, y * TILE + 16);
        g.moveTo(x * TILE + 16, y * TILE); g.lineTo(x * TILE + 16, y * TILE + TILE);
        g.stroke();
        if (hash2(i, 4, 19) < 0.25) {
          circ(g, x * TILE + 8, y * TILE + 8, 2.2, winter ? '#b8c4c2' : '#52683a');
        }
      } else if (t === TER.GRASS || t === TER.FOREST || t === TER.MUD || t === TER.FARM) {
        // Multi-blade grass tufts & wildflowers/clover patches
        const cnt = t === TER.FOREST ? 11 : t === TER.GRASS ? 9 : 5;
        for (let k = 0; k < cnt; k++) {
          const px = x * TILE + hash2(i, k, 1) * TILE, py = y * TILE + hash2(i, k, 2) * TILE, l = hash2(i, k, 3) > 0.45;
          g.strokeStyle = winter
            ? (l ? 'rgba(255,255,255,0.42)' : 'rgba(130,142,148,0.3)')
            : autumn
            ? (l ? 'rgba(205,175,95,0.3)' : 'rgba(65,52,22,0.28)')
            : (l ? 'rgba(175,208,105,0.28)' : 'rgba(24,48,14,0.28)');
          g.lineWidth = 0.9;
          const sway = (hash2(i, k, 4) - 0.5) * 3.5;
          g.beginPath();
          g.moveTo(px - 1, py); g.lineTo(px - 1 + sway * 0.7, py - 2.6);
          g.moveTo(px, py); g.lineTo(px + sway, py - 3.2);
          g.moveTo(px + 1, py); g.lineTo(px + 1 + sway * 1.1, py - 2.3);
          g.stroke();
        }
        // Shrubs & ground cover
        if (hash2(i, 9, 5) < 0.14 && t !== TER.FARM) {
          const px = x * TILE + hash2(i, 9, 6) * 24 + 4, py = y * TILE + hash2(i, 9, 7) * 24 + 4;
          const sr = 2.2 + hash2(i, 9, 8) * 1.8;
          circ(g, px + 1.2, py + 1.4, sr, 'rgba(0,0,0,0.26)');
          circ(g, px, py, sr, winter ? '#c8d2d2' : autumn ? '#7c5c28' : '#3f6229');
          circ(g, px - sr * 0.3, py - sr * 0.3, sr * 0.65, winter ? '#e2ecec' : autumn ? '#9e7632' : '#58823b');
        }
        // Occasional small field stones or wildflowers
        if (!winter && t === TER.GRASS && hash2(i, 12, 8) < 0.08) {
          const fx = x * TILE + hash2(i, 13, 8) * 26 + 3, fy = y * TILE + hash2(i, 14, 8) * 26 + 3;
          circ(g, fx, fy, 1.1, hash2(i, 15, 8) > 0.5 ? 'rgba(240,215,90,0.65)' : 'rgba(235,235,245,0.6)');
        }
      } else if (t === TER.DESERT || t === TER.SAND) {
        for (let k = 0; k < 6; k++) {
          const px = x * TILE + hash2(i, k, 1) * TILE, py = y * TILE + hash2(i, k, 2) * TILE;
          g.fillStyle = hash2(i, k, 3) > 0.5 ? 'rgba(255,242,212,0.32)' : 'rgba(98,76,42,0.26)';
          g.fillRect(px, py, 1.8, 1.3);
        }
        if (hash2(i, 7, 11) < 0.09) {
          // Dry desert scrub / sandstone pebble cluster
          const px = x * TILE + hash2(i, 7, 12) * 24 + 4, py = y * TILE + hash2(i, 7, 13) * 24 + 4;
          circ(g, px + 1, py + 1, 2.1, 'rgba(0,0,0,0.22)');
          circ(g, px, py, 2.0, t === TER.DESERT ? '#7a6c44' : '#9c8c68');
        }
      } else if (t === TER.ROCK) {
        for (let k = 0; k < 4; k++) {
          const px = x * TILE + hash2(i, k, 1) * TILE, py = y * TILE + hash2(i, k, 2) * TILE, r = 2.2 + hash2(i, k, 3) * 4.5;
          // Drop shadow under boulder
          poly(g, [px - r + 1.5, py + r * 0.5 + 1.5, px - r * 0.3 + 1.5, py - r * 0.8 + 1.5, px + r + 1.5, py - r * 0.2 + 1.5, px + r * 0.6 + 1.5, py + r * 0.7 + 1.5], 'rgba(0,0,0,0.28)');
          // Faceted rock face
          poly(g, [px - r, py + r * 0.5, px - r * 0.3, py - r * 0.8, px + r, py - r * 0.2, px + r * 0.6, py + r * 0.7], winter ? 'rgba(225,232,235,0.6)' : 'rgba(138,130,120,0.55)', 'rgba(36,32,28,0.4)', 0.7);
          // Highlight facet
          poly(g, [px - r * 0.8, py + r * 0.2, px - r * 0.3, py - r * 0.8, px + r * 0.3, py - r * 0.1], winter ? 'rgba(250,252,255,0.45)' : 'rgba(185,178,166,0.38)');
        }
      } else if (t === TER.SHALLOW && hash2(i, 1, 9) < 0.35) {
        g.strokeStyle = 'rgba(235,248,252,0.18)'; g.lineWidth = 1; g.beginPath(); const px = x * TILE + 4, py = y * TILE + hash2(i, 1, 2) * 28; g.moveTo(px, py); g.quadraticCurveTo(px + 12, py - 3, px + 24, py); g.stroke();
      }
    }
  },
  drawShore(g, x0, y0, x1, y1) {
    const M = this.M, W = M.w;
    g.strokeStyle = M.season === 'winter' ? 'rgba(235,245,250,0.5)' : 'rgba(230,240,240,0.28)'; g.lineWidth = 2.5;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (!this.inb(x, y)) continue; const i = y * W + x; if (!TER_INFO[M.terr[i]].water) continue;
      for (let k = 0; k < 4; k++) { const xx = x + DX8[k], yy = y + DY8[k]; if (!this.inb(xx, yy) || TER_INFO[M.terr[yy * W + xx]].water) continue;
        const cxp = (x + 0.5) * TILE + DX8[k] * 13, cyp = (y + 0.5) * TILE + DY8[k] * 13;
        g.beginPath(); if (DX8[k]) { g.moveTo(cxp, cyp - 15); g.quadraticCurveTo(cxp + DX8[k] * 2, cyp, cxp, cyp + 15); } else { g.moveTo(cxp - 15, cyp); g.quadraticCurveTo(cxp, cyp + DY8[k] * 2, cxp + 15, cyp); } g.stroke(); }
    }
  },
  drawFarms(g, x0, y0, x1, y1) {
    const M = this.M, W = M.w;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (!this.inb(x, y) || M.terr[y * W + x] !== TER.FARM) continue;
      const patch = hash2(x >> 2, y >> 2, M.seed), vert = patch > 0.5;
      const cropCol = M.season === 'winter'
        ? 'rgba(175,180,172,0.35)'
        : patch > 0.75
        ? 'rgba(186,158,64,0.32)'
        : patch > 0.35
        ? 'rgba(84,116,46,0.32)'
        : 'rgba(112,92,50,0.32)';
      g.fillStyle = cropCol;
      g.fillRect(x * TILE + 1, y * TILE + 1, TILE - 2, TILE - 2);
      g.strokeStyle = M.season === 'winter' ? 'rgba(140,142,135,0.38)' : 'rgba(58,48,24,0.38)'; g.lineWidth = 1.6;
      for (let k = 3; k < TILE; k += 5) { g.beginPath(); if (vert) { g.moveTo(x * TILE + k, y * TILE + 1); g.lineTo(x * TILE + k, y * TILE + TILE - 1); } else { g.moveTo(x * TILE + 1, y * TILE + k); g.lineTo(x * TILE + TILE - 1, y * TILE + k); } g.stroke(); }
    }
  },
  drawRes(g, x0, y0, x1, y1) {
    const M = this.M, W = M.w;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (!this.inb(x, y)) continue; const i = y * W + x;
      if (M.res[i] === 1) { for (let k = 0; k < 4; k++) { const h = hash2(i, k, 3); circ(g, x * TILE + 6 + h * 20, y * TILE + 6 + hash2(i, k, 9) * 20, 3 + h * 3, k % 2 ? '#5a5e66' : '#7c818a'); } }
    }
  },
  roadTile(i) { const r = this.M.road[i]; return r && r !== 4; },
  drawRoads(g, x0, y0, x1, y1) {
    const M = this.M, W = M.w, segs = [];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (!this.inb(x, y)) continue; const i = y * W + x; if (!this.roadTile(i) || M.road[i] === 3) continue;
      const cxp = (x + 0.5) * TILE, cyp = (y + 0.5) * TILE;
      let n = 0;
      for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) { const xx = x + dx, yy = y + dy; if (this.inb(xx, yy) && this.roadTile(yy * W + xx)) { n++; if (dx > 0 || dy > 0) segs.push([cxp, cyp, cxp + dx * TILE, cyp + dy * TILE, M.road[i]]); } }
      for (const [dx, dy] of [[1, 1], [-1, 1]]) { const xx = x + dx, yy = y + dy; if (this.inb(xx, yy) && this.roadTile(yy * W + xx) && !this.roadTile(y * W + xx) && !this.roadTile(yy * W + x)) segs.push([cxp, cyp, cxp + dx * TILE, cyp + dy * TILE, M.road[i]]); }
      if (n === 0) segs.push([cxp - 1, cyp, cxp + 1, cyp, M.road[i]]);
    }
    const winter = M.season === 'winter';
    if (Era.cur) { // 1805: packed earth lanes, cobbled streets in town, no markings
      const pass2 = (w, col, filt) => { g.strokeStyle = col; g.lineWidth = w; g.lineCap = 'round'; g.beginPath(); for (const s of segs) if (!filt || filt(s)) { g.moveTo(s[0], s[1]); g.lineTo(s[2], s[3]); } g.stroke(); };
      const town = (s) => M.terr[tileOf(s[0], s[1])] === TER.URBAN;
      pass2(22, 'rgba(60,44,24,0.35)'); pass2(18, winter ? '#9a9286' : '#8a7452'); pass2(13, winter ? '#aaa296' : '#a08660');
      pass2(18, winter ? '#8e8a84' : '#7c7466', town); g.setLineDash([2, 3]); pass2(14, 'rgba(50,44,36,0.25)', town); g.setLineDash([]);
      return;
    }
    const pass = (w, col, filt) => { g.strokeStyle = col; g.lineWidth = w; g.lineCap = 'round'; g.beginPath(); for (const s of segs) if (!filt || filt(s)) { g.moveTo(s[0], s[1]); g.lineTo(s[2], s[3]); } g.stroke(); };
    // Sidewalks & curbs on urban streets
    pass(28, 'rgba(25,25,24,0.4)', (s) => s[4] === 1 && M.terr[tileOf(s[0], s[1])] === TER.URBAN);
    pass(26, winter ? '#c2c4c0' : '#b2aba0', (s) => s[4] === 1 && M.terr[tileOf(s[0], s[1])] === TER.URBAN);
    // Roadbed gravel shoulder & dark asphalt surface
    pass(22, 'rgba(32,30,26,0.48)');
    pass(19.5, winter ? '#585c60' : '#3d4043');
    pass(16, winter ? '#62666a' : '#46494d');
    // Edge lane lines on highways & center dashes on all paved roads
    pass(17.5, 'rgba(215,212,198,0.22)', (s) => s[4] === 2);
    pass(15.5, winter ? '#62666a' : '#46494d', (s) => s[4] === 2);
    g.setLineDash([6, 7]); pass(1.4, 'rgba(238,212,118,0.68)', (s) => s[4] === 2); g.setLineDash([]);
    g.setLineDash([4, 8]); pass(1.0, 'rgba(220,218,205,0.38)', (s) => s[4] === 1); g.setLineDash([]);
  },
  drawRail(g, x0, y0, x1, y1) {
    const M = this.M, W = M.w;
    g.lineCap = 'butt';
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (!this.inb(x, y)) continue; const i = y * W + x; if (!M.rail[i] || M.rail[i] === 3) continue;
      const cxp = (x + 0.5) * TILE, cyp = (y + 0.5) * TILE;
      for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [-1, 1]]) {
        const xx = x + dx, yy = y + dy; if (!this.inb(xx, yy)) continue; const j = yy * W + xx; if (!M.rail[j] || M.rail[j] === 3) continue;
        if (dx && dy && (M.rail[y * W + xx] || M.rail[yy * W + x])) continue;
        const ex = cxp + dx * TILE, ey = cyp + dy * TILE, a = Math.atan2(ey - cyp, ex - cxp), px = -Math.sin(a), py = Math.cos(a), L = Math.hypot(ex - cxp, ey - cyp);
        g.strokeStyle = '#5a4a3a'; g.lineWidth = 2.5;
        for (let k = 0; k < L; k += 6) { const sx = cxp + Math.cos(a) * k, sy = cyp + Math.sin(a) * k; g.beginPath(); g.moveTo(sx + px * 7, sy + py * 7); g.lineTo(sx - px * 7, sy - py * 7); g.stroke(); }
        g.strokeStyle = '#9a9ea2'; g.lineWidth = 1.6;
        for (const o of [-4, 4]) { g.beginPath(); g.moveTo(cxp + px * o, cyp + py * o); g.lineTo(ex + px * o, ey + py * o); g.stroke(); }
      }
    }
  },
  drawBridges(g, x0, y0, x1, y1) {
    const M = this.M, W = M.w;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (!this.inb(x, y)) continue; const i = y * W + x, r = M.road[i], rl = M.rail[i];
      if (r !== 3 && r !== 4 && rl !== 2 && rl !== 3) continue;
      const broken = r === 4 || rl === 3, X = x * TILE, Y = y * TILE;
      const horiz = (this.inb(x - 1, y) && (M.road[i - 1] || M.rail[i - 1])) || (this.inb(x + 1, y) && (M.road[i + 1] || M.rail[i + 1]));
      g.fillStyle = 'rgba(0,0,0,0.35)'; if (horiz) g.fillRect(X, Y + 4 + 6, TILE, TILE - 8); else g.fillRect(X + 4 + 6, Y, TILE - 8, TILE);
      if (broken) { for (let k = 0; k < 5; k++) fillRR(g, X + hash2(i, k, 1) * 24, Y + hash2(i, k, 2) * 24, 6, 4, 1, '#55524c'); continue; }
      g.fillStyle = Era.cur ? '#a4977a' : '#6d6a64'; if (horiz) g.fillRect(X, Y + 4, TILE, TILE - 8); else g.fillRect(X + 4, Y, TILE - 8, TILE);
      g.fillStyle = Era.cur ? '#8a6a46' : r === 3 ? '#4a4c4e' : '#6a5a48'; if (horiz) g.fillRect(X, Y + 7, TILE, TILE - 14); else g.fillRect(X + 7, Y, TILE - 14, TILE);
      g.strokeStyle = Era.cur ? '#6a4a2a' : '#9b978e'; g.lineWidth = 1.5; g.beginPath(); if (horiz) { g.moveTo(X, Y + 5); g.lineTo(X + TILE, Y + 5); g.moveTo(X, Y + TILE - 5); g.lineTo(X + TILE, Y + TILE - 5); } else { g.moveTo(X + 5, Y); g.lineTo(X + 5, Y + TILE); g.moveTo(X + TILE - 5, Y); g.lineTo(X + TILE - 5, Y + TILE); } g.stroke();
    }
  },
  drawTrees(g, x0, y0, x1, y1) {
    const M = this.M, W = M.w, list = [];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (!this.inb(x, y)) continue; const i = y * W + x, n = M.tree[i]; if (!n || M.occ[i]) continue;
      const cnt = n === 1 ? 1 : n === 2 ? 3 : 4;
      for (let k = 0; k < cnt; k++) list.push([x * TILE + 5 + hash2(i, k, 21) * 22, y * TILE + 5 + hash2(i, k, 22) * 22, (n > 1 ? 0.75 : 0.6) + hash2(i, k, 23) * 0.45, this.treeKind(i, k), (hash2(i, k, 24) * 6) | 0]);
    }
    list.sort((a, b) => a[1] - b[1]);
    for (const t of list) { const sp = SPR.tree(t[3], M.season, t[4]), w = sp.w * t[2], h = sp.h * t[2]; g.drawImage(sp.shadow, t[0] - w / 2 + 4, t[1] - h / 2 + 5, w, h); }
    for (const t of list) { const sp = SPR.tree(t[3], M.season, t[4]), w = sp.w * t[2], h = sp.h * t[2]; g.drawImage(sp.img, t[0] - w / 2, t[1] - h / 2, w, h); }
  },
  drawProps(g, X0, Y0, X1, Y1) {
    for (const p of this.M.props) {
      const x = p.x * TILE, y = p.y * TILE, w = p.w * TILE, h = p.h * TILE;
      if (x > X1 || y > Y1 || x + w < X0 || y + h < Y0) continue;
      if (p.t === 'runway') {
        g.fillStyle = '#4a4c4e'; g.fillRect(x, y + 6, w, h - 12); g.strokeStyle = '#e6e2d6'; g.lineWidth = 2; g.setLineDash([18, 14]);
        g.beginPath(); g.moveTo(x + 20, y + h / 2); g.lineTo(x + w - 20, y + h / 2); g.stroke(); g.setLineDash([]);
        for (let k = 0; k < 6; k++) { g.fillStyle = '#e6e2d6'; g.fillRect(x + 6, y + 12 + k * ((h - 24) / 6), 10, 3); g.fillRect(x + w - 16, y + 12 + k * ((h - 24) / 6), 10, 3); }
      } else if (p.t === 'pier') { g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(x + 4, y + 4, w, h); g.fillStyle = '#8a7656'; g.fillRect(x, y, w, h); }
    }
  },
  drawPoles(g, X0, Y0, X1, Y1) {
    g.lineWidth = 1; g.strokeStyle = 'rgba(30,30,30,0.55)';
    for (const p of this.M.poles) {
      const ax = p[0] * TILE, ay = p[1] * TILE, bx = p[2] * TILE, by = p[3] * TILE;
      if (Math.max(ax, bx) < X0 || Math.min(ax, bx) > X1 || Math.max(ay, by) < Y0 || Math.min(ay, by) > Y1) continue;
      g.beginPath(); g.moveTo(ax, ay - 2); g.quadraticCurveTo((ax + bx) / 2, (ay + by) / 2 + 4, bx, by - 2); g.stroke();
      g.fillStyle = '#3a342c'; g.fillRect(bx - 1.5, by - 1.5, 3, 3);
    }
  },

  /* ---------- main frame ---------- */
  view() {
    const z = G.cam.z, W = this.cv.width / (window.devicePixelRatio || 1), H = this.cv.height / (window.devicePixelRatio || 1);
    return { x0: G.cam.x, y0: G.cam.y, x1: G.cam.x + W / z, y1: G.cam.y + H / z, W, H, z };
  },
  frame() {
    const x = this.x, M = this.M; if (!M) return;
    const dpr = window.devicePixelRatio || 1, v = this.view(), z = v.z;
    FX.vr = v;
    x.setTransform(1, 0, 0, 1, 0, 0); x.fillStyle = '#0b0e10'; x.fillRect(0, 0, this.cv.width, this.cv.height);
    let sx = 0, sy = 0; if (this.shake > 0.3) { sx = (Math.random() - 0.5) * this.shake; sy = (Math.random() - 0.5) * this.shake; this.shake *= 0.9; } else this.shake = 0;
    x.setTransform(z * dpr, 0, 0, z * dpr, (-G.cam.x + sx) * z * dpr, (-G.cam.y + sy) * z * dpr);
    x.imageSmoothingEnabled = true;
    // animated water underlay (shows through translucent water in the terrain)
    if (this.waterPat) {
      if (!this.wpat) this.wpat = x.createPattern(this.waterPat, 'repeat');
      const t = G.time, m = new DOMMatrix(); this.wpat.setTransform(m.translate(t * 6, t * 3));
      x.fillStyle = this.wpat; x.fillRect(v.x0 - 40, v.y0 - 40, v.x1 - v.x0 + 80, v.y1 - v.y0 + 80);
      x.globalAlpha = 0.45; this.wpat.setTransform(new DOMMatrix().translate(-t * 4, t * 5).scale(1.3)); x.fillRect(v.x0 - 40, v.y0 - 40, v.x1 - v.x0 + 80, v.y1 - v.y0 + 80); x.globalAlpha = 1;
    }
    // terrain chunks (or the strategic overview when zoomed far out)
    const S = this.CH * TILE; this.genLeft = this.genBudget;
    if (z < 0.4) { if (!this.overview) this.buildOverview(); x.drawImage(this.overview, 0, 0, M.w * TILE, M.h * TILE); }
    const cx0 = Math.max(0, Math.floor(v.x0 / S)), cy0 = Math.max(0, Math.floor(v.y0 / S)), cx1 = Math.min(Math.ceil(M.w / this.CH) - 1, Math.floor(v.x1 / S)), cy1 = Math.min(Math.ceil(M.h / this.CH) - 1, Math.floor(v.y1 / S));
    const ccx = (cx0 + cx1) / 2, ccy = (cy0 + cy1) / 2, list = [];
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) list.push([cx, cy, Math.hypot(cx - ccx, cy - ccy)]);
    list.sort((a, b) => a[2] - b[2]);
    for (const [cx, cy] of list) {
      if (z < 0.4) break;
      const c = this.chunk(cx, cy, true);
      if (c) x.drawImage(c, cx * S, cy * S, S, S);
      else { if (this.miniDirty && (!this.miniT || G.time - this.miniT > 2)) { this.buildMini(); this.miniT = G.time; } const ks = this.mw / M.w; x.drawImage(this.mini, cx * this.CH * ks, cy * this.CH * ks, this.CH * ks, this.CH * ks, cx * S, cy * S, S, S); }
    }
    Fall.draw(x, v);
    this.drawCountryLabels(x, v);
    this.drawOre(x, v);
    this.drawEntities(x, v);
    this.drawLightPass(x, v); // world-space key light: explosions illuminate terrain and units
    FX.draw(x, v);
    this.drawAir(x, v);
    Strike.draw(x, v);
    this.drawOverlays(x, v);
    // fog
    if (G.cfg.fog) { if (Vis.dirty) this.updateFog(); x.imageSmoothingEnabled = true; x.drawImage(this.fog, 0, 0, M.w * TILE, M.h * TILE); }
    this.drawTerritory(x, v); // above the fog: borders stay readable across the whole front
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    // lighting at half rate: the cached canvas is re-blitted on even frames
    this.lightTick = (this.lightTick || 0) + 1;
    if (this.lightTick % 2 === 1) this.drawLighting(x, v);
    else if (this.lightValid) x.drawImage(this.light, 0, 0, v.W, v.H);
    this.drawWeather(x, v);
    if (G.nuclearWinter) { x.fillStyle = 'rgba(34,30,26,0.3)'; x.fillRect(0, 0, v.W, v.H); }
    this.drawGrade(x, v); // warm/cool split tone, golden-hour key and blue shadow fill
    if (!this.vig || this.vig.w !== v.W || this.vig.h !== v.H) {
      const c = U.canvas(v.W, v.H), g = c.getContext('2d');
      const gr = g.createRadialGradient(v.W / 2, v.H / 2, Math.min(v.W, v.H) * 0.36, v.W / 2, v.H / 2, Math.max(v.W, v.H) * 0.78);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.62, 'rgba(5,8,13,0.07)'); gr.addColorStop(1, 'rgba(3,5,9,0.55)');
      g.fillStyle = gr; g.fillRect(0, 0, v.W, v.H);
      const sun = g.createRadialGradient(v.W * 0.16, v.H * 0.08, 0, v.W * 0.16, v.H * 0.08, Math.max(v.W, v.H) * 0.6);
      sun.addColorStop(0, 'rgba(255,206,140,0.035)'); sun.addColorStop(1, 'rgba(255,206,140,0)');
      g.fillStyle = sun; g.fillRect(0, 0, v.W, v.H);
      this.vig = { c, w: v.W, h: v.H };
    }
    x.drawImage(this.vig.c, 0, 0, v.W, v.H);
    if (this.flash > 0.01) { x.fillStyle = 'rgba(255,248,235,' + this.flash.toFixed(3) + ')'; x.fillRect(0, 0, v.W, v.H); this.flash *= 0.9; }
    UI.drawScreen && UI.drawScreen(x, v);
  },

  /* territory: a tile-resolution tint of every faction's held ground with solid border lines,
     rebuilt when claims change (at most every 2 s, slower on giant maps). Brighter while placing. */
  drawTerritory(x, v) {
    const M = this.M; if (!M.claim) return;
    const N = M.w * M.h, every = N > 1e6 ? 8 : N > 2.5e5 ? 4 : 2;
    if (!this.terrCv || this.terrCv.width !== M.w || this.terrCv.height !== M.h) { this.terrCv = U.canvas(M.w, M.h); this.terrDirty = true; }
    if (this.terrDirty && (!this.terrT || G.time - this.terrT >= every || G.time < this.terrT)) {
      this.terrDirty = false; this.terrT = G.time;
      const g = this.terrCv.getContext('2d'), img = g.createImageData(M.w, M.h), D = img.data, cl = M.claim, W = M.w, H = M.h;
      const cols = G.factions.map((f) => COL.rgb(f.color)), exp = G.cfg.fog && Vis.exp[G.player];
      for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) {
        const i = y * W + xx, o = cl[i]; if (!o || o > cols.length) continue;
        if (exp && !exp[i] && !friendly(G.player, o - 1)) continue; // you always know your own borders
        const edge = (xx > 0 && cl[i - 1] !== o) || (xx < W - 1 && cl[i + 1] !== o) || (y > 0 && cl[i - W] !== o) || (y < H - 1 && cl[i + W] !== o);
        const c = cols[o - 1], k = i * 4; D[k] = c[0]; D[k + 1] = c[1]; D[k + 2] = c[2]; D[k + 3] = edge ? 210 : 46;
      }
      g.putImageData(img, 0, 0);
    }
    const placing = UI.placing && UI.placing();
    x.save(); x.imageSmoothingEnabled = false; x.globalAlpha = placing ? 1 : v.z < 0.4 ? 0.9 : 0.6;
    x.drawImage(this.terrCv, 0, 0, M.w * TILE, M.h * TILE); x.restore();
  },
  drawCountryLabels(x, v) {
    const M = this.M; if (!M.cinfo || !M.cinfo.length) return;
    const z = v.z, a = U.clamp((0.85 - z) / 0.4, 0, 1); if (a <= 0.02) return;
    x.save(); x.textAlign = 'center'; x.textBaseline = 'middle'; x.lineJoin = 'round';
    const fs = 13 / z;
    for (const c of M.cinfo) {
      const wpx = Math.sqrt(c.n) * TILE * z; if (wpx < 70) continue;
      const px = (c.x + 0.5) * TILE, py = (c.y + 0.5) * TILE; if (px < v.x0 - 200 || px > v.x1 + 200 || py < v.y0 - 60 || py > v.y1 + 60) continue;
      const size = fs * U.clamp(wpx / 200, 0.85, 2.2); x.font = '600 ' + size + 'px "Saira Condensed", "IBM Plex Sans", sans-serif';
      x.lineWidth = size * 0.18; x.strokeStyle = 'rgba(8,12,14,' + (0.7 * a).toFixed(2) + ')'; x.fillStyle = 'rgba(244,232,200,' + (0.82 * a).toFixed(2) + ')';
      const t = c.name.toUpperCase().split('').join(String.fromCharCode(8202)); x.strokeText(t, px, py); x.fillText(t, px, py);
    }
    x.restore();
  },
  drawOre(x, v) {
    const M = this.M, W = M.w, ore = SPR.ore();
    const tx0 = Math.max(0, (v.x0 / TILE) | 0), ty0 = Math.max(0, (v.y0 / TILE) | 0), tx1 = Math.min(W - 1, (v.x1 / TILE) | 0), ty1 = Math.min(M.h - 1, (v.y1 / TILE) | 0);
    for (let y = ty0; y <= ty1; y++) for (let xx = tx0; xx <= tx1; xx++) {
      const a = M.ore[y * W + xx]; if (a < 20) continue; const s = 0.45 + Math.min(1, a / 700) * 0.65;
      x.drawImage(ore, xx * TILE + 16 - 16 * s, y * TILE + 16 - 16 * s, 32 * s, 32 * s);
    }
  },
  inView(e, v, pad = 80) { return e.x > v.x0 - pad && e.x < v.x1 + pad && e.y > v.y0 - pad && e.y < v.y1 + pad; },
  seen(e) { return !G.cfg.fog || friendly(G.player, e.owner) || canSee(G.player, e); },
  drawEntities(x, v) {
    const P = G.player, fogOn = G.cfg.fog;
    // civilian buildings
    for (const c of G.civb) {
      if (!this.inView(c, v)) continue;
      if (fogOn && !Vis.explored(P, c.x, c.y)) continue;
      if (c.rubble) { const r = SPR.rubble(c.w, c.h, c.id); x.drawImage(r.img, c.tx * TILE, c.ty * TILE, r.w, r.h); continue; }
      const sp = SPR.civ(c.type, c.v); x.drawImage(sp.img, c.tx * TILE, c.ty * TILE, sp.w, sp.h);
      if (c.ctrl >= 0) { x.fillStyle = fac(c.ctrl).color; x.fillRect(c.tx * TILE + 2, c.ty * TILE + 2, 6, 6); x.strokeStyle = '#000'; x.lineWidth = 1; x.strokeRect(c.tx * TILE + 2, c.ty * TILE + 2, 6, 6); }
      if (c.type === 'derrick' && c.ctrl >= 0) { const a = Math.sin(G.time * 2) * 0.3; line(x, c.x - 8, c.y - 2, c.x + 8 * Math.cos(a), c.y - 2 + 8 * Math.sin(a), '#222', 2.5); }
      if (c.abandoned) { x.fillStyle = 'rgba(40,36,30,0.35)'; x.fillRect(c.tx * TILE, c.ty * TILE, c.w * TILE, c.h * TILE); }
    }
    // military buildings
    for (const b of G.blds) {
      if (!this.inView(b, v)) continue;
      if (fogOn && b.owner !== P && !friendly(P, b.owner) && !Vis.explored(P, b.x, b.y)) continue;
      const fk = fac(b.owner).key, sp = SPR.bld(b.type, fk, b.level);
      if (b.built < 1) { x.globalAlpha = 0.35 + b.built * 0.65; x.save(); x.beginPath(); x.rect(b.tx * TILE, b.ty * TILE + b.h * TILE * (1 - b.built), b.w * TILE + 8, b.h * TILE * b.built + 8); x.clip(); }
      x.drawImage(sp.img, b.tx * TILE, b.ty * TILE, sp.w * (sp.kx || 1), sp.h * (sp.ky || 1));
      if (b.built < 1) { x.restore(); x.globalAlpha = 1; }
      const tur = SPR.bldTurret(b.type === 'hq' && b.level < 2 ? 'none' : b.type, fk, b.level);
      if (tur) { const tk = Math.min(sp.kx || 1, sp.ky || 1); x.save(); x.translate(b.x, b.type === 'radar' ? b.y - 4 * tk : b.y); x.rotate(b.type === 'radar' ? b.dish : b.type === 'power' && Era.cur ? G.time * 0.7 + b.id : b.ta); x.scale(tk, tk); x.drawImage(tur.img, -tur.w / 2, -tur.h / 2, tur.w, tur.h); x.restore(); }
      if (b.type === 'hangar') for (let i = 0; i < 4; i++) { const id = b.docks[i]; if (!id) continue; }
      if (b.upg) { x.fillStyle = 'rgba(217,180,58,0.25)'; x.fillRect(b.tx * TILE, b.ty * TILE, b.w * TILE, b.h * TILE); }
      if (fac(b.owner).lowPower && (b.d.needPower || b.d.prod)) { x.fillStyle = 'rgba(255,200,60,0.9)'; x.font = 'bold 12px sans-serif'; x.fillText('⚡', b.x - 4, b.y + 4); }
      if (b.repairing) { x.strokeStyle = '#7fd38f'; x.lineWidth = 2; x.beginPath(); x.arc(b.x, b.y, 8, 0, Math.PI * 2 * ((G.time * 1.5) % 1)); x.stroke(); }
    }
    // wrecks
    for (const w of G.wrecks) {
      if (!this.inView(w, v) || (fogOn && !Vis.explored(P, w.x, w.y))) continue;
      const wd = UNITS[w.type], wt = wd && wd.robotic && fac(w.owner).aiLab ? fac(w.owner).aiLab.tier : 1;
      const sp = SPR.unit(w.type, fac(w.owner).key, wt), kx = sp.kx || sp.k || 1, ky = sp.ky || sp.k || 1;
      x.save(); x.translate(w.x, w.y); x.rotate(w.a); x.scale(kx, ky); x.globalAlpha = 0.9; x.drawImage(sp.wreck, -sp.w / 2, -sp.h / 2, sp.w, sp.h); x.restore();
    }
    // civilians (sub-pixel when zoomed far out: skipped)
    if (v.z > 0.3) for (const a of G.civs) {
      if (a.dead || !this.inView(a, v)) continue;
      if (fogOn && !Vis.at(P, a.x, a.y)) continue;
      const sp = SPR.civAgent(a.ct, a.v);
      x.save(); x.translate(a.x, a.y);
      if (a.injured) { x.fillStyle = '#c9b9a0'; x.fillRect(-4, -1.5, 8, 3); x.fillStyle = 'rgba(200,40,40,0.7)'; x.fillRect(-1, -4, 2, 2); }
      else if (sp.ped) {
        x.rotate(a.a);
        const fr = (a.pauseT && a.pauseT > 0) ? 0 : 1 + (Math.floor((a.anim || 0)) % 2);
        x.drawImage(sp.img, fr * sp.w * SPR.S, 0, sp.w * SPR.S, sp.h * SPR.S, -sp.w / 2, -sp.h / 2, sp.w, sp.h);
      } else { x.rotate(a.a); x.drawImage(sp.img, -sp.w / 2, -sp.h / 2, sp.w, sp.h); }
      x.restore();
    }
    // ground units (naval first)
    const ground = G.units.filter((u) => !u.dead && !u.inside && u.d.cat !== 'air' && this.inView(u, v) && this.seen(u));
    ground.sort((a, b) => (a.d.cat === 'sea' ? 0 : 1) - (b.d.cat === 'sea' ? 0 : 1));
    for (const u of ground) this.drawUnit(x, u);
    // grounded aircraft
    for (const u of G.units) if (!u.dead && u.d.cat === 'air' && u.alt <= 0.3 && this.inView(u, v) && this.seen(u)) this.drawUnit(x, u);
    // projectiles
    for (const p of G.proj) {
      if (!this.inView(p, v, 20)) continue;
      if (p.type === 'bullet') { const a = Math.atan2(p.ty - p.sy, p.tx - p.sx); line(x, p.x, p.y, p.x - Math.cos(a) * 9, p.y - Math.sin(a) * 9, 'rgba(255,230,150,0.9)', 1.2); }
      else if (p.type === 'shell') { circ(x, p.x, p.y, 1.8, '#ffe2a0'); }
      else if (p.type === 'arc' || p.type === 'arcrocket') { circ(x, p.x + p.z * 0.3, p.y + p.z * 0.3, 2, 'rgba(0,0,0,0.3)'); circ(x, p.x, p.y - p.z, 2.4, p.type === 'arc' ? '#3a3a36' : '#ffd080'); }
      else if (p.type === 'bomb' || p.type === 'crash') { circ(x, p.x, p.y, 2.5, 'rgba(0,0,0,0.3)'); circ(x, p.x, p.y - p.z, p.type === 'bomb' ? 2.6 : 4, '#2a2a28'); }
      else if (p.type === 'torp') { circ(x, p.x, p.y, 2, '#cfe0e8'); }
      else { x.save(); x.translate(p.x, p.y - (p.z || 0)); x.rotate(p.a); x.fillStyle = '#e8e6de'; x.fillRect(-4, -1, 8, 2); x.fillStyle = '#ffb040'; x.fillRect(-6, -1, 2, 2); x.restore(); }
    }
  },
  drawUnit(x, u) {
    const fk = fac(u.owner).key, aiTier = u.d.robotic && fac(u.owner).aiLab ? fac(u.owner).aiLab.tier : 1;
    const sp = SPR.unit(u.type, fk, aiTier), sel = G.sel.includes(u);
    if (sel) { x.strokeStyle = friendly(G.player, u.owner) ? '#9fe0a8' : '#f08070'; x.lineWidth = 1.2; x.beginPath(); x.ellipse(u.x, u.y + 1, u.rad + 3, (u.rad + 3) * 0.8, 0, 0, 6.283); x.stroke(); }
    const k = sp.k || 1, kx = sp.kx || k, ky = sp.ky || k, z = G.cam.z;
    if (sp.inf) {
      // a squad is drawn as its individual soldiers at real size, in a loose wedge
      const n = u.d.figs || 1, fs = 16 * k, step = Math.floor(u.anim * 6), F = formOf(u.d);
      const hidden = u.owner === G.player && u.d.ab && u.d.ab.stealth, frac = u.hp / u.maxHp, alive = Math.max(1, Math.ceil(n * frac - 0.01));
      x.save(); x.translate(u.x, u.y); x.rotate(u.a); if (hidden) x.globalAlpha = 0.5;
      for (let i = 0; i < alive; i++) {
        const ox = F[i * 2] * SCALE.PX_PER_M, oy = F[i * 2 + 1] * SCALE.PX_PER_M, jig = u.moving ? Math.sin(u.anim * 7 + i * 1.7) * 0.6 : 0;
        x.fillStyle = 'rgba(0,0,0,0.26)'; x.beginPath(); x.ellipse(ox + 0.6, oy + 0.8, fs * 0.22, fs * 0.17, 0, 0, 6.283); x.fill();
        x.drawImage(sp.body, (u.supp > 45 ? 3 : u.moving ? 1 + ((step + i) % 2) : 0) * 16 * SPR.S, 0, 16 * SPR.S, 16 * SPR.S, ox + jig - fs / 2, oy - fs / 2, fs, fs);
      }
      x.restore();
      if (z < 0.85) this.marker(x, u, z);
      this.unitHud(x, u, sel);
      return;
    }
    if (sp.shadow && !(u.d.cat === 'sea' && u.d.ab && u.d.ab.submerge)) { x.save(); x.translate(u.x + 2.6, u.y + 3.4); x.rotate(u.a); x.scale(kx, ky); x.drawImage(sp.shadow, -sp.w / 2, -sp.h / 2, sp.w, sp.h); if (sp.turShadow) { x.translate(sp.tox, 0); x.rotate(u.ta - u.a); x.drawImage(sp.turShadow, -sp.tw / 2 + 1, -sp.th / 2 + 1, sp.tw, sp.th); } x.restore(); }
    x.save(); x.translate(u.x, u.y);
    const hidden = u.owner === G.player && ((u.d.ab && u.d.ab.stealth) || (u.d.ab && u.d.ab.submerge && G.time - u.lastFire > 4));
    if (hidden) x.globalAlpha = 0.5;
    {
      x.rotate(u.a); x.scale(kx, ky);
      if (u.d.cat === 'air' && u.alt <= 0.3) x.globalAlpha = 0.95;
      x.drawImage(sp.body, -sp.w / 2, -sp.h / 2, sp.w, sp.h);
      if (sp.tur) { x.translate(sp.tox, 0); x.rotate(u.ta - u.a); x.drawImage(sp.tur, -sp.tw / 2, -sp.th / 2, sp.tw, sp.th); }
    }
    x.restore();
    if (z < 0.7 && u.d.cat !== 'sea') this.marker(x, u, z);
    this.unitHud(x, u, sel);
  },
  // zoomed-out readability: a constant-size faction marker over true-scale units
  marker(x, u, z) {
    const r = (u.d.cat === 'inf' ? 2.6 : 3.4) / z, col = fac(u.owner).color;
    x.fillStyle = col; x.strokeStyle = 'rgba(0,0,0,0.75)'; x.lineWidth = 1 / z;
    if (u.d.cat === 'inf') { x.beginPath(); x.arc(u.x, u.y, r, 0, 6.283); x.fill(); x.stroke(); }
    else { x.fillRect(u.x - r, u.y - r * 0.7, r * 2, r * 1.4); x.strokeRect(u.x - r, u.y - r * 0.7, r * 2, r * 1.4); }
  },
  unitHud(x, u, sel) {
    const bw = Math.min(u.rad * 2, 60);
    if (sel || u.hp < u.maxHp) this.bar(x, u.x, u.y - u.rad - 6, bw, u.hp / u.maxHp);
    if (sel && u.d.ammo > 0) { x.fillStyle = 'rgba(0,0,0,0.5)'; x.fillRect(u.x - u.rad, u.y - u.rad - 3, u.rad * 2, 1.6); x.fillStyle = '#e0c060'; x.fillRect(u.x - u.rad, u.y - u.rad - 3, u.rad * 2 * (u.ammo / u.d.ammo), 1.6); }
    if (u.vet) { x.fillStyle = '#f2d06b'; for (let i = 0; i < u.vet; i++) poly(x, [u.x + u.rad + 1, u.y - u.rad + i * 3, u.x + u.rad + 4, u.y - u.rad + 2 + i * 3, u.x + u.rad + 7, u.y - u.rad + i * 3], null, '#f2d06b', 1); }
    if (u.cargo.length) { x.fillStyle = '#e8e8e0'; x.font = '9px sans-serif'; x.fillText(u.cargo.length, u.x + u.rad, u.y + u.rad); }
    if (u.harv > 0 && sel) { x.fillStyle = '#d8b740'; x.fillRect(u.x - u.rad, u.y + u.rad + 2, u.rad * 2 * (u.harv / u.d.ab.harvest), 2); }
  },
  bar(x, cx, y, w, k) {
    x.fillStyle = 'rgba(0,0,0,0.6)'; x.fillRect(cx - w / 2 - 0.5, y - 0.5, w + 1, 3);
    x.fillStyle = k > 0.6 ? '#62c46e' : k > 0.3 ? '#e0b43c' : '#e0533c'; x.fillRect(cx - w / 2, y, w * U.clamp(k, 0, 1), 2);
  },
  drawAir(x, v) {
    for (const u of G.units) {
      if (u.dead || u.d.cat !== 'air' || u.alt <= 0.3 || !this.inView(u, v, 120) || !this.seen(u)) continue;
      const aiTier = u.d.robotic && fac(u.owner).aiLab ? fac(u.owner).aiLab.tier : 1;
      const sp = SPR.unit(u.type, fac(u.owner).key, aiTier), h = u.alt * 26, k = sp.k || 1, kx = sp.kx || k, ky = sp.ky || k;
      x.save(); x.translate(u.x + h * 0.6, u.y + h * 0.9); x.rotate(u.a); x.scale(kx, ky); x.drawImage(sp.shadow, -sp.w / 2, -sp.h / 2, sp.w, sp.h); x.restore();
      if (G.sel.includes(u)) { x.strokeStyle = '#9fe0a8'; x.lineWidth = 1; x.beginPath(); x.ellipse(u.x, u.y - h, u.rad + 3, u.rad + 3, 0, 0, 6.283); x.stroke(); line(x, u.x, u.y - h, u.x, u.y, 'rgba(159,224,168,0.3)', 1); }
      x.save(); x.translate(u.x, u.y - h); x.rotate(u.a); x.scale(kx, ky); x.drawImage(sp.body, -sp.w / 2, -sp.h / 2, sp.w, sp.h);
      if (sp.rotor) for (const [rx, ry, rr] of sp.rotor) { x.save(); x.translate(rx, ry); x.rotate(G.time * 28 + rx); x.strokeStyle = 'rgba(30,30,30,0.55)'; x.lineWidth = 1.6; x.beginPath(); x.moveTo(-rr, 0); x.lineTo(rr, 0); x.moveTo(0, -rr); x.lineTo(0, rr); x.stroke(); circ(x, 0, 0, rr, 'rgba(40,40,40,0.08)'); x.restore(); }
      x.restore();
      if (G.cam.z < 0.7) this.marker(x, { x: u.x, y: u.y - h, owner: u.owner, d: u.d }, G.cam.z);
      if (u.d.plane && !G.paused && Math.random() < 0.72) {
        // wingtip vortices start at the scaled wingtips, not a hard-coded screen offset
        const span = U.clamp((sp.h - 6) * ky * 0.45, 8, 72);
        FX.contrail(u.x, u.y - h, u.a, span, u.type !== 'reconplane');
      }
      if (G.sel.includes(u) || u.hp < u.maxHp) this.bar(x, u.x, u.y - h - u.rad - 6, Math.min(60, u.rad * 2), u.hp / u.maxHp);
    }
  },
  drawOverlays(x, v) {
    // territory control zones: owner-coloured borders, flashing red when contested
    if (G.zones) for (const z of G.zones) {
      if (z.owner < 0 || !this.inView(z, v, z.r)) continue;
      if (G.cfg.fog && !Vis.explored(G.player, z.x, z.y)) continue;
      if (z.contested) {
        const p = 0.5 + 0.5 * Math.sin(G.time * 6);
        x.setLineDash([12, 8]); x.strokeStyle = 'rgba(255,70,50,' + (0.55 + p * 0.35).toFixed(3) + ')'; x.lineWidth = 2.5;
        x.beginPath(); x.arc(z.x, z.y, z.r, 0, 6.283); x.stroke(); x.setLineDash([]);
      }
    }
    // capture progress on strategic points
    for (const c of G.civb) {
      if (!c.capP || c.capP < 1 || c.rubble || !this.inView(c, v, 80)) continue;
      const f = c.capF >= 0 ? fac(c.capF) : null; if (!f) continue;
      const r = Zones.CORE * TILE;
      x.strokeStyle = 'rgba(0,0,0,0.5)'; x.lineWidth = 5 / Math.max(0.5, v.z); x.beginPath(); x.arc(c.x, c.y, r, 0, 6.283); x.stroke();
      x.strokeStyle = f.color; x.lineWidth = 3 / Math.max(0.5, v.z); x.beginPath(); x.arc(c.x, c.y, r, -Math.PI / 2, -Math.PI / 2 + 6.283 * Math.min(1, c.capP / 100)); x.stroke();
    }
    // selected buildings
    for (const e of G.sel) {
      if (e.kind === 'bld' || e.kind === 'civb' || e.kind === 'bridge') {
        if (e.kind === 'bridge') { x.strokeStyle = '#9fe0a8'; x.lineWidth = 1.5; x.beginPath(); x.arc(e.x, e.y, e.rad, 0, 6.283); x.stroke(); this.bar(x, e.x, e.y - e.rad - 6, 60, e.hp / e.maxHp); continue; }
        x.strokeStyle = e.kind === 'civb' ? '#d8d2b8' : friendly(G.player, e.owner) ? '#9fe0a8' : '#f08070'; x.lineWidth = 1.5;
        x.strokeRect(e.tx * TILE - 1, e.ty * TILE - 1, e.w * TILE + 2, e.h * TILE + 2);
        this.bar(x, e.x, e.ty * TILE - 6, e.w * TILE * 0.8, e.hp / e.maxHp);
        if (e.rally) { x.setLineDash([4, 4]); line(x, e.x, e.y, e.rally.x, e.rally.y, 'rgba(159,224,168,0.6)', 1); x.setLineDash([]); circ(x, e.rally.x, e.rally.y, 4, null, '#9fe0a8', 1.5); }
        const R = e.d && (e.d.fixR || e.d.healR || e.d.supplyR); if (R && e.kind === 'bld') { x.strokeStyle = 'rgba(159,224,168,0.25)'; x.beginPath(); x.arc(e.x, e.y, R * TILE + e.rad, 0, 6.283); x.stroke(); }
        if (e.kind === 'bld' && (e.d.w_ || (e.type === 'hq' && e.level > 1))) { x.strokeStyle = 'rgba(240,128,112,0.25)'; x.beginPath(); x.arc(e.x, e.y, World.rangeOf(e, (e.d.w_ || [Era.cur ? 'fortgun' : 'turretgun'])[0]), 0, 6.283); x.stroke(); }
      } else if (e.kind === 'unit' && e.path && friendly(G.player, e.owner)) {
        x.strokeStyle = e.ord && e.ord.am ? 'rgba(240,128,112,0.4)' : 'rgba(159,224,168,0.35)'; x.lineWidth = 1; x.setLineDash([3, 5]);
        x.beginPath(); x.moveTo(e.x, e.y); for (let i = e.pi; i < e.path.length; i++) x.lineTo(e.path[i].x, e.path[i].y); x.stroke(); x.setLineDash([]);
      }
    }
    // damaged own buildings: hp bars
    for (const b of G.blds) if (!b.dead && b.hp < b.maxHp && !G.sel.includes(b) && this.inView(b, v) && b.owner === G.player) this.bar(x, b.x, b.ty * TILE - 6, b.w * TILE * 0.8, b.hp / b.maxHp);
    for (const c of G.civb) if (!c.rubble && c.hp < c.maxHp * 0.98 && !G.sel.includes(c) && this.inView(c, v) && !c.abandoned && Vis.at(G.player, c.x, c.y)) this.bar(x, c.x, c.ty * TILE - 5, c.w * TILE * 0.6, c.hp / c.maxHp);
    // placement ghost
    const pl = UI.placing && UI.placing();
    if (pl) {
      const d = BLDS[pl], tx = UI.mouseTile.x - Math.floor(d.w / 2), ty = UI.mouseTile.y - Math.floor(d.h / 2), ok = World.canPlace(pl, G.player, tx, ty);
      const sp = SPR.bld(pl, fac(G.player).key, 1); x.globalAlpha = 0.55; x.drawImage(sp.img, tx * TILE, ty * TILE, sp.w * (sp.kx || 1), sp.h * (sp.ky || 1)); x.globalAlpha = 1;
      for (let yy = ty; yy < ty + d.h; yy++) for (let xx = tx; xx < tx + d.w; xx++) { x.fillStyle = ok.ok ? 'rgba(110,220,130,0.25)' : 'rgba(240,90,70,0.35)'; x.fillRect(xx * TILE + 1, yy * TILE + 1, TILE - 2, TILE - 2); }
      if (UI.wallDrag && UI.wallLineTiles) for (const t of UI.wallLineTiles(UI.wallDrag)) { const o2 = World.canPlace(pl, G.player, t.x, t.y); x.fillStyle = o2.ok ? 'rgba(110,220,130,0.30)' : 'rgba(240,90,70,0.40)'; x.fillRect(t.x * TILE + 1, t.y * TILE + 1, TILE - 2, TILE - 2); }
      UI.ghostWhy = ok.ok ? '' : ok.why;
    }
    if (UI.drawWorld) UI.drawWorld(x, v);
  },
  updateFog() {
    const M = this.M, W = M.w, D = this.fogImg.data, vis = Vis.vis[G.player], exp = Vis.exp[G.player];
    for (let j = 0; j < this.fh; j++) {
      const y = Math.min(M.h - 1, j * 2) * W;
      for (let i = 0; i < this.fw; i++) { const s = y + Math.min(W - 1, i * 2), o = (j * this.fw + i) * 4; D[o] = 8; D[o + 1] = 10; D[o + 2] = 12; D[o + 3] = vis[s] ? 0 : exp[s] ? 125 : 255; }
    }
    this.fx.putImageData(this.fogImg, 0, 0); Vis.dirty = false;
  },
  drawLighting(x, v) {
    const dark = Clock.darkness(); if (dark < 0.03 && Clock.dusk() < 0.03) { this.lightValid = false; return; }
    const W = Math.ceil(v.W / 2), H = Math.ceil(v.H / 2);
    if (this.light.width !== W || this.light.height !== H) { this.light.width = W; this.light.height = H; }
    const l = this.lx, z = v.z / 2;
    l.globalCompositeOperation = 'source-over'; l.clearRect(0, 0, W, H);
    l.fillStyle = 'rgba(8,14,34,' + (dark * 0.72).toFixed(3) + ')'; l.fillRect(0, 0, W, H);
    // zoomed far out the individual lights are sub-pixel: keep the darkness tint, skip the gradients
    if (dark > 0.05 && v.z >= 0.5) {
      l.globalCompositeOperation = 'destination-out';
      const glow = (wx, wy, r, a) => { const sx = (wx - v.x0) * z, sy = (wy - v.y0) * z, rr = r * z; if (sx < -rr || sy < -rr || sx > W + rr || sy > H + rr) return; const g = l.createRadialGradient(sx, sy, 0, sx, sy, rr); g.addColorStop(0, 'rgba(0,0,0,' + a + ')'); g.addColorStop(1, 'rgba(0,0,0,0)'); l.fillStyle = g; l.fillRect(sx - rr, sy - rr, rr * 2, rr * 2); };
      for (const c of G.civb) { if (c.rubble || c.abandoned) continue; const s = G.settlements[c.sett]; if (s && s.power < 0.5) continue; if (c.lit < 0.75 || !this.inView(c, v, 60)) continue; glow(c.x, c.y, 34 + c.w * 10, 0.75); }
      for (const b of G.blds) if (!b.dead && this.inView(b, v, 80) && !fac(b.owner).lowPower) glow(b.x, b.y, 50 + b.w * 12, 0.85);
      for (const a of G.civs) if (a.veh && !a.dead && this.inView(a, v, 40)) glow(a.x + Math.cos(a.a) * 14, a.y + Math.sin(a.a) * 14, 22, 0.6);
      for (const u of G.units) if (!u.dead && !u.inside && u.d.cat === 'veh' && u.owner === G.player && this.inView(u, v, 40)) glow(u.x + Math.cos(u.a) * 18, u.y + Math.sin(u.a) * 18, 30, 0.5);
      for (const L of FX.lights) {
        const life = U.clamp(L.life / L.max, 0, 1), flick = 0.93 + 0.07 * Math.sin(G.time * 24 + (L.phase || 0));
        glow(L.x, L.y, L.r, Math.min(1, life * flick * (0.65 + (L.bloom || 0.35) * 0.55)).toFixed(2));
      }
      for (const p of G.proj) if (p.type !== 'bullet') glow(p.x, p.y - (p.z || 0), 18, 0.6);
      // Colour the pools of light instead of merely punching white holes in the dark.
      l.globalCompositeOperation = 'lighter';
      for (const L of FX.lights) {
        const life = U.clamp(L.life / L.max, 0, 1); if (life <= 0) continue;
        const sx = (L.x - v.x0) * z, sy = (L.y - v.y0) * z, rr = L.r * z;
        if (sx < -rr || sy < -rr || sx > W + rr || sy > H + rr) continue;
        const a = Math.min(0.34, (L.bloom || 0.35) * life * 0.24);
        const cg = l.createRadialGradient(sx, sy, 0, sx, sy, rr);
        cg.addColorStop(0, 'rgba(' + (L.col || '255,190,110') + ',' + a.toFixed(3) + ')');
        cg.addColorStop(0.5, 'rgba(' + (L.col || '255,190,110') + ',' + (a * 0.24).toFixed(3) + ')');
        cg.addColorStop(1, 'rgba(' + (L.col || '255,190,110') + ',0)');
        l.fillStyle = cg; l.fillRect(sx - rr, sy - rr, rr * 2, rr * 2);
      }
      l.globalCompositeOperation = 'source-over';
    }
    l.globalCompositeOperation = 'source-over';
    const du = Clock.dusk(); if (du > 0.02) { l.fillStyle = 'rgba(255,120,50,' + (du * 0.12).toFixed(3) + ')'; l.fillRect(0, 0, W, H); }
    x.drawImage(this.light, 0, 0, v.W, v.H); this.lightValid = true;
  },
  /* World-space light pass, every frame: a detonation is not just a sprite,
     it is a light source that washes over the terrain and nearby silhouettes.
     A horizontal anamorphic streak gives the bright transient a lens bloom. */
  drawLightPass(x, v) {
    if (!FX.lights.length || v.z < 0.35) return;
    const du = Clock.dusk(), dark = Clock.darkness(), boost = 1 + du * 0.35 + dark * 0.22;
    let drawn = 0;
    x.save(); x.globalCompositeOperation = 'lighter';
    for (const L of FX.lights) {
      const life = U.clamp(L.life / L.max, 0, 1); if (life <= 0 || drawn >= 48) continue;
      const r = Math.min(L.r, 1200) * (0.78 + 0.22 * (1 - life));
      if (!this.inView(L, v, r * 1.1)) continue;
      drawn++;
      const flick = 0.92 + 0.08 * Math.sin(G.time * 38 + (L.phase || 0));
      const a = U.clamp((L.bloom || 0.35) * Math.pow(life, 1.25) * flick * boost, 0, 0.82);
      const col = L.col || '255,190,110';
      const g = x.createRadialGradient(L.x, L.y, 0, L.x, L.y, r);
      g.addColorStop(0, 'rgba(' + col + ',' + a.toFixed(3) + ')');
      g.addColorStop(0.3, 'rgba(' + col + ',' + (a * 0.3).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(' + col + ',0)');
      x.fillStyle = g; x.fillRect(L.x - r, L.y - r, r * 2, r * 2);
      if ((L.bloom || 0.35) > 0.5 && r > 32) {
        const sw = r * 1.8, sh = Math.max(1.4, r * 0.02);
        const sg = x.createLinearGradient(L.x - sw, L.y, L.x + sw, L.y);
        sg.addColorStop(0, 'rgba(' + col + ',0)');
        sg.addColorStop(0.5, 'rgba(' + col + ',' + (a * 0.3).toFixed(3) + ')');
        sg.addColorStop(1, 'rgba(' + col + ',0)');
        x.fillStyle = sg; x.fillRect(L.x - sw, L.y - sh / 2, sw * 2, sh);
      }
    }
    x.restore();
  },

  /* Cached screen-space colour grade: warm key from the upper left, cool
     shadow fill, golden-hour glare and a whisper of film grain. Rebuilt only
     when the viewport or the light/weather state changes appreciably. */
  drawGrade(x, v) {
    const W = Math.ceil(v.W), H = Math.ceil(v.H);
    const du = Clock.dusk(), dark = Clock.darkness();
    const wt = G.weather || {}, overcast = (wt.type === 'overcast' || wt.type === 'storm' || wt.type === 'fog') ? (wt.k || 0) : 0;
    const key = [W, H, Math.round(du * 12), Math.round(dark * 12), Math.round(overcast * 8), G.era || ''].join(':');
    if (!this.grade || this.grade.key !== key) {
      const c = U.canvas(W, H), g = c.getContext('2d');
      const warm = 0.035 + du * 0.105 + (1 - dark) * 0.012;
      const cool = 0.028 + dark * 0.085 + overcast * 0.035;
      const gr = g.createLinearGradient(0, 0, W, H);
      gr.addColorStop(0, 'rgba(255,196,120,' + warm.toFixed(3) + ')');
      gr.addColorStop(0.45, 'rgba(245,245,240,0.012)');
      gr.addColorStop(1, 'rgba(26,50,88,' + cool.toFixed(3) + ')');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      if (du > 0.02 || dark < 0.95) {
        const sun = g.createRadialGradient(W * 0.18, H * 0.05, 0, W * 0.18, H * 0.05, Math.max(W, H) * 0.82);
        sun.addColorStop(0, 'rgba(255,214,150,' + (0.025 + du * 0.065).toFixed(3) + ')');
        sun.addColorStop(0.55, 'rgba(255,214,150,0.008)');
        sun.addColorStop(1, 'rgba(255,214,150,0)');
        g.fillStyle = sun; g.fillRect(0, 0, W, H);
      }
      if (SPR.noise) {
        const pat = g.createPattern(SPR.noise(), 'repeat');
        if (pat) { g.save(); g.globalCompositeOperation = 'overlay'; g.globalAlpha = 0.018; g.fillStyle = pat; g.fillRect(0, 0, W, H); g.restore(); }
      }
      this.grade = { c, key, w: W, h: H };
    }
    x.save();
    x.globalCompositeOperation = 'soft-light';
    if (x.globalCompositeOperation !== 'soft-light') x.globalCompositeOperation = 'overlay';
    x.drawImage(this.grade.c, 0, 0, W, H);
    x.restore();
  },

  drawWeather(x, v) {
    const w = G.weather, k = w.k; if (k < 0.02) return;
    const t = G.time;
    if (w.type === 'rain' || w.type === 'storm') {
      x.strokeStyle = 'rgba(190,210,230,' + (0.35 * k).toFixed(3) + ')'; x.lineWidth = 1; x.beginPath();
      const n = Math.round((w.type === 'storm' ? 420 : 260) * k);
      for (let i = 0; i < n; i++) { const p = this.weather[i]; const px = ((p.x * v.W + t * 120 * (0.6 + p.s)) % v.W + v.W) % v.W, py = ((p.y * v.H + t * 700 * (0.6 + p.s)) % v.H); x.moveTo(px, py); x.lineTo(px - 3, py - 11); }
      x.stroke(); x.fillStyle = 'rgba(30,40,55,' + (0.18 * k) + ')'; x.fillRect(0, 0, v.W, v.H);
      if (w.type === 'storm' && w.flash > 0) { x.fillStyle = 'rgba(230,235,255,' + w.flash.toFixed(3) + ')'; x.fillRect(0, 0, v.W, v.H); }
    } else if (w.type === 'snow') {
      x.fillStyle = 'rgba(245,248,252,' + (0.8 * k).toFixed(3) + ')';
      for (let i = 0; i < 300 * k; i++) { const p = this.weather[i]; const px = ((p.x * v.W + Math.sin(t + p.s * 9) * 20 + t * 15) % v.W + v.W) % v.W, py = (p.y * v.H + t * 50 * (0.5 + p.s)) % v.H; x.fillRect(px, py, 1.6 + p.s, 1.6 + p.s); }
      x.fillStyle = 'rgba(220,228,235,' + (0.12 * k) + ')'; x.fillRect(0, 0, v.W, v.H);
    } else if (w.type === 'fog') { x.fillStyle = 'rgba(200,205,210,' + (0.3 * k) + ')'; x.fillRect(0, 0, v.W, v.H); }
    else if (w.type === 'sand') {
      x.fillStyle = 'rgba(190,150,90,' + (0.28 * k) + ')'; x.fillRect(0, 0, v.W, v.H);
      x.strokeStyle = 'rgba(220,190,130,' + (0.4 * k) + ')'; x.beginPath(); for (let i = 0; i < 200 * k; i++) { const p = this.weather[i]; const px = (p.x * v.W + t * 400 * (0.5 + p.s)) % v.W, py = p.y * v.H; x.moveTo(px, py); x.lineTo(px - 14, py + 2); } x.stroke();
    } else if (w.type === 'overcast') { x.fillStyle = 'rgba(40,46,54,' + (0.15 * k) + ')'; x.fillRect(0, 0, v.W, v.H); }
  },

  /* ---------- minimap ---------- */
  buildMini() {
    const M = this.M, W = M.w, g = this.mini.getContext('2d'), img = g.createImageData(this.mw, this.mh), D = img.data;
    const cols = G.factions.map((f) => COL.rgb(f.color)), cl = M.claim, N = M.w * M.h;
    for (let y = 0; y < this.mh; y++) {
      const ty = Math.min(M.h - 1, (y * M.h / this.mh) | 0);
      for (let x = 0; x < this.mw; x++) {
        const i = ty * W + Math.min(W - 1, (x * M.w / this.mw) | 0), o4 = (y * this.mw + x) * 4;
        let r = this.tc[i * 3] * this.sh[i], gg = this.tc[i * 3 + 1] * this.sh[i], b = this.tc[i * 3 + 2] * this.sh[i];
        if (M.road[i] && M.road[i] !== 4) { r = gg = b = 70; } if (M.rail[i] === 1) { r = 110; gg = 96; b = 80; }
        if (M.tree[i] > 1) { r *= 0.8; gg *= 0.85; b *= 0.8; }
        if (M.ctry) { const c0 = M.ctry[i]; if (c0) { const cr = (i % W) < W - 1 ? M.ctry[i + 1] : c0, cd = i + W < N ? M.ctry[i + W] : c0; if ((cr && cr !== c0) || (cd && cd !== c0)) { r = r * 0.35 + 214 * 0.65; gg = gg * 0.35 + 92 * 0.65; b = b * 0.35 + 70 * 0.65; } } }
        if (cl) { const o = cl[i]; if (o > 0 && o <= cols.length) { const c = cols[o - 1]; r = r * 0.65 + c[0] * 0.35; gg = gg * 0.65 + c[1] * 0.35; b = b * 0.65 + c[2] * 0.35; } }
        D[o4] = r; D[o4 + 1] = gg; D[o4 + 2] = b; D[o4 + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0); this.miniDirty = false;
  },
  buildOverview() {
    const M = this.M, K = Math.max(M.w, M.h) > 768 ? 2 : 3, W = M.w * K, H = M.h * K, c = U.canvas(W, H), g = c.getContext('2d'), img = g.createImageData(W, H), D = img.data;
    for (let py = 0; py < H; py++) {
      const fy = py / K - 0.5, y0 = U.clamp(Math.floor(fy), 0, M.h - 1), y1 = Math.min(M.h - 1, y0 + 1), ky = U.clamp(fy - y0, 0, 1);
      for (let px = 0; px < W; px++) {
        const fx = px / K - 0.5, x0 = U.clamp(Math.floor(fx), 0, M.w - 1), x1 = Math.min(M.w - 1, x0 + 1), kx = U.clamp(fx - x0, 0, 1);
        const a = y0 * M.w + x0, b = y0 * M.w + x1, cc = y1 * M.w + x0, d = y1 * M.w + x1, w00 = (1 - kx) * (1 - ky), w10 = kx * (1 - ky), w01 = (1 - kx) * ky, w11 = kx * ky, o = (py * W + px) * 4;
        const ti = (py / K | 0) * M.w + (px / K | 0), nn = 0.94 + hash2(px, py, 5) * 0.1;
        let k = (this.sh[a] * w00 + this.sh[b] * w10 + this.sh[cc] * w01 + this.sh[d] * w11) * nn;
        if (M.tree[ti] > 1) k *= 0.78; else if (M.tree[ti] === 1 && hash2(px, py, 2) < 0.3) k *= 0.82;
        for (let ch = 0; ch < 3; ch++) D[o + ch] = (this.tc[a * 3 + ch] * w00 + this.tc[b * 3 + ch] * w10 + this.tc[cc * 3 + ch] * w01 + this.tc[d * 3 + ch] * w11) * k;
        if (M.road[ti] && M.road[ti] !== 4) { D[o] = D[o + 1] = D[o + 2] = 64; }
        if (M.ore[ti] > 20) { D[o] = 214; D[o + 1] = 180; D[o + 2] = 70; }
        if (M.ctry) { const tx = px / K | 0, ty2 = py / K | 0, c0 = M.ctry[ti]; if (c0) { const cr = px + 1 < W ? M.ctry[ty2 * M.w + ((px + 1) / K | 0)] : c0, cd = py + 1 < H ? M.ctry[((py + 1) / K | 0) * M.w + tx] : c0; if ((cr && cr !== c0) || (cd && cd !== c0)) { D[o] = D[o] * 0.35 + 214 * 0.65; D[o + 1] = D[o + 1] * 0.35 + 92 * 0.65; D[o + 2] = D[o + 2] * 0.35 + 70 * 0.65; } } }
        D[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0); this.overview = c;
  },
  drawMinimap(cv) {
    const M = this.M; if (!M) return;
    if (this.miniDirty && (!this.miniT || G.time - this.miniT > 2)) { this.buildMini(); this.miniT = G.time; }
    const g = cv.getContext('2d'), W = cv.width, H = cv.height, s = Math.min(W / M.w, H / M.h), ox = (W - M.w * s) / 2, oy = (H - M.h * s) / 2;
    g.fillStyle = '#07090a'; g.fillRect(0, 0, W, H);
    g.imageSmoothingEnabled = false; g.drawImage(this.mini, ox, oy, M.w * s, M.h * s);
    const P = G.player, radar = fac(P).radar || !G.cfg.fog;
    // settlements
    for (const st of G.settlements) { if (G.cfg.fog && !Vis.explored(P, st.x, st.y)) continue; g.strokeStyle = st.ctrl >= 0 ? fac(st.ctrl).color : 'rgba(230,225,205,0.6)'; g.lineWidth = 1; g.beginPath(); g.arc(ox + st.tx * s, oy + st.ty * s, st.r * s, 0, 6.283); g.stroke(); }
    for (const c of G.civb) { if (G.cfg.fog && !Vis.explored(P, c.x, c.y)) continue; g.fillStyle = c.rubble ? '#4a443c' : c.ctrl >= 0 ? fac(c.ctrl).color : '#bdb6a2'; g.fillRect(ox + c.tx * s, oy + c.ty * s, Math.max(1, c.w * s), Math.max(1, c.h * s)); }
    for (const b of G.blds) { if (b.dead) continue; if (b.owner !== P && G.cfg.fog && !Vis.explored(P, b.x, b.y)) continue; g.fillStyle = fac(b.owner).color; g.fillRect(ox + b.tx * s, oy + b.ty * s, Math.max(1.5, b.w * s), Math.max(1.5, b.h * s)); }
    for (const q of G.zones || []) { if (q.kind !== 'point' || q.owner < 0) continue; if (G.cfg.fog && !Vis.explored(P, q.x, q.y)) continue; g.strokeStyle = q.contested ? '#ff4632' : fac(q.owner).color; g.lineWidth = 1; g.beginPath(); g.arc(ox + (q.x / TILE) * s, oy + (q.y / TILE) * s, Math.max(2, (q.r / TILE) * s), 0, 6.283); g.stroke(); }
    for (const u of G.units) {
      if (u.dead || u.inside) continue;
      if (!friendly(P, u.owner) && (!radar || !canSee(P, u))) continue;
      g.fillStyle = fac(u.owner).color; const sz = u.d.cat === 'inf' ? 1.5 : 2.2; g.fillRect(ox + (u.x / TILE) * s - sz / 2, oy + (u.y / TILE) * s - sz / 2, sz, sz);
    }
    if (G.cfg.fog) {
      g.globalAlpha = 1; g.imageSmoothingEnabled = true; g.drawImage(this.fog, ox, oy, M.w * s, M.h * s);
    }
    if (M.cinfo) { g.save(); g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = '600 9px "IBM Plex Mono", monospace'; g.lineWidth = 2.5; g.lineJoin = 'round'; for (const c of M.cinfo) { if (Math.sqrt(c.n) * s < 34) continue; g.strokeStyle = 'rgba(0,0,0,0.75)'; g.fillStyle = 'rgba(244,232,200,0.85)'; const t = c.name.length > 14 ? c.name.slice(0, 12) + '…' : c.name; g.strokeText(t, ox + c.x * s, oy + c.y * s); g.fillText(t, ox + c.x * s, oy + c.y * s); } g.restore(); }
    Strike.drawMini(g, { s, ox, oy });
    const v = this.view(); g.strokeStyle = '#e8e2c8'; g.lineWidth = 1; g.strokeRect(ox + (v.x0 / TILE) * s, oy + (v.y0 / TILE) * s, ((v.x1 - v.x0) / TILE) * s, ((v.y1 - v.y0) / TILE) * s);
    if (!radar) { g.fillStyle = 'rgba(224,180,60,0.85)'; g.font = '600 10px "IBM Plex Mono", monospace'; g.fillText('NO RADAR — ENEMY CONTACTS HIDDEN', 6, H - 6); }
    this.miniXf = { s, ox, oy };
  },
};
