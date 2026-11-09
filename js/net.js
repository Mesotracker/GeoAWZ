'use strict';
/* =====================================================================
   CITY.RA — net.js
   Multiplayer. The host runs the one authoritative simulation; every
   other player is a thin client that renders the host's world and sends
   its orders back. No lockstep, so the non-deterministic simulation
   (random spread, AI) never drifts between machines.

   Transports
     · Cloud relay (default, works on GitHub Pages): an HTTPS relay on the
       free public smee.io service. Every player opens one Server-Sent
       Events stream and posts orders/snapshots back to the same channel.
       Works across devices and networks with no install, account, port
       forwarding, same-Wi-Fi requirement or WebRTC NAT traversal.
     · Peer-to-peer: WebRTC data channels through the free PeerJS broker.
       Faster when a direct route exists, but strict NATs can block it.
     · Same computer: BroadcastChannel between browser tabs / windows.
     · Relay server: self-hosted WebSocket relay — `python3 server.py` or
       `node server.js` serves the game and relays room traffic.

   Traffic (host → clients): one full save at start, then ~8 snapshots/s
   of units (delta-coded), projectiles as spawn events the client flies
   itself, explosions / decals / sounds as events, structures twice a
   second, and factions, settlements, diplomacy and territory every 1–2 s.
   Clients → host: game actions as RPCs, validated against the sender's
   nation before they run.
   ===================================================================== */

const Act = {
  primary(fi, prod, id) { const f = fac(fi); if (f) f.primary[prod] = id; },
  fundRebuild(P, sid) { const f = fac(P), s = G.settlements[sid]; if (!f || !s || f.res.materials < 200) return; f.res.materials -= 200; s.stock.materials += 200; Civ.blame(P, s, 6, 1.5); },
  airdrop(P, cid) { const f = fac(P), c = G.ents.get(cid); if (!f || !c || f.res.supplies < 150 || f.res.food < 80) return; f.res.supplies -= 150; f.res.food -= 80; Civ.aid(c, P, 1); },
  buyFood(P, sid) { const f = fac(P), s = G.settlements[sid]; if (!f || !s || s.stock.food < 150 || f.res.credits < 300) return; f.res.credits -= 300; s.cash += 300; s.stock.food -= 150; f.res.food += 150; },
  buyMat(P, sid) { const f = fac(P), s = G.settlements[sid]; if (!f || !s || s.stock.materials < 150 || f.res.credits < 400) return; f.res.credits -= 400; s.cash += 400; s.stock.materials -= 150; f.res.materials += 150; },
  set(id, prop, val) { const e = G.ents.get(id); if (e && (prop === 'rally' || prop === 'repairing')) e[prop] = val; },
  speed(s) { G.speed = U.clamp(s, 0.5, 4); },
  pause(p) { G.paused = !!p; },
};

/* ---------------- transports ---------------- */
class LocalLink {
  constructor(room, onMsg) { this.id = 'L' + Math.random().toString(36).slice(2, 8); this.ch = new BroadcastChannel('cityra-room-' + room); this.ch.onmessage = (e) => { const m = e.data; if (m.to && m.to !== this.id) return; onMsg(m.from, m.d); }; setTimeout(() => onMsg(null, { t: 'open' }), 0); }
  send(d, to) { this.ch.postMessage({ from: this.id, to: to || null, d }); }
  close() { this.ch.close(); }
}
class WsLink {
  constructor(url, room, onMsg) {
    this.id = null; this.ws = new WebSocket(url + (url.includes('?') ? '&' : '?') + 'room=' + encodeURIComponent(room));
    this.ws.onmessage = (e) => { const s = String(e.data), i = s.indexOf('|'), from = s.slice(0, i), d = JSON.parse(s.slice(i + 1)); if (from === '0' && d.t === 'welcome') { this.id = d.id; onMsg(null, { t: 'open' }); return; } onMsg(from === '0' ? null : from, d); };
    this.ws.onclose = () => onMsg(null, { t: 'closed' });
    this.ws.onerror = () => onMsg(null, { t: 'error' });
  }
  send(d, to) { if (this.ws.readyState === 1) this.ws.send((to ? '@' + to + '|' : '') + JSON.stringify(d)); }
  close() { try { this.ws.close(); } catch (e) { /* closed */ } }
}

/* Online relay: smee.io is a free public HTTPS relay that needs no account or
   installation. A channel is just a name: everyone opens one EventSource and
   POSTs outgoing messages to the same URL, and smee broadcasts each message to
   every listener. Channels only exist while players are connected, so there is
   no room server to run and no same-network requirement. Messages carry the
   sender id, so a player ignores the echo of their own posts. Large messages
   (the initial save on a big map) are split into ordered chunks. */
