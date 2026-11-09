'use strict';
/* =====================================================================
   CITY.RA — realism.js
   One world scale for everything on the tactical layer:
     1 tile = 10 m, 1 px = 0.3125 m (TILE = 32 px).
   Every unit, structure and warhead is described here in real units
   (metres, m/s, metres of blast radius) and converted into the game's
   tiles / px / px-per-second fields, so sprites, collision, movement,
   blasts and the map scale bar all agree with each other.

   Engagement ranges keep the real-world ordering (rifle < autocannon <
   tank gun < artillery < SAM) but are compressed with a square-root
   curve, game_m = 6 * sqrt(real_m), so a 2.5 km tank shot becomes 300 m
   and fights still fit on a screen. Everything else is 1:1.
   ===================================================================== */

const SCALE = {
  M_PER_TILE: 10,
  get PX_PER_M() { return TILE / this.M_PER_TILE; },
  px(m) { return m * this.PX_PER_M; },
  tiles(m) { return m / this.M_PER_TILE; },
  m(px) { return px / this.PX_PER_M; },
  range(realM) { return 6 * Math.sqrt(realM); },        // engagement compression (metres in game)
  KM_PER_TILE: 0.01,                                     // procedural maps: 10 m per tile
};

/* units: [length m, width m, speed m/s, sight m (game), figures for infantry squads] */
const REAL_UNITS = {
  rifle: [1.2, 0.6, 4.2, 140, 4], mg: [1.2, 0.6, 3.6, 140, 3], sniper: [1.3, 0.6, 4.0, 220, 2], engineer: [1.1, 0.6, 4.0, 120, 3],
  medic: [1.0, 0.6, 4.2, 120, 2], recon: [1.2, 0.6, 5.0, 260, 3], at: [1.4, 0.6, 3.6, 140, 2], aa: [1.6, 0.6, 3.6, 160, 2],
  spec: [1.2, 0.6, 4.8, 190, 4], exo: [1.5, 0.9, 3.4, 140, 3], robosoldier: [1.4, 0.8, 5.0, 190, 2], ghost: [1.2, 0.6, 4.8, 210, 3],
  harvester: [11, 4.2, 9, 110], jeep: [4.9, 2.2, 25, 180], scout: [7, 2.9, 24, 300], apc: [7.9, 3, 22, 160], ifv: [7.4, 3.6, 18, 170],
  mbt: [9.97, 3.75, 15, 170], robotank: [8, 3.4, 18, 220], heavy: [11, 3.9, 11, 170], spg: [11.7, 3.6, 13, 160], mlrs: [7, 2.4, 22, 160],
  aatruck: [7.7, 3.3, 18, 220], engveh: [9, 3.8, 12, 140], recovery: [9, 3.5, 17, 140], supply: [8.5, 2.5, 20, 140], mammoth: [13, 5, 8, 190],
  mech: [6, 5, 14, 220], wavecutter: [26.8, 14.3, 22, 190],
  recondrone: [1.2, 1.2, 18, 400], kamikaze: [1.6, 1.8, 30, 250], ucav: [11, 20, 60, 350], robofighter: [9, 8, 120, 320], fighter: [19, 13, 120, 300],
  bomber: [48, 56, 90, 260], gunship: [17.7, 14.6, 60, 260], thelo: [30, 18.3, 55, 220], reconplane: [16, 26, 90, 420], awacs: [46, 44, 75, 1500],
  cas: [16.3, 17.5, 80, 260], stratos: [29.8, 40.4, 55, 300],
  patrol: [30, 6, 20, 260], destroyer: [150, 20, 15, 330], tship: [120, 20, 10, 220], lcraft: [41, 9, 6, 190], sub: [110, 10, 12, 220], nsupply: [170, 25, 10, 200],
};

/* weapons: [real effective range m, lethal blast radius m (0 = direct hit), real min range m] */
const REAL_WEAPONS = {
  rifle: [300, 0], carbine: [300, 0], pulserifle: [600, 0], mechgun: [2000, 0], railcannon: [5000, 0], dronebomb: [40, 6],
  pistol: [50, 0], mg: [800, 0], hmg: [1800, 0], sniper: [1000, 0], atrocket: [300, 0], manpad: [5000, 0], autocannon: [2000, 0],
  cannon: [2500, 0], hcannon: [3000, 0], artillery: [24000, 30, 700], mlrs: [40000, 25, 1000], aam: [40000, 0], agm: [8000, 0],
  bomb: [70, 40], hrockets: [8000, 10], chaingun: [1500, 0], navalgun: [24000, 15], torpedo: [20000, 0], depth: [1000, 0],
  flak: [4000, 0], patrolgun: [2000, 0], turretgun: [2500, 0], bunkermg: [800, 0], towergun: [500, 0], sam: [100000, 0], coastal: [30000, 30],
};

