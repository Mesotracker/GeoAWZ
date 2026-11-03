'use strict';
/* =====================================================================
   CITY.RA — fx.js
   Pooled particles (prompt flashes, decelerating shock fronts, turbulent
   fireballs, ballistic shrapnel, soot, debris, smoke, water, flares and
   contrails), temporary cinematic light sources and persistent decals.
   ===================================================================== */

const FX = {
  parts: [],
  pool: new Pool(() => ({})),
  lights: [],
  max: 4000,
  quality: 1,
  smokeLife: 0.45, // fraction of each smoke puff's authored lifetime
  vr: null, // last rendered view: effects far off-screen are skipped entirely

  add(type, x, y, o = {}) {
    if (this.parts.length >= this.max * this.quality) return null;
    const vr = this.vr; if (vr && (x < vr.x0 - 320 || x > vr.x1 + 320 || y < vr.y0 - 420 || y > vr.y1 + 320)) return null;
    const p = this.pool.get();
    p.type = type; p.x = x; p.y = y; p.z = o.z || 0; p.vx = o.vx || 0; p.vy = o.vy || 0; p.vz = o.vz || 0;
    p.life = 0; p.max = o.max || 1; p.size = o.size || 3; p.grow = o.grow || 0; p.c = o.c || '#fff'; p.a = o.a || 0; p.va = o.va || 0; p.len = o.len || 0; p.drag = o.drag == null ? 0.9 : o.drag;
    p.alpha = o.alpha == null ? 1 : o.alpha; p.trail = !!o.trail; p.blw = o.blw || 0;
    // blast physics: gravity, Sedov-style decelerating expansion, ground-plane
    // shock aspect and restitution. Every field is reset so pooled objects are safe.
    p.g = o.g || 0; p.pow = o.pow == null ? 1 : o.pow; p.aspect = o.aspect || 0.56;
    p.bounce = o.bounce == null ? 0.32 : o.bounce;
    p.v = o.v != null ? o.v : ((Math.random() * 8) | 0);
    p.sx = o.sx != null ? o.sx : x; p.sy = o.sy != null ? o.sy : y;
    if (type === 'smoke' || type === 'dust') p.max *= this.smokeLife; // smoke clears faster
    p.size0 = p.size; p.size1 = p.size + p.grow * p.max;
    this.parts.push(p); return p;
  },

  // bloom = how strongly the light reads in the screen-space cinematic pass
  light(x, y, r, life, col, bloom = 0.35) {
    if (this.lights.length > 96) this.lights.splice(0, this.lights.length - 96);
    this.lights.push({ x, y, r, life, max: life, col: col || '255,190,110', bloom, phase: Math.random() * 6.283 });
  },

  /* A conventional detonation in seven physical stages: prompt radiation,
     a decelerating shock/condensation front, a buoyant cooling fireball,
     ballistic shrapnel, the soot shell that occludes the fire, the dust skirt
     and ejecta, then secondary cook-offs. Radii grow on a t^0.4 curve instead
     of linearly, so the leading edge rushes out and then loses energy. */
  explosion(x, y, s = 1, opts = {}) {
    const q = this.quality, S = U.clamp(s, 0.25, 5), heavy = s >= 1.2;
    const n = Math.round(18 * Math.min(s, 3) * q) + 5;
    const windX = G.wind ? Math.cos(G.wind) * 7 : 4;

    // 0. Instantaneous thermal flash: hard white core, anamorphic streak and
    //    a dark ground-shadow where the blast strips and scorches the surface.
    this.add('flash', x, y, { size: 9 * S, grow: 92 * S, max: 0.12, c: '255,252,238', pow: 0.30, a: Math.random() * 6.283 });
    this.add('glow', x, y, { size: 11 * S, grow: 108 * S, max: 0.10, c: '255,255,248', pow: 0.32 });
    this.add('glow', x, y, { size: 18 * S, grow: 48 * S, max: 0.28, c: '255,240,180', pow: 0.45 });
    this.add('glow', x, y, { size: 14 * S, grow: 22 * S, max: 0.62, c: '255,140,42', pow: 0.6 });
    this.add('glow', x, y, { size: 10 * S, grow: 12 * S, max: 0.95, c: '205,52,14', alpha: 0.78, pow: 0.75 });
    if (s >= 0.45) this.add('ground', x, y, { size: 8 * S, grow: 38 * S, max: 0.72, c: '14,11,9', alpha: 0.55, pow: 0.5 });

    // 1. Mach stem / condensation ring and the slower pressure+dust front.
    //    Flattened ellipses put the shock on the ground plane.
    this.add('shock', x, y, { size: 2 * S, grow: 210 * S, max: 0.34, c: '235,246,255', aspect: 0.55, pow: 0.42, alpha: 0.9 });
    this.add('shock', x, y, { size: 5 * S, grow: 135 * S, max: 0.58, c: '205,180,145', aspect: 0.6, pow: 0.5, alpha: 0.55 });
    if (s >= 0.95) this.add('ring', x, y, { size: 9 * S, grow: 270 * S, max: 0.44, c: '255,205,145', pow: 0.55 });

    // 2. Textured roiling fireball lobes: hot inner plasma, cooler red rim,
    //    buoyant rise and turbulent rotation as the gases cool.
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, edge = Math.random(), v = U.rnd(12, 78) * S * (0.35 + edge * 0.85);
      const col = edge < 0.25 ? '255,252,215' : edge < 0.58 ? '255,' + (150 + U.rint(70)) + ',42' : edge < 0.84 ? '240,' + (65 + U.rint(48)) + ',18' : '168,36,12';
      this.add('fire', x + Math.cos(a) * 4.5 * S * edge, y + Math.sin(a) * 4.5 * S * edge, {
        vx: Math.cos(a) * v, vy: Math.sin(a) * v - U.rnd(10, 32) * S,
        size: U.rnd(5.5, 13.5) * S, grow: U.rnd(10, 20) * S, max: U.rnd(0.38, 0.98), pow: 0.42,
        c: col, drag: 0.84, a: Math.random() * 6.28, va: U.rnd(-3.5, 3.5), v: i & 7
      });
    }

    // 3. Incandescent shrapnel: true ballistic arcs with gravity and bounce,
    //    not straight screen-space lines.
    const spkN = Math.round(n * 0.95);
    for (let i = 0; i < spkN; i++) {
      const a = Math.random() * Math.PI * 2, fast = i < spkN * 0.45, v = (fast ? U.rnd(155, 380) : U.rnd(60, 175)) * S;
      this.add('spark', x, y - 2, {
        vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.8 - U.rnd(24, 72), vz: U.rnd(45, 145) * S, z: 2,
        g: 340, bounce: 0.28, size: fast ? 1.8 : 1.35, max: fast ? U.rnd(0.24, 0.55) : U.rnd(0.5, 1.25),
        c: fast ? '255,248,205' : '255,' + (135 + U.rint(85)) + ',45', drag: fast ? 0.91 : 0.95,
        trail: !fast && s >= 0.9 && i % 3 === 0
      });
    }

    // 4. Billowing smoke column: buoyant dark billows rise and mushroom,
    //    shear downwind with age; a tan dust skirt races along the ground.
    const colN = Math.round(9 * Math.min(s, 3) * q) + 4;
    for (let i = 0; i < colN; i++) {
      const f = colN > 1 ? i / (colN - 1) : 0, hOff = f * (30 + 30 * S) * S + U.rnd(-6, 6) * S;
      const wob = U.rnd(-1, 1) * (4 + f * 18) * S;
      const shade = opts.dark ? 20 + U.rint(14) : f < 0.35 ? 66 + U.rint(20) : 34 + U.rint(22);
      const warm = f < 0.3 && !opts.dark;
      const cStr = warm ? shade + ',' + Math.round(shade * 0.72) + ',' + Math.round(shade * 0.5) : shade + ',' + (shade - 2) + ',' + Math.max(0, shade - 6);
      this.add('smoke', x + wob, y - hOff, {
        vx: wob * 0.7 + windX * (0.3 + f), vy: U.rnd(-66, -30) * S * (1 - f * 0.45),
        size: U.rnd(7, 13) * S * (0.7 + f * 0.9), grow: (15 + f * 26) * S, max: U.rnd(4.5, 8.5),
        c: cStr, alpha: 0.62, drag: 0.96, a: Math.random() * 6.28, va: U.rnd(-1.4, 1.4), v: i & 7, blw: 1
      });
    }
    const torN = Math.round(6 * Math.min(s, 3) * q) + 3;
    for (let i = 0; i < torN; i++) {
      const a = Math.random() * Math.PI * 2, d = U.rnd(2, 11) * S;
      const shade = opts.dark ? 22 + U.rint(12) : 40 + U.rint(22);
      this.add('smoke', x + Math.cos(a) * d, y - (30 + 30 * S) * S + U.rnd(-8, 8) * S, {
        vx: Math.cos(a) * U.rnd(18, 52) * S + windX * 0.8, vy: U.rnd(-26, -8) * S,
        size: U.rnd(8, 14) * S, grow: U.rnd(20, 30) * S, max: U.rnd(5, 9),
        c: shade + ',' + (shade - 2) + ',' + Math.max(0, shade - 6), alpha: 0.58, drag: 0.95,
        a: Math.random() * 6.28, va: U.rnd(-1, 1), v: i & 7, blw: 1
      });
    }
    const duN = Math.round(8 * Math.min(s, 3) * q) + 4;
    for (let i = 0; i < duN; i++) {
      const a = Math.random() * Math.PI * 2, v = U.rnd(25, 80) * S;
      const shade = opts.dark ? 60 + U.rint(20) : 138 + U.rint(30);
      this.add('smoke', x + Math.cos(a) * 6 * S, y + Math.sin(a) * 6 * S, {
        vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.35 + 2,
        size: U.rnd(7, 13) * S, grow: U.rnd(24, 34) * S, max: U.rnd(3.5, 6.5), pow: 0.7,
        c: shade + ',' + (shade - 14) + ',' + (shade - 30), alpha: 0.4, drag: 0.93,
        a: Math.random() * 6.28, va: U.rnd(-0.8, 0.8), v: i & 7, blw: 2
      });
    }

    // 5. Opaque soot shell: drawn AFTER the additive fire so the fireball is
    //    genuinely occluded as the detonation transitions to a smoke plume.
    if (s >= 0.7) {
      const sootN = Math.round(5 * Math.min(s, 3) * q) + 3;
      for (let i = 0; i < sootN; i++) {
        const a = Math.random() * 6.283, d = U.rnd(0, 9) * S;
        this.add('soot', x + Math.cos(a) * d, y + Math.sin(a) * d - U.rnd(0, 8) * S, {
          vx: Math.cos(a) * U.rnd(8, 30) * S + windX * 0.3, vy: U.rnd(-48, -16) * S,
          size: U.rnd(6, 12) * S, grow: U.rnd(14, 26) * S, max: U.rnd(3.2, 6.8), pow: 0.7,
          c: opts.dark ? '16,14,13' : '28,24,21', alpha: 0.72, drag: 0.96,
          a: Math.random() * 6.28, va: U.rnd(-1.2, 1.2), v: i & 7, blw: 1
        });
      }
    }

    // 6. Ballistic chunks of earth/metal with smoke ribbons & ground bounce.
    if (s >= 0.6) {
      const dbN = Math.round(n * 0.8);
      for (let i = 0; i < dbN; i++) {
        const a = Math.random() * Math.PI * 2, v = U.rnd(38, 185) * S;
        this.add('debris', x, y, {
          vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: U.rnd(60, 195) * S, g: 290, bounce: 0.32,
          size: U.rnd(1.5, 3.6) * Math.min(1.7, Math.sqrt(S)), max: U.rnd(0.8, 1.75),
          a: Math.random() * 6.28, va: U.rnd(-15, 15),
          c: U.pick(['#2d2926', '#4c453d', '#1c1a18', '#6e5f50', '#847565', '#d86b28', '#ff9b38']),
          drag: 0.97, trail: s >= 0.85 && i % 2 === 0
        });
      }
    }

    // 7. Secondary cook-off fireballs and rising mushroom column on heavy blasts.
    if (heavy) {
      for (let i = 0; i < 12; i++) {
        const hOff = U.rnd(6, 44) * S;
        this.add('smoke', x + U.rnd(-13, 13) * S, y - hOff, {
          vx: U.rnd(-9, 9), vy: U.rnd(-52, -22), size: 12 * S, grow: 22 * S,
          max: U.rnd(3.4, 6.2), c: '34,30,27', alpha: 0.68, drag: 0.96, a: Math.random() * 6.28, va: U.rnd(-1, 1), v: i & 7, blw: 1
        });
        if (i < 5) this.add('fire', x + U.rnd(-10, 10) * S, y - hOff * 0.65, {
          vx: U.rnd(-12, 12), vy: U.rnd(-38, -14), size: 8 * S, grow: 12 * S, pow: 0.5,
          max: U.rnd(0.45, 0.95), c: '255,155,40', drag: 0.9, a: Math.random() * 6.28, va: U.rnd(-2.5, 2.5), v: i & 7
        });
      }
    }

    // Two-stage light: a near-white prompt flash and a lingering orange fire.
    this.light(x, y, 210 * S, 0.14, '255,248,224', 0.95);
    this.light(x, y, 125 * S, 0.85, '255,165,65', 0.42);
    if (heavy) this.light(x, y, 280 * S, 0.5, '255,205,135', 0.55);

    // Shake and exposure fall off with distance: a blast across the map should
    // not rattle the camera or bleach the whole screen.
    if (typeof Render !== 'undefined' && Render.cv && Render.view && G.cam && s >= 0.5) {
      const v = Render.view(), cx = (v.x0 + v.x1) / 2, cy = (v.y0 + v.y1) / 2;
      const reach = Math.hypot(v.W, v.H) / Math.max(0.45, v.z);
      const near = U.clamp(1 - Math.hypot(x - cx, y - cy) / (reach * 0.75), 0, 1);
      if (near > 0.02) {
        Render.shake = Math.max(Render.shake || 0, Math.min(20, s * 4.6 * near));
        if (s >= 0.9) Render.flash = Math.max(Render.flash || 0, Math.min(0.16, s * 0.022 * near));
      }
    }
  },

  contrail(x, y, a, span = 10, jet = true) {
    const wx = -Math.sin(a), wy = Math.cos(a), bx = -Math.cos(a), by = -Math.sin(a);
    const windX = G.wind ? Math.cos(G.wind) * 3.5 : 2, windY = G.wind ? Math.sin(G.wind) * 3.5 : 1;
    // Wingtip condensation vortex ribbons (left & right wingtips)
    for (const side of [-1, 1]) {
      const tx = x + wx * span * side + bx * 3, ty = y + wy * span * side + by * 3;
      this.add('contrail', tx, ty, {
        vx: windX + U.rnd(-1.8, 1.8), vy: windY + U.rnd(-1.8, 1.8),
        size: U.rnd(1.5, 2.3), grow: U.rnd(4.2, 6.8), max: U.rnd(2.2, 3.6),
        a: a + side * 0.04, va: side * U.rnd(0.25, 0.55),
        c: '238,245,255', alpha: 0.52, drag: 0.96, v: (side + 1)
      });
    }
    // Central jet exhaust vapor core + subtle afterburner thermal shimmer
    if (jet) {
      const ex = x + bx * (span * 0.75), ey = y + by * (span * 0.75);
      this.add('contrail', ex, ey, {
        vx: bx * 14 + windX, vy: by * 14 + windY,
        size: U.rnd(2.2, 3.2), grow: U.rnd(6.5, 9.5), max: U.rnd(1.8, 3.0),
        a, va: U.rnd(-0.4, 0.4), c: '245,248,255', alpha: 0.62, drag: 0.94, v: 3
      });
      this.add('fire', ex + bx * 1.5, ey + by * 1.5, {
        vx: bx * 22, vy: by * 22, size: 1.8, grow: 1.5, max: 0.11,
        c: '255,195,110', drag: 0.85, v: 0
      });
    }
  },

  smallHit(x, y, armored) {
    if (armored) { for (let i = 0; i < 4; i++) { const a = Math.random() * 6.28, v = U.rnd(40, 120); this.add('spark', x, y, { vx: Math.cos(a) * v, vy: Math.sin(a) * v, size: 1.2, max: 0.25, c: '255,220,140' }); } }
    else this.add('dust', x, y, { size: 2.5, grow: 10, max: 0.5, c: '140,120,90', alpha: 0.5 });
  },
  muzzle(x, y, a, big, w, width) {
    if (G.era === 'napoleonic' && w) { // black powder: a flash and a bank of white smoke along the firing line
      if (w.wh === 'blade') { this.add('spark', x, y, { vx: Math.cos(a) * 60, vy: Math.sin(a) * 60, size: 1, max: 0.15, c: '230,230,240' }); return; }
      const n = big ? 5 : Math.max(2, Math.round((width || 6) / 4)), px = -Math.sin(a), py = Math.cos(a);
      this.add('glow', x, y, { size: big ? 9 : 4, grow: big ? 10 : 5, max: 0.08, c: '255,220,140' });
      for (let i = 0; i < n; i++) { const o = (i / Math.max(1, n - 1) - 0.5) * (width || 6) * 1.6, sx = x + px * o + Math.cos(a) * 4, sy = y + py * o + Math.sin(a) * 4;
        this.add('smoke', sx, sy, { vx: Math.cos(a) * (big ? 30 : 14) + U.rnd(-3, 3), vy: Math.sin(a) * (big ? 30 : 14) - 3, size: big ? 6 : 3.2, grow: big ? 11 : 5, max: big ? U.rnd(3, 5) : U.rnd(2, 3.4), c: '232,228,214', alpha: big ? 0.62 : 0.5, drag: 0.93 }); }
      if (big) this.light(x, y, 50, 0.12);
      return;
    }
    this.add('glow', x + Math.cos(a) * 2, y + Math.sin(a) * 2, { size: big ? 7 : 3.5, grow: big ? 8 : 4, max: 0.08, c: '255,230,160' });
    if (big) { this.add('smoke', x + Math.cos(a) * 5, y + Math.sin(a) * 5, { vx: Math.cos(a) * 25, vy: Math.sin(a) * 25, size: 5, grow: 14, max: 1.2, c: '120,115,105', alpha: 0.45 }); this.light(x, y, 40, 0.1); }
  },
  smoke(x, y, s = 1, dark) { this.add('smoke', x + U.rnd(-3, 3), y + U.rnd(-3, 3), { vx: U.rnd(-4, 4) + 6, vy: U.rnd(-10, -3), size: 4 * s, grow: 10 * s, max: U.rnd(2, 4), c: dark ? '28,26,24' : '120,118,112', alpha: dark ? 0.6 : 0.4, drag: 0.98 }); },
  flame(x, y, s = 1) {
    this.add('fire', x + U.rnd(-5, 5) * s, y + U.rnd(-5, 5) * s, { vx: U.rnd(-6, 6), vy: U.rnd(-22, -8), size: U.rnd(3, 6) * s, grow: 4 * s, max: U.rnd(0.4, 0.8), c: '255,' + (90 + U.rint(110)) + ',30', drag: 0.95 });
    if (Math.random() < 0.3) this.smoke(x, y - 6, s, true);
  },
  water(x, y, s = 1) {
    this.add('ring', x, y, { size: 3, grow: 40 * s, max: 0.6, c: '220,240,255' });
    for (let i = 0; i < 6 * s; i++) { const a = Math.random() * 6.28, v = U.rnd(10, 50) * s; this.add('water', x, y, { vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: U.rnd(30, 90), size: U.rnd(1.5, 3), max: 0.8, c: '220,235,245' }); }
  },
  trail(x, y, dark) { this.add('smoke', x, y, { size: 2.2, grow: 7, max: dark ? 0.9 : 1.5, c: dark ? '90,86,80' : '215,215,210', alpha: 0.5, drag: 0.9 }); },
  flare(x, y) { for (let i = 0; i < 4; i++) { const a = Math.random() * 6.28; this.add('flare', x, y, { vx: Math.cos(a) * 40, vy: Math.sin(a) * 40 + 20, size: 2.4, max: 1.4, c: '255,240,200', drag: 0.96 }); } this.light(x, y, 50, 1); },
  heal(x, y) { this.add('plus', x + U.rnd(-6, 6), y + U.rnd(-6, 6), { vy: -14, size: 3, max: 0.9, c: '120,230,150' }); },
  spray(x, y, tx, ty) { const a = U.ang(x, y, tx, ty); for (let i = 0; i < 2; i++) this.add('water', x, y, { vx: Math.cos(a + U.rnd(-0.2, 0.2)) * 90, vy: Math.sin(a + U.rnd(-0.2, 0.2)) * 90, vz: 30, size: 1.6, max: 0.5, c: '200,225,245' }); },

  update(dt) {
    const P = this.parts;
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      p.life += dt;
      if (p.life >= p.max) { P[i] = P[P.length - 1]; P.pop(); this.pool.put(p); continue; }
      const dr = Math.pow(p.drag, dt * 30);
      p.vx *= dr; p.vy *= dr;
      if ((p.type === 'smoke' || p.type === 'soot') && p.blw) {
        const k = p.life / p.max, wX = G.wind ? Math.cos(G.wind) * 26 : 8, wY = G.wind ? Math.sin(G.wind) * 26 : 3;
        if (p.blw === 1) { // buoyant billow: rise eases off, wind shear takes over with age
          const pull = Math.min(1, dt * (0.3 + k * 2.4));
          p.vx += (wX - p.vx) * pull; p.vy += ((wY * 0.3 - 7) - p.vy) * pull * 0.6;
          p.va *= 1 - Math.min(0.85, dt * (0.4 + k));
        } else { // ground dust: settles low, drifts downwind and thins
          p.vy += (3 - p.vy) * Math.min(1, dt * 1.6);
          p.vx += (wX * 0.7 - p.vx) * Math.min(1, dt * 0.9);
        }
      }
      // Ballistic height for glowing shrapnel and tumbling ejecta.
      if (p.type === 'spark' && p.g) {
        p.vz -= p.g * dt; p.z += p.vz * dt;
        if (p.z < 0) { p.z = 0; p.vz *= -p.bounce; p.vx *= 0.7; p.vy *= 0.7; if (Math.abs(p.vz) < 18) p.vz = 0; }
      }
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.pow !== 1) {
        const k = U.clamp(p.life / p.max, 0, 1);
        p.size = p.size0 + (p.size1 - p.size0) * Math.pow(k, p.pow);
      } else p.size += p.grow * dt;
      if (p.va) p.a += p.va * dt;
      if (p.trail && p.z > 3 && Math.random() < (p.type === 'spark' ? 0.2 : 0.45)) {
        this.add('smoke', p.x, p.y - p.z * 0.4, { size: 1.6, grow: 5, max: 0.55, c: '75,70,64', alpha: 0.38, drag: 0.9 });
      }
      if (p.type === 'debris' || p.type === 'water') {
        p.vz -= (p.g || 290) * dt; p.z += p.vz * dt;
        if (p.z < 0) { p.z = 0; p.vz *= -p.bounce; p.vx *= 0.55; p.vy *= 0.55; p.va *= 0.5; }
      }
    }
    for (let i = this.lights.length - 1; i >= 0; i--) { const l = this.lights[i]; l.life -= dt; if (l.life <= 0) this.lights.splice(i, 1); }
  },

  draw(x, view) {
    const P = this.parts, x0 = view.x0 - 80, x1 = view.x1 + 80, y0 = view.y0 - 80, y1 = view.y1 + 80;
    const inView = (p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;

    // PASS 1 — opaque atmosphere behind the light: ground shadow, smoke,
    // contrails, water and UI motes.
    x.globalCompositeOperation = 'source-over';
    for (const p of P) {
      if (!inView(p)) continue;
      const k = p.life / p.max;
      if (p.type === 'ground') {
        const a = p.alpha * Math.pow(1 - k, 1.4); if (a < 0.01) continue;
        const r = Math.max(1, p.size * 1.35); x.globalAlpha = Math.min(1, a);
        x.drawImage(SPR.puff(p.c), p.x - r, p.y - r * 0.55, r * 2, r * 1.1);
      } else if (p.type === 'smoke' || p.type === 'dust') {
        const fin = p.blw ? (k < 0.22 ? k / 0.22 : 1) : (k < 0.1 ? k * 10 : 1);
        const fout = p.blw ? Math.pow(1 - k, 1.35) : (1 - k);
        const a = p.alpha * fout * fin; if (a < 0.01) continue;
        const r = p.size * (p.blw ? 2.1 : 1.75); x.globalAlpha = Math.min(1, a);
        const tex = SPR.smokeTex ? SPR.smokeTex(p.c, p.v || 0) : SPR.puff(p.c);
        const py = p.y - p.life * 5;
        if (p.a) { x.save(); x.translate(p.x, py); x.rotate(p.a); x.drawImage(tex, -r, -r, r * 2, r * 2); x.restore(); }
        else x.drawImage(tex, p.x - r, py - r, r * 2, r * 2);
      } else if (p.type === 'contrail') {
        const a = p.alpha * Math.pow(1 - k, 1.35) * (k < 0.08 ? k * 12.5 : 1); if (a < 0.01) continue;
        const r = p.size * 1.55; x.globalAlpha = Math.min(1, a);
        const tex = SPR.contrailTex ? SPR.contrailTex(p.v || 0) : SPR.puff(p.c);
        x.save(); x.translate(p.x, p.y); x.rotate(p.a || 0);
        x.drawImage(tex, -r * 1.4, -r * 0.75, r * 2.8, r * 1.5); x.restore();
      } else if (p.type === 'water') {
        x.globalAlpha = 1 - k; x.fillStyle = 'rgb(' + p.c + ')'; x.fillRect(p.x - p.size / 2, p.y - p.z * 0.4, p.size, p.size);
      } else if (p.type === 'plus') {
        x.globalAlpha = 1 - k; x.fillStyle = 'rgb(' + p.c + ')'; x.fillRect(p.x - 3, p.y - 0.8, 6, 1.6); x.fillRect(p.x - 0.8, p.y - 3, 1.6, 6);
      }
    }

    // PASS 2 — emissive: prompt flash, cooling fire, glows, shock fronts and
    // incandescent shrapnel. Additive blending gives real thermal bloom.
    x.globalCompositeOperation = 'lighter';
    for (const p of P) {
      if (!inView(p)) continue;
      const k = p.life / p.max;
      if (p.type === 'flash') {
        const a = p.alpha * Math.pow(1 - k, 2.2); if (a < 0.01) continue;
        const r = Math.max(1, p.size * 1.7);
        x.save(); x.translate(p.x, p.y); x.rotate(p.a || 0); x.globalAlpha = Math.min(1, a);
        x.drawImage(SPR.puff(p.c), -r, -r, r * 2, r * 2);
        x.fillStyle = 'rgba(' + p.c + ',' + (a * 0.5).toFixed(3) + ')';
        const t = Math.max(1.2, r * 0.035); x.fillRect(-r * 2.6, -t / 2, r * 5.2, t); x.fillRect(-t / 2, -r * 1.2, t, r * 2.4);
        x.restore();
      } else if (p.type === 'fire') {
        const r = Math.max(0.8, p.size * (2.05 - k * 0.72));
        x.globalAlpha = Math.max(0, Math.pow(1 - k, 0.85));
        const stg = k < 0.25 ? 0 : k < 0.62 ? 1 : 2;
        const tex = SPR.fireTex ? SPR.fireTex(p.v || 0, stg) : SPR.puff(p.c);
        if (p.a) { x.save(); x.translate(p.x, p.y); x.rotate(p.a); x.drawImage(tex, -r, -r, r * 2, r * 2); x.restore(); }
        else x.drawImage(tex, p.x - r, p.y - r, r * 2, r * 2);
      } else if (p.type === 'glow' || p.type === 'flare') {
        const r = Math.max(0.6, p.size * 1.6);
        x.globalAlpha = Math.max(0, (1 - k) * (p.type === 'glow' ? 0.88 : 1)); x.drawImage(SPR.puff(p.c), p.x - r, p.y - r, r * 2, r * 2);
      } else if (p.type === 'shock') {
        const a = p.alpha * Math.pow(1 - k, 1.6); if (a < 0.02) continue;
        const r = Math.max(1, p.size), ry = r * (p.aspect || 0.56);
        x.globalAlpha = 1; x.globalCompositeOperation = 'source-over';
        x.strokeStyle = 'rgba(26,20,15,' + (a * 0.3).toFixed(3) + ')'; x.lineWidth = 5 * (1 - k) + 1;
        x.beginPath(); x.ellipse(p.x, p.y, r * 0.97, ry * 0.97, 0, 0, 6.283); x.stroke();
        x.globalCompositeOperation = 'lighter';
        x.strokeStyle = 'rgba(' + p.c + ',' + a.toFixed(3) + ')'; x.lineWidth = 2.2 * (1 - k) + 0.5;
        x.beginPath(); x.ellipse(p.x, p.y, r, ry, 0, 0, 6.283); x.stroke();
        x.strokeStyle = 'rgba(255,255,255,' + (a * 0.35).toFixed(3) + ')'; x.lineWidth = 0.8;
        x.beginPath(); x.ellipse(p.x, p.y, r * 0.9, ry * 0.9, 0, 0, 6.283); x.stroke();
      } else if (p.type === 'spark') {
        const sy = p.y - p.z * 0.5;
        x.globalAlpha = Math.max(0, 1 - k * k); x.strokeStyle = 'rgb(' + p.c + ')'; x.lineWidth = p.size || 1.2;
        x.beginPath(); x.moveTo(p.x, sy); x.lineTo(p.x - p.vx * 0.045, sy - p.vy * 0.045); x.stroke();
      } else if (p.type === 'ring') {
        x.globalAlpha = 1; x.strokeStyle = 'rgba(' + p.c + ',' + ((1 - k) * (1 - k) * 0.68).toFixed(3) + ')'; x.lineWidth = 3.5 * (1 - k) + 0.6;
        x.beginPath(); x.arc(p.x, p.y, p.size, 0, 6.283); x.stroke();
      }
    }

    // PASS 3 — foreground occlusion: soot rolls in front of the cooling fire,
    // and tumbling debris is silhouetted against it.
    x.globalCompositeOperation = 'source-over';
    for (const p of P) {
      if (!inView(p)) continue;
      const k = p.life / p.max;
      if (p.type === 'soot') {
        const a = p.alpha * Math.pow(1 - k, 1.1) * (k < 0.12 ? k / 0.12 : 1); if (a < 0.01) continue;
        const r = p.size * 2.0, py = p.y - p.life * 4;
        x.globalAlpha = Math.min(1, a);
        const tex = SPR.smokeTex ? SPR.smokeTex(p.c, p.v || 0) : SPR.puff(p.c);
        if (p.a) { x.save(); x.translate(p.x, py); x.rotate(p.a); x.drawImage(tex, -r, -r, r * 2, r * 2); x.restore(); }
        else x.drawImage(tex, p.x - r, py - r, r * 2, r * 2);
      } else if (p.type === 'debris') {
        if (p.z > 1) { x.globalAlpha = 0.28 * (1 - k); x.fillStyle = '#000'; x.fillRect(p.x - p.size * 0.4, p.y - p.size * 0.4, p.size * 0.8, p.size * 0.8); }
        x.save(); x.globalAlpha = Math.min(1, (1 - k) * 1.4); x.translate(p.x, p.y - p.z * 0.45); if (p.a) x.rotate(p.a);
        x.fillStyle = p.c; x.fillRect(-p.size * 0.6, -p.size * 0.4, p.size * 1.2, p.size * 0.8); x.restore();
      }
    }
    x.globalAlpha = 1; x.globalCompositeOperation = 'source-over';
  },
};