const CLOUD_PREFIX = 'cityra-v3-';
class CloudLink {
  constructor(room, onMsg) {
    this.id = 'C' + Math.random().toString(36).slice(2, 10);
    this.onMsg = onMsg; this.seq = 0; this.chunkSeq = 0; this.chunks = {};
    this.q = []; this.sending = false; this.fails = 0; this.ready = false; this.dead = false;
    this.url = 'https://smee.io/' + CLOUD_PREFIX + encodeURIComponent(room);
    try { this.es = new EventSource(this.url); }
    catch (e) { setTimeout(() => onMsg(null, { t: 'error', why: 'this browser cannot open a cloud relay stream' }), 0); return; }
    this.timer = setTimeout(() => { if (!this.ready && !this.dead) onMsg(null, { t: 'error', why: 'could not reach the cloud relay — check your internet connection' }); }, 15000);
    this.es.addEventListener('ready', () => this.up());
    this.es.onopen = () => this.up();
    this.es.onmessage = (e) => this.onData(e.data);
    this.es.onerror = () => { if (!this.dead) this.onMsg(null, { t: 'cloudStatus', why: this.ready ? 'Cloud relay lost — reconnecting…' : 'Connecting to the cloud relay…' }); };
  }
  up() { if (this.dead) return; this.ready = true; clearTimeout(this.timer); this.onMsg(null, { t: 'open' }); }
  onData(raw) {
    let ev; try { ev = JSON.parse(raw); } catch (e) { return; }
    const body = typeof ev.body === 'string' ? ev.body : ev.body ? JSON.stringify(ev.body) : '';
    if (!body) return;
    let m; try { m = JSON.parse(body); } catch (e) { return; }
    if (!m || m.f === this.id) return;
    if (m.chunk != null) return this.onChunk(m);
    this.deliver(m);
  }
  onChunk(m) {
    const key = m.f + ':' + m.chunk;
    let c = this.chunks[key];
    if (!c) c = this.chunks[key] = { n: m.n, parts: [], got: 0 };
    if (m.i >= 0 && m.i < c.n && c.parts[m.i] == null) { c.parts[m.i] = m.data; c.got++; }
    if (c.got !== c.n) return;
    delete this.chunks[key];
    try { this.deliver(JSON.parse(c.parts.join(''))); } catch (e) { /* partial or corrupt */ }
  }
  deliver(m) { if (m && m.f !== this.id && (!m.to || m.to === this.id)) this.onMsg(m.f, m.d); }
  send(d, to) {
    if (this.dead) return;
    const env = JSON.stringify({ f: this.id, to: to || null, n: ++this.seq, d });
    if (d.t === 'bye' || d.t === 'closed') return this.post(env, true);
    // smee's JSON body limit is 100 KB, including the JSON escaping of the
    // chunk's data string, so keep raw chunks comfortably below it.
    const max = 60000;
    if (env.length <= max) this.enqueue({ body: env, snap: d.t === 'snap' });
    else {
      const id = this.id + '-' + (++this.chunkSeq), n = Math.ceil(env.length / max);
      for (let i = 0; i < n; i++) this.enqueue({ body: JSON.stringify({ f: this.id, to: to || null, chunk: id, i, n, data: env.slice(i * max, (i + 1) * max) }), snap: false });
    }
  }
  enqueue(item) {
    // Coalesce a queued snapshot with the next one: a slow link should catch up
    // on the latest world, not replay every stale frame. Order is preserved.
    if (item.snap && this.q.length && this.q[this.q.length - 1].snap) this.q[this.q.length - 1] = item;
    else this.q.push(item);
    this.pump();
  }
  pump() {
    if (this.sending || !this.q.length || this.dead) return;
    this.sending = true;
    fetch(this.url, { method: 'POST', mode: 'cors', headers: { 'Content-Type': 'application/json' }, body: this.q.shift().body })
      .then((r) => { if (!r.ok) throw new Error('relay ' + r.status); this.fails = 0; })
      .catch(() => { this.fails++; if (this.fails === 3 && !this.dead) this.onMsg(null, { t: 'cloudStatus', why: 'Cloud relay is slow or refusing messages — retrying…' }); })
      .finally(() => { this.sending = false; if (!this.dead) this.pump(); });
  }
  post(body, keepalive) { fetch(this.url, { method: 'POST', mode: 'cors', headers: { 'Content-Type': 'application/json' }, body, keepalive: !!keepalive }).catch(() => {}); }
  close() { this.dead = true; clearTimeout(this.timer); try { this.es.close(); } catch (e) { /* gone */ } this.q.length = 0; }
}

// Peer-to-peer: PeerJS (WebRTC) loaded on demand, from cdnjs with unpkg as a fallback
const PEER_PREFIX = 'cityra-v2-';
function loadPeerJs() {
  if (window.Peer) return Promise.resolve();
  const urls = ['https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.4/peerjs.min.js', 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js'];
  return new Promise((res, rej) => {
    const next = () => { const u = urls.shift(); if (!u) return rej(new Error('could not load the PeerJS library — check your connection')); const sc = document.createElement('script'); sc.src = u; sc.onload = () => (window.Peer ? res() : next()); sc.onerror = () => { sc.remove(); next(); }; document.head.appendChild(sc); };
    next();
  });
}
class PeerLink {
  constructor(room, host, onMsg) {
    this.onMsg = onMsg; this.host = host; this.conns = new Map(); this.id = null; this.dead = false;
    loadPeerJs().then(() => this.start(room)).catch((e) => onMsg(null, { t: 'error', why: e.message }));
  }
  start(room) {
    if (this.dead) return;
    const P = window.Peer, cfg = { debug: 0, config: { iceServers: [
      { urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' },
    ] } };
    this.peer = this.host ? new P(PEER_PREFIX + room, cfg) : new P(cfg);
    this.peer.on('open', (id) => {
      this.id = id;
      if (this.host) return this.onMsg(null, { t: 'open' });
      const c = this.peer.connect(PEER_PREFIX + room, { reliable: true });
      this.wire(c); c.on('open', () => this.onMsg(null, { t: 'open' }));
    });
    if (this.host) this.peer.on('connection', (c) => this.wire(c));
    this.peer.on('error', (e) => this.onMsg(null, { t: 'error', why: e.type === 'unavailable-id' ? 'that join code is already in use — host again for a new one' : e.type === 'peer-unavailable' ? 'no game is hosted under that code' : e.type === 'network' || e.type === 'server-error' ? 'could not reach the matchmaking server' : 'connection error (' + e.type + ')' }));
    // losing the broker only stops new players joining; open data channels carry on
    this.peer.on('disconnected', () => { if (!this.dead) try { this.peer.reconnect(); } catch (e) { /* retry later */ } });
  }
  wire(c) {
    c.on('open', () => this.conns.set(c.peer, c));
    c.on('data', (s) => { let d; try { d = typeof s === 'string' ? JSON.parse(s) : s; } catch (e) { return; } this.onMsg(this.host ? c.peer : null, d); });
    c.on('close', () => { this.conns.delete(c.peer); if (!this.dead) this.onMsg(this.host ? c.peer : null, { t: this.host ? 'bye' : 'closed' }); });
  }
  send(d, to) { const s = JSON.stringify(d); for (const [id, c] of this.conns) if ((!to || id === to) && c.open) c.send(s); }
  close() { this.dead = true; try { if (this.peer) this.peer.destroy(); } catch (e) { /* gone */ } }
}
const joinCode = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 5; i++) s += A[(Math.random() * A.length) | 0]; return s; };