/* military structures: real footprint in 10 m tiles and sight in game metres.
   Sprites keep their drawn proportions and are scaled to the footprint. */
const REAL_BLDS = {
  hq: [5, 5, 250], power: [4, 4, 120], refinery: [6, 4, 120], barracks: [4, 4, 150], factory: [6, 6, 150], hangar: [24, 9, 250],
  shipyard: [6, 6, 200], radar: [3, 3, 600], lab: [4, 4, 120], datacenter: [6, 4, 150], bitcoin: [4, 4, 100], fueldepot: [4, 4, 100],
  depot: [4, 4, 120], ammo: [4, 4, 100], repair: [6, 4, 120], medical: [3, 3, 120], mine: [4, 4, 120], farm: [9, 9, 100], pump: [3, 3, 100],
  logistics: [6, 4, 120], shelter: [5, 5, 120], wall: [1, 1, 40], trench: [1, 1, 60], bunker: [1, 1, 200], tower: [1, 1, 350],
  turret: [1, 1, 250], sam: [4, 4, 400], abm: [4, 4, 500], silo: [3, 3, 150], coastal: [3, 3, 400],
};

// structures whose sprite is drawn directly at its real footprint instead of scaled up from the old design size
const NATIVE_BLDS = new Set(['hangar']);

/* strategic missiles: conventional lethal radius in metres */
const REAL_MISSILES = { cruise: 45, srbm: 50, cluster: 8, thermo: 120, ballistic: 70, hyper: 50 };

const Realism = {
  apply() { this.convert(REAL_UNITS, REAL_WEAPONS, REAL_BLDS, false); for (const k in REAL_MISSILES) if (MISSILES[k]) MISSILES[k].splash = Math.round(REAL_MISSILES[k] * SCALE.PX_PER_M); },
  // direct = ranges are already game metres (Napoleonic weapons are short-ranged enough to need no compression)
  convert(units, weapons, blds, direct) {
    const P = SCALE.PX_PER_M;
    for (const k in units) {
      const d = UNITS[k], R = units[k]; if (!d) continue;
      const [len, wid, spd, sight, figs] = R;
      d.len = len; d.wid = wid; d.spd = spd * P; d.sight = sight / SCALE.M_PER_TILE;
      // One exact 10 m tile scale everywhere: aircraft keep their real
      // fuselage length and wingspan, so robotic and crewed airframes of the
      // same physical size are drawn at the same size.
      if (d.cat === 'air') { d.viewLen = len; d.viewWid = wid; }
      else { delete d.viewLen; delete d.viewWid; }
      if (d.form) { // drilled formation: ranks x files with spacing (m)
        const [ranks, files, sx, sy] = d.form; d.figs = ranks * files;
        d.r = Math.max(4, 0.5 * Math.sqrt(Math.max(len, ranks * sy) * Math.max(wid, files * sx)) * P);
      } else if (d.cat === 'inf') { d.figs = figs || 1; d.r = 4 + (figs || 1) * 1.5; }
      else if (d.cat === 'air') d.r = Math.max(6, (Math.sqrt(d.viewLen * d.viewWid) / 2) * P);
      else d.r = Math.max(3, (Math.sqrt(len * wid) / 2) * P);
    }
    for (const k in weapons) {
      const w = WEAPONS[k], [rng, blast, min] = weapons[k]; if (!w) continue;
      if (w.proj !== 'bomb' && k !== 'dronebomb') w.rng = SCALE.tiles(direct ? rng : SCALE.range(rng));
      if (blast) w.splash = Math.round(blast * P);
      if (min) w.min = SCALE.tiles(direct ? min : SCALE.range(min));
      w.realRange = rng; w.blastM = blast || 0;
    }
    for (const k in blds) {
      const d = BLDS[k], [w, h, sight] = blds[k]; if (!d) continue;
      if (!direct && !d.sw && !NATIVE_BLDS.has(k)) { d.sw = d.w; d.sh = d.h; }
      d.w = w; d.h = h; d.sight = sight / SCALE.M_PER_TILE;
      if (d.healR) d.healR = Math.max(d.healR, w / 2 + 3);
      if (d.fixR) d.fixR = Math.max(d.fixR, w / 2 + 3);
      if (d.supplyR) d.supplyR = d.supplyR * 2;
    }
  },
  // short human description of a unit's real size for tooltips
  sizeText(d) {
    if (!d || !d.len) return '';
    if (d.figs > 1) return d.figs + (d.cat === 'inf' ? ' soldiers' : ' riders') + ' · ' + Math.round(SCALE.m(d.spd) * 3.6) + ' km/h';
    return d.len.toFixed(d.len < 10 ? 1 : 0) + ' × ' + d.wid.toFixed(1) + ' m · ' + Math.round(SCALE.m(d.spd) * 3.6) + ' km/h';
  },
};
Realism.apply();