/* persistent ground decals: craters and scorch marks, baked into terrain chunks */
const Decals = {
  add(x, y, r, kind = 'crater') {
    const M = G.map; if (!M) return;
    M.craters.push([Math.round(x), Math.round(y), Math.round(r), kind === 'scorch' ? 1 : 0]);
    if (M.craters.length > 2500) M.craters.splice(0, 200);
    if (typeof Render !== 'undefined') Render.stampDecal(x, y, r, kind);
  },
  draw(x, cx, cy, r, kind) {
    const seed = ((cx * 73 + cy * 151) | 0) & 1023;
    if (kind === 1 || kind === 'scorch') {
      const g = x.createRadialGradient(cx, cy, 0, cx, cy, r * 1.25);
      g.addColorStop(0, 'rgba(16,14,12,0.68)');
      g.addColorStop(0.5, 'rgba(28,24,20,0.38)');
      g.addColorStop(1, 'rgba(20,18,16,0)');
      x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r * 1.25, 0, 6.283); x.fill();
      if (r >= 6) {
        x.strokeStyle = 'rgba(18,15,12,0.28)'; x.lineWidth = Math.max(0.8, r * 0.08);
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * 6.283 + hash2(seed, i, 11) * 0.7, len = r * (0.7 + hash2(seed, i, 12) * 0.65);
          x.beginPath(); x.moveTo(cx + Math.cos(a) * r * 0.2, cy + Math.sin(a) * r * 0.2);
          x.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len); x.stroke();
        }
      }
      return;
    }
    // Outer ejecta blanket & radial blast rays
    const outer = x.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 1.35);
    outer.addColorStop(0, 'rgba(35,30,24,0.45)');
    outer.addColorStop(0.55, 'rgba(78,68,54,0.28)');
    outer.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = outer; x.beginPath(); x.arc(cx, cy, r * 1.35, 0, 6.283); x.fill();
    // Raised crater rim (sunlit NW, shaded SE)
    x.strokeStyle = 'rgba(135,120,98,0.38)'; x.lineWidth = Math.max(1.2, r * 0.18);
    x.beginPath(); x.arc(cx + r * 0.04, cy + r * 0.04, r * 0.78, -0.4, 2.7); x.stroke();
    x.strokeStyle = 'rgba(25,20,16,0.52)';
    x.beginPath(); x.arc(cx - r * 0.03, cy - r * 0.03, r * 0.78, 2.7, 5.88); x.stroke();
    // Deep crater pit
    const pit = x.createRadialGradient(cx - r * 0.1, cy - r * 0.1, 0, cx, cy, r * 0.78);
    pit.addColorStop(0, 'rgba(18,15,12,0.88)');
    pit.addColorStop(0.6, 'rgba(42,36,29,0.72)');
    pit.addColorStop(0.88, 'rgba(92,80,65,0.35)');
    pit.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = pit; x.beginPath(); x.arc(cx, cy, r * 0.8, 0, 6.283); x.fill();
    // Scattered rubble clods around crater lip
    if (r >= 8) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * 6.283 + hash2(seed, i, 3) * 0.6, d = r * (0.68 + hash2(seed, i, 4) * 0.45), sz = 1 + hash2(seed, i, 5) * Math.min(3, r * 0.14);
        x.fillStyle = i % 2 ? 'rgba(45,38,32,0.65)' : 'rgba(115,102,84,0.55)';
        x.fillRect(cx + Math.cos(a) * d - sz / 2, cy + Math.sin(a) * d - sz / 2, sz, sz);
      }
    }
  },
};