const NET_RPC = ['Orders.move', 'Orders.attack', 'Orders.fireAt', 'Orders.stop', 'Orders.guard', 'Orders.scatter', 'Orders.patrol', 'Orders.task', 'Orders.board', 'Orders.harvestAt', 'Orders.retreat', 'Orders.unload', 'Orders.rtb',
  'Eco.queue', 'Eco.place', 'Eco.cancel', 'Eco.sell', 'Eco.upgrade', 'Eco.startResearch', 'Eco.pay', 'World.addBld', 'Strike.arm', 'Strike.launch', 'Dip.propose', 'Dip.accept', 'Civ.startEvac',
  'Market.buy', 'Market.sell', 'Market.investCity', 'AILab.startRun', 'AILab.buySpec', 'AILab.buyInfra',
  'Act.primary', 'Act.fundRebuild', 'Act.airdrop', 'Act.buyFood', 'Act.buyMat', 'Act.set', 'Act.speed', 'Act.pause'];
// what the client-side stub returns while the host carries the action out
const NET_RET = { 'Strike.arm': [true, ''], 'Dip.propose': [null, 'Proposal sent'], 'Orders.task': undefined };
const NET_SCOPE = () => ({ Orders, Eco, World, Strike, Dip, Civ, Market, AILab, Act });

const Net = {
  active: false, host: false, client: false, link: null, room: '', name: 'Commander', peers: {}, me: null, faction: 0,
  transport: 'online', url: '', status: '', lobby: null, chat: [], startMsg: null, helloT: null,

  /* ---------- lobby ---------- */
  render() {
    const el = $('mpbody'); if (!el) return;
    const st = this.active ? (this.host ? 'Hosting room ' + this.room : 'Joined room ' + this.room) : 'Not connected';
    const defUrl = this.url || (location.protocol.startsWith('http') ? (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws' : 'ws://localhost:8080/ws');
    const peers = Object.values(this.peers);
    const o = Menu.opts, slots = [o.player, ...o.ais.map((a) => a.key)];
    el.innerHTML = `
      <p class="sub small">The host runs the battle; everyone else joins with the host’s code. <b>Cloud relay</b> (default) carries the game through a free public HTTPS relay, so players on different Wi-Fi, mobile networks or behind firewalls can join — nothing to install. <b>Peer-to-peer</b> tries a direct WebRTC link (faster when it works). <b>Same computer</b> links browser tabs. <b>Self-hosted relay</b> runs <code>python3 server.py</code> in the game folder.</p>
      ${this.host && this.room ? `<div class="joincode"><span>Join code</span><b>${U.esc(this.room)}</b><button class="cmd" id="mp-copy" type="button">Copy invite link</button></div>` : ''}
      <div class="grid2">
        <label>Your name <input id="mp-name" value="${U.esc(this.name)}" maxlength="20"></label>
        <label>Connection <select id="mp-tr"><option value="online" ${this.transport === 'online' ? 'selected' : ''}>Cloud relay (no setup)</option><option value="p2p" ${this.transport === 'p2p' ? 'selected' : ''}>Peer-to-peer (WebRTC)</option><option value="local" ${this.transport === 'local' ? 'selected' : ''}>Same computer (tabs)</option><option value="ws" ${this.transport === 'ws' ? 'selected' : ''}>Self-hosted relay</option></select></label>
        <label ${this.transport === 'ws' ? '' : 'hidden'}>Relay address <input id="mp-url" value="${U.esc(defUrl)}"></label>
        <label ${this.host ? 'hidden' : ''}>Join code <input id="mp-room" value="${U.esc(this.room || '')}" placeholder="5 letters, e.g. K7QPX" maxlength="16" autocomplete="off"></label>
      </div>
      <div class="row">${this.active ? `<button class="cmd warn" id="mp-leave">Leave</button>` : `<button class="cmd hi" id="mp-host">Host a game</button><button class="cmd" id="mp-join">Join</button>`}</div>
      <p class="sub small" id="mp-st"><b>${U.esc(st)}</b>${this.status ? ' · ' + U.esc(this.status) : ''}</p>
      ${this.host ? `<h4>Players</h4><table class="mpt"><tr><td>${U.esc(this.name)} (host)</td><td>${U.esc(FACTIONS[o.player].name)}</td></tr>${peers.map((p) => `<tr><td>${U.esc(p.name)}</td><td><select data-peer="${p.id}">${slots.map((k, i) => i === 0 ? '' : `<option value="${i}" ${p.slot === i ? 'selected' : ''}>${U.esc(FACTIONS[k].name)}</option>`).join('')}<option value="-1" ${p.slot === -1 ? 'selected' : ''}>Spectate</option></select></td></tr>`).join('')}</table>
        <p class="sub small">Each player takes one opponent slot from the setup screen (add opponents there for more seats). Unclaimed slots stay AI. Close this window to change the map, era or mode; the room stays open.</p>
        <div class="row"><button class="cmd hi" id="mp-start" ${peers.length ? '' : 'disabled'}>Start multiplayer battle</button></div>` : ''}
      ${this.client && this.lobby ? `<h4>Lobby</h4><p class="sub">${U.esc(this.lobby.mode)} · ${U.esc(this.lobby.era)}</p><table class="mpt">${this.lobby.players.map((p) => `<tr><td>${U.esc(p.name)}</td><td>${U.esc(p.faction)}</td></tr>`).join('')}</table><p class="sub small">Waiting for the host to start…</p>` : ''}
      ${this.active ? `<div class="chatlog">${this.chat.slice(-8).map((c) => `<div><b>${U.esc(c.n)}:</b> ${U.esc(c.m)}</div>`).join('')}</div><div class="row"><input id="mp-chat" placeholder="Message" maxlength="140"><button class="cmd" id="mp-say">Send</button></div>` : ''}`;
    const read = () => { this.name = ($('mp-name').value || 'Commander').trim().slice(0, 20); this.transport = $('mp-tr').value; this.url = $('mp-url') ? $('mp-url').value.trim() : this.url; this.room = ($('mp-room').value || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, ''); Store.set('mp', { name: this.name, transport: this.transport, url: this.url }); };
    $('mp-tr').onchange = () => { read(); this.render(); };
    if ($('mp-host')) $('mp-host').onclick = () => { read(); this.room = joinCode(); this.open(true); };
    if ($('mp-copy')) $('mp-copy').onclick = () => { const link = location.origin + location.pathname + '?join=' + this.room + (this.transport === 'online' ? '' : '&via=' + this.transport); (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(() => { this.status = 'Invite link copied'; this.render(); }, () => { this.status = 'Share this link: ' + link; this.render(); }); };
    if ($('mp-join')) $('mp-join').onclick = () => { read(); if (!this.room) { this.status = 'Enter the host’s room code'; return this.render(); } this.open(false); };
    if ($('mp-leave')) $('mp-leave').onclick = () => this.leave();
    if ($('mp-start')) $('mp-start').onclick = () => this.startGame();
    el.querySelectorAll('[data-peer]').forEach((s) => (s.onchange = () => { this.peers[s.dataset.peer].slot = +s.value; this.pushLobby(); }));
    const say = () => { const v = $('mp-chat').value.trim(); if (!v) return; this.say(v); $('mp-chat').value = ''; };
    if ($('mp-say')) { $('mp-say').onclick = say; $('mp-chat').onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') say(); }; }
  },
  open(asHost) {
    this.leave(true);
    this.host = asHost; this.client = !asHost; this.active = true; this.peers = {}; this.status = 'Connecting…'; this.chat = [];
    Game.backgroundClock(true);
    const on = (from, d) => this.recv(from, d);
    try { this.link = this.transport === 'ws' ? new WsLink(this.url || ('ws://' + location.host + '/ws'), this.room, on) : this.transport === 'p2p' ? new PeerLink(this.room, asHost, on) : this.transport === 'local' ? new LocalLink(this.room, on) : new CloudLink(this.room, on); }
    catch (e) { this.status = 'Could not connect: ' + e.message; this.active = false; }
    this.render();
  },
  leave(quiet) {
    if (this.link) { if (this.client) this.link.send({ t: 'bye' }); else if (this.host) this.link.send({ t: 'closed' }); this.link.close(); }
    const wasClient = this.client && G.running;
    clearInterval(this.helloT); this.helloT = null; this.startMsg = null;
    this.link = null; this.active = false; this.host = false; this.client = false; this.peers = {}; this.lobby = null;
    Game.backgroundClock(false);
    if (!quiet) { this.status = 'Left the room'; this.render(); }
    if (wasClient) { G.running = false; UI.closeWins(); $('game').hidden = true; Menu.show(); }
  },
  say(m) { const c = { n: this.name, m }; this.chat.push(c); this.send({ t: 'chat', n: c.n, m }); if (G.running) UI.msg(c.n + ': ' + m, 'info'); this.render(); },
  send(d, to) { if (this.link) this.link.send(d, to); },

  pushLobby() {
    if (!this.host) return;
    const o = Menu.opts, slots = [o.player, ...o.ais.map((a) => a.key)];
    const players = [{ name: this.name + ' (host)', faction: FACTIONS[o.player].name }, ...Object.values(this.peers).map((p) => ({ name: p.name, faction: p.slot >= 0 ? FACTIONS[slots[p.slot]].name : 'Spectator' }))];
    this.send({ t: 'lobby', mode: MODES[o.mode].name, era: Era.label(Era.key), players });
    this.render();
  },

  recv(from, d) {
    switch (d.t) {
      case 'open': {
        this.active = true;
        this.status = this.host ? 'Waiting for players — share the join code ' + this.room : 'Connected, saying hello…';
        if (this.client) {
          this.send({ t: 'hello', name: this.name });
          clearInterval(this.helloT); let tries = 0;
          this.helloT = setInterval(() => {
            if (!this.active || !this.client || this.lobby || this.ready || ++tries > 8) { clearInterval(this.helloT); this.helloT = null; return; }
            this.send({ t: 'hello', name: this.name });
          }, 2000);
        }
        this.render(); break; }
      case 'cloudStatus': this.status = d.why || this.status; this.render(); break;
      case 'closed': case 'error': if (this.client || d.t === 'error') {
        this.status = d.t === 'error' ? 'Connection failed: ' + (d.why || (this.transport === 'ws' ? 'is the relay running?' : 'unknown error')) : 'The host closed the room';
        if (this.client && G.running) { UI.msg('Disconnected from host', 'bad'); G.running = false; Game.backgroundClock(false); UI.closeWins(); $('game').hidden = true; Menu.show(); }
        this.active = false; clearInterval(this.helloT); this.helloT = null; this.render();
      } break;
      case 'hello': if (!this.host) break; {
        const prev = this.peers[from];
        if (prev) { prev.name = String(d.name || prev.name || 'Player').slice(0, 20); this.status = prev.name + ' reconnected'; this.pushLobby(); if (this.startMsg) this.sendStart(from); break; }
        const o = Menu.opts, taken = new Set(Object.values(this.peers).map((p) => p.slot)), free = o.ais.findIndex((a, i) => !taken.has(i + 1));
        this.peers[from] = { id: from, name: String(d.name || 'Player').slice(0, 20), slot: free >= 0 ? free + 1 : -1 };
        this.status = this.peers[from].name + ' joined'; this.pushLobby(); if (this.startMsg) this.sendStart(from); break; }
      case 'bye': if (this.host && this.peers[from]) { const p = this.peers[from]; delete this.peers[from]; this.status = p.name + ' left'; if (G.running && p.slot > 0 && fac(p.slot)) { fac(p.slot).human = false; UI.msg(p.name + ' left — their nation is now under AI command', 'warn'); const f = fac(p.slot); f.isAI = true; AI.setup(f, 'normal'); } this.pushLobby(); } break;
      case 'lobby': if (this.client) { this.lobby = d; this.status = 'In the lobby — waiting for the host'; clearInterval(this.helloT); this.helloT = null; this.render(); } break;
      case 'chat': this.chat.push({ n: d.n, m: d.m }); if (G.running) UI.msg(d.n + ': ' + d.m, 'info'); else this.render(); break;
      case 'start': if (this.client) { this.status = 'In battle'; clearInterval(this.helloT); this.helloT = null; this.clientStart(d); } break;
      case 'snap': if (this.client && this.ready) this.apply(d); break;
      case 'rpc': if (this.host) this.exec(from, d); break;
    }
  },

  /* ---------- host ---------- */
  startGame() {
    const o = Object.assign({}, Menu.opts), peers = Object.values(this.peers);
    o.humans = peers.filter((p) => p.slot > 0).map((p) => p.slot);
    Store.set('lastSetup', { ...o, seed: undefined });
    UI.closeWins();
    Game.start(o);
    this.sent = {}; this.acc = 0; this.slowAcc = 0; this.ev = []; this.tick = 0;
    const save = SaveLoad.serialize(), assign = {};
    for (const p of peers) assign[p.id] = p.slot;
    this.startMsg = { t: 'start', save, assign, names: Object.fromEntries(peers.map((p) => [p.slot, p.name])) };
    this.send(this.startMsg);
    this.status = 'Battle in progress — ' + peers.length + ' connected';
    UI.msg('Multiplayer battle started — ' + peers.length + ' player' + (peers.length > 1 ? 's' : '') + ' connected', 'good');
  },
  // a late join or a reconnect needs the same start save; unknown peers spectate
  sendStart(to) {
    if (!this.startMsg) return;
    if (to && this.startMsg.assign[to] == null) this.startMsg.assign[to] = -1;
    this.send(this.startMsg, to);
  },
  // serialize call arguments: entities, factions and settlements travel as ids
  enc(v) {
    if (v == null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => this.enc(x));
    if (v.kind && v.id != null && G.ents.get(v.id) === v) return { $e: v.id };
    if (v.q && v.res && v.tech) return { $f: v.id };
    if (v.blds && v.rep && v.id != null && G.settlements[v.id] === v) return { $s: v.id };
    const o = {}; for (const k in v) o[k] = this.enc(v[k]); return o;
  },
  dec(v) {
    if (v == null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => this.dec(x)).filter((x) => x !== undefined);
    if (v.$e != null) return G.ents.get(v.$e);
    if (v.$f != null) return fac(v.$f);
    if (v.$s != null) return G.settlements[v.$s];
    const o = {}; for (const k in v) o[k] = this.dec(v[k]); return o;
  },
  // run a client's action as that nation, after checking it only touches what it owns
  exec(from, d) {
    const p = this.peers[from]; if (!p || p.slot <= 0 || !NET_RPC.includes(d.fn)) return;
    const fi = p.slot, args = this.dec(d.a), [o, m] = d.fn.split('.'), obj = NET_SCOPE()[o];
    if (!obj || !obj['_net_' + m] || !fac(fi) || !fac(fi).alive) return;
    const mine = (e) => e && e.owner === fi;
    if (o === 'Orders') { if (Array.isArray(args[0])) { args[0] = args[0].filter(mine); if (!args[0].length) return; } else if (!mine(args[0])) return; }
    else if (o === 'Eco' && m !== 'sell' && m !== 'upgrade') { if (args[0] !== fac(fi)) return; }
    else if ((o === 'Eco' || o === 'Strike') && !mine(args[0])) return;
    else if (o === 'AILab' && args[0] !== fac(fi)) return;
    else if (d.fn === 'World.addBld' && args[1] !== fi) return;
    else if (d.fn === 'Act.set' && !mine(G.ents.get(args[0]))) return;
    else if (d.fn === 'Act.speed' || d.fn === 'Act.pause') return; // the host keeps the clock
    if (o === 'Dip') args[0] = fi;
    if (['Act.fundRebuild', 'Act.airdrop', 'Act.buyFood', 'Act.buyMat', 'Act.primary'].includes(d.fn)) args[0] = fi;
    if (d.fn === 'Civ.startEvac') args[1] = fi;
    const was = G.player; G.player = fi;
    try { obj['_net_' + m].apply(obj, args); } catch (e) { console.warn('rpc', d.fn, e); }
    G.player = was;
  },
  hostRecord(ev) { if (this.host && G.running && Object.keys(this.peers).length) this.ev.push(ev); },
  hostFrame(dt) {
    if (!G.running || !Object.keys(this.peers).length) return;
    this.acc += dt; if (this.acc < 0.12) return; this.acc = 0; this.tick++;
    const s = { t: 'snap', time: G.time, hour: G.hour, day: G.day, speed: G.speed, paused: G.paused, w: G.weather, u: [], ids: [], ev: this.ev };
    this.ev = [];
    const R = (v, k = 1) => Math.round(v * k);
    for (const u of G.units) {
      if (u.dead) continue; s.ids.push(u.id);
      const row = [u.id, u.type, u.owner, R(u.x), R(u.y), R(u.a, 100), R(u.ta, 100), R(u.hp), u.maxHp, R(u.alt, 100), u.moving ? 1 : 0, u.ammo, u.vet, R(u.supp), R(u.morale), u.cargo.slice(), u.inside || 0, R(u.harv), u.state, u.rad];
      const key = row.join(',');
      if (this.sent['u' + u.id] !== key || this.tick % 20 === 0) { this.sent['u' + u.id] = key; s.u.push(row); }
    }
    if (this.tick % 4 === 0) {
      s.b = []; s.bids = [];
      for (const b of G.blds) { if (b.dead) continue; s.bids.push(b.id); const o = {}; for (const k in b) if (k !== 'd' && k !== 'path') o[k] = b[k]; const key = JSON.stringify(o); if (this.sent['b' + b.id] !== key || this.tick % 40 === 0) { this.sent['b' + b.id] = key; s.b.push(o); } }
      s.c = []; for (const c of G.civb) { const row = [c.id, R(c.hp), c.rubble ? 1 : 0, c.ctrl, R(c.capP || 0), c.capF == null ? -1 : c.capF, R(c.burn || 0, 10), c.abandoned ? 1 : 0]; const key = row.join(','); if (this.sent['c' + c.id] !== key) { this.sent['c' + c.id] = key; s.c.push(row); } }
    }
    if (this.tick % 8 === 0) {
      s.f = G.factions.map((f) => { const o = {}; for (const k in f) if (k !== 'ai') o[k] = f[k]; o.tech = [...f.tech]; return o; });
      s.dip = G.dip;
    }
    if (this.tick % 16 === 0) {
      s.st = G.settlements; s.br = G.bridges.map((b) => [b.id, R(b.hp), b.broken ? 1 : 0]); s.wr = G.wrecks.map((w) => ({ id: w.id, type: w.type, owner: w.owner, x: R(w.x), y: R(w.y), a: w.a, t: w.t, burn: w.burn }));
      s.cl = this.rle(G.map.claim); s.zones = G.zones; s.road = this.tick % 64 === 0 ? this.rle(G.map.road) : null;
    }
    this.send(s);
  },
  rle(a) { const out = []; let v = a[0], n = 0; for (let i = 0; i < a.length; i++) { if (a[i] === v && n < 65535) n++; else { out.push(v, n); v = a[i]; n = 1; } } out.push(v, n); return out; },
  unrle(r, dst) { let p = 0; for (let i = 0; i < r.length; i += 2) { dst.fill(r[i], p, p + r[i + 1]); p += r[i + 1]; } },

  /* ---------- client ---------- */
  clientStart(d) {
    const slot = d.assign[this.link.id]; if (slot == null) return;
    this.ready = false;
    UI.closeWins();
    SaveLoad.restore(d.save);
    this.faction = slot < 0 ? 0 : slot; this.spectator = slot < 0;
    G.player = this.faction; G.paused = false;
    Modes.setup(Game.opts, true); Vis.init(G.map, G.factions.length); Vis.update(); Render.terrDirty = true;
    G.proj = []; FX.parts.length = 0;
    const hq = G.blds.find((b) => b.owner === G.player && b.type === 'hq') || G.units.find((u) => u.owner === G.player);
    if (hq) UI.centerOn(hq.x, hq.y);
    UI.buildTabs(); this.ready = true; this.objT = 0; this.visT = 0;
    UI.msg('Joined the battle as ' + fac(G.player).name + (this.spectator ? ' (spectating)' : ''), 'good');
  },
  mkUnit(r) {
    const d = UNITS[r[1]]; if (!d) return null;
    const u = { id: r[0], kind: 'unit', type: r[1], d, owner: r[2], x: r[3], y: r[4], a: r[5] / 100, ta: r[6] / 100, hp: r[7], maxHp: r[8], alt: r[9] / 100, rad: r[19] || d.r, anim: Math.random() * 10,
      cargo: [], cool: d.w.map(() => 0), state: 'idle', xp: 0, morale: 100, supp: 0, ammo: d.ammo, vet: 0, lastFire: -99, lastHit: -99, inside: 0, harv: 0, path: null, ord: null };
    G.ents.set(u.id, u); G.units.push(u); return u;
  },
  apply(s) {
    G.time = s.time; G.hour = s.hour; G.day = s.day; G.weather = s.w; G.speed = s.speed; this.hostPaused = s.paused;
    for (const r of s.u) {
      let u = G.ents.get(r[0]); if (!u || u.kind !== 'unit') u = this.mkUnit(r); if (!u) continue;
      u.owner = r[2]; u.nx = r[3]; u.ny = r[4]; u.na = r[5] / 100; u.nta = r[6] / 100; u.hp = r[7]; u.maxHp = r[8]; u.alt = r[9] / 100; u.moving = !!r[10]; u.ammo = r[11]; u.vet = r[12]; u.supp = r[13]; u.morale = r[14]; u.cargo = r[15]; u.inside = r[16]; u.harv = r[17]; u.state = r[18]; u.rad = r[19] || u.rad;
      if (Math.hypot(u.nx - u.x, u.ny - u.y) > 260) { u.x = u.nx; u.y = u.ny; }
    }
    const alive = new Set(s.ids);
    if (G.units.some((u) => !alive.has(u.id))) { for (const u of G.units) if (!alive.has(u.id)) { u.dead = true; G.ents.delete(u.id); } G.units = G.units.filter((u) => !u.dead); G.sel = G.sel.filter((e) => !e.dead); }
    if (s.b) {
      for (const o of s.b) {
        let b = G.ents.get(o.id);
        if (!b) { b = Object.assign({ d: BLDS[o.type] }, o); G.ents.set(b.id, b); G.blds.push(b); for (let y = b.ty; y < b.ty + b.h; y++) for (let x = b.tx; x < b.tx + b.w; x++) G.map.occ[y * G.map.w + x] = b.id; Render.clearTrees && Render.clearTrees(b.tx, b.ty, b.w, b.h); }
        else Object.assign(b, o);
      }
      const bl = new Set(s.bids);
      for (const b of G.blds) if (!bl.has(b.id)) { b.dead = true; G.ents.delete(b.id); for (let y = b.ty; y < b.ty + b.h; y++) for (let x = b.tx; x < b.tx + b.w; x++) if (G.map.occ[y * G.map.w + x] === b.id) G.map.occ[y * G.map.w + x] = 0; }
      if (G.blds.some((b) => b.dead)) { G.blds = G.blds.filter((b) => !b.dead); G.sel = G.sel.filter((e) => !e.dead); }
    }
    if (s.c) for (const r of s.c) { const c = G.ents.get(r[0]); if (!c) continue; const wasRubble = c.rubble; c.hp = r[1]; c.rubble = !!r[2]; c.ctrl = r[3]; c.capP = r[4]; c.capF = r[5]; c.burn = r[6] / 10; c.abandoned = !!r[7]; if (c.rubble !== wasRubble) Render.invalidate && Render.invalidate(c.tx, c.ty, Math.max(c.w, c.h) + 1); }
    if (s.f) for (let i = 0; i < s.f.length; i++) { const f = G.factions[i]; if (!f) continue; const ai = f.ai, human = f.human; Object.assign(f, s.f[i]); f.tech = new Set(s.f[i].tech); f.ai = ai; f.human = human; }
    if (s.dip) G.dip = s.dip;
    if (s.st) for (let i = 0; i < s.st.length; i++) if (G.settlements[i]) Object.assign(G.settlements[i], s.st[i]);
    if (s.br) for (const [id, hp, broken] of s.br) { const b = G.ents.get(id); if (b) { b.hp = hp; b.broken = !!broken; } }
    if (s.wr) { for (const w of s.wr) if (!G.ents.has(w.id)) { w.kind = 'wreck'; G.ents.set(w.id, w); G.wrecks.push(w); } const wl = new Set(s.wr.map((w) => w.id)); G.wrecks = G.wrecks.filter((w) => { if (!wl.has(w.id)) { G.ents.delete(w.id); return false; } return true; }); }
    if (s.cl) { this.unrle(s.cl, G.map.claim); Render.terrDirty = true; Render.miniDirty = true; }
    if (s.zones) G.zones = s.zones;
    if (s.road) { const before = G.map.road.slice(); this.unrle(s.road, G.map.road); for (let i = 0; i < before.length; i++) if (before[i] !== G.map.road[i]) Render.invalidate && Render.invalidate(i % G.map.w, (i / G.map.w) | 0, 1); }
    for (const e of s.ev) this.play(e);
  },
  play(e) {
    switch (e[0]) {
      case 'x': FX.explosion(e[1], e[2], e[3], { dark: !!e[4] }); break;
      case 'd': Decals.add(e[1], e[2], e[3], e[4]); break;
      case 's': Sound.play(e[1], e[2], e[3], e[4]); break;
      case 'm': FX.muzzle(e[1], e[2], e[3], !!e[4], WEAPONS[e[5]], e[6]); break;
      case 'h': FX.smallHit(e[1], e[2], !!e[3]); break;
      case 'p': { const [, type, x, y, z, tx, ty, tz, spd] = e, dist = Math.hypot(tx - x, ty - y); G.proj.push({ type, x, y, z, sx: x, sy: y, sz: z, tx, ty, tz, a: Math.atan2(ty - y, tx - x), k: 0, dur: Math.max(0.05, dist / Math.max(60, spd)), arcH: type === 'arc' || type === 'arcrocket' ? dist * 0.3 : 0 }); break; }
    }
  },
  clientFrame(dt) {
    if (!this.ready || !G.running) return;
    const k = Math.min(1, dt * 10);
    for (const u of G.units) {
      if (u.nx == null) continue;
      u.x += (u.nx - u.x) * k; u.y += (u.ny - u.y) * k;
      u.a += U.angDiff(u.a, u.na) * k; u.ta += U.angDiff(u.ta, u.nta) * k;
      if (u.moving) u.anim += dt;
    }
    for (let i = G.proj.length - 1; i >= 0; i--) {
      const p = G.proj[i]; p.k += dt / p.dur;
      if (p.k >= 1) { G.proj.splice(i, 1); continue; }
      p.x = U.lerp(p.sx, p.tx, p.k); p.y = U.lerp(p.sy, p.ty, p.k); p.z = p.arcH ? 4 * p.arcH * p.k * (1 - p.k) : U.lerp(p.sz, p.tz, p.k);
    }
    if (!this.hostPaused) G.time += dt * G.speed;
    FX.update(dt);
    // spatial hash for picking and stealth checks
    const H = G.hash; H.clear(); for (const u of G.units) if (!u.inside) H.add(u); for (const b of G.blds) H.add(b); for (const c of G.civb) H.add(c);
    if ((this.visT += dt) > 0.3) { this.visT = 0; Vis.update(); Render.terrDirty = true; }
    if ((this.objT += dt) > 1) { this.objT = 0; Objectives.check(); }
  },
  frame(dt) { if (this.host) this.hostFrame(dt); else if (this.client) this.clientFrame(dt); },

  // client side: actions go to the host instead of running locally
  install() {
    const S = NET_SCOPE();
    for (const name of NET_RPC) {
      const [o, m] = name.split('.'), obj = S[o]; if (!obj || typeof obj[m] !== 'function') continue;
      const orig = obj[m]; obj['_net_' + m] = orig;
      obj[m] = function (...args) {
        if (Net.client && Net.active) { if (!Net.spectator) Net.send({ t: 'rpc', fn: name, a: Net.enc(args) }); return NET_RET[name] !== undefined ? NET_RET[name] : true; }
        return orig.apply(this, args);
      };
    }
    // host: mirror visual events to clients
    const wrapFx = (obj, m, fn) => { const orig = obj[m]; obj[m] = function (...a) { if (Net.host) fn(a); return orig.apply(this, a); }; };
    wrapFx(FX, 'explosion', (a) => Net.hostRecord(['x', Math.round(a[0]), Math.round(a[1]), +(a[2] || 1).toFixed(2), a[3] && a[3].dark ? 1 : 0]));
    wrapFx(FX, 'smallHit', (a) => { if (Math.random() < 0.5) Net.hostRecord(['h', Math.round(a[0]), Math.round(a[1]), a[2] ? 1 : 0]); });
    wrapFx(FX, 'muzzle', (a) => Net.hostRecord(['m', Math.round(a[0]), Math.round(a[1]), +a[2].toFixed(2), a[3] ? 1 : 0, a[4] ? Object.keys(WEAPONS).find((k) => WEAPONS[k] === a[4]) : null, a[5] || 0]));
    wrapFx(Decals, 'add', (a) => Net.hostRecord(['d', Math.round(a[0]), Math.round(a[1]), Math.round(a[2]), a[3] || 'crater']));
    wrapFx(Proj, 'spawn', (a) => { const o = a[0]; Net.hostRecord(['p', o.type, Math.round(o.x), Math.round(o.y), Math.round(o.z || 0), Math.round(o.tx), Math.round(o.ty), Math.round(o.tz || 0), o.spd || 600]); });
    Bus.on('sfx', (n, x, y, k) => { if (Net.host && n) Net.hostRecord(['s', n, x == null ? null : Math.round(x), y == null ? null : Math.round(y), k]); });
    const s = Store.get('mp', null); if (s) { this.name = s.name || this.name; this.transport = s.transport || 'online'; this.url = s.url || ''; }
    // invite links: ?join=CODE opens the multiplayer window ready to join
    const q = new URLSearchParams(location.search), code = (q.get('join') || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (code) window.addEventListener('load', () => setTimeout(() => { this.transport = ['local', 'ws', 'p2p'].includes(q.get('via')) ? q.get('via') : 'online'; this.room = code; UI.toggleWin('w-mp'); this.render(); }, 50));
    window.addEventListener('beforeunload', () => { if (this.active) this.leave(true); });
  },
};
Net.install();
