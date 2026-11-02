// 部屋の中身（通信そのものとは切り離した純粋なロジック）。テストしやすいように分けてある。
// ws は { send(文字列), close() } を持つ物なら何でもよい。
export const MAX_PLAYERS = 4;
const COLORS = ["#ff6b9d", "#2ec4b6", "#ffd23f", "#7fb0ff"];
const MAX_MSG = 4000;
const MAX_QUEUE = 300;
const cleanKey = (k) => (typeof k === "string" && /^[A-Za-z0-9]{8,40}$/.test(k) ? k : null);

const num = (v) => typeof v === "number" && Number.isFinite(v);
const cleanName = (n) => String(n || "").replace(/[<>&"'\u0000-\u001f]/g, "").trim().slice(0, 8) || "プレイヤー";

// 対戦設定を、知っている項目だけ・型を確かめて取り出す（クライアントの値をそのまま信用しない）
export function cleanCfg(s) {
  if (!s || typeof s !== "object") return null;
  const c = {};
  if (typeof s.num === "boolean") c.num = s.num;
  if (typeof s.warp === "boolean") c.warp = s.warp;
  if (Array.isArray(s.ch) && s.ch.length === 3) c.ch = s.ch.map(Boolean);
  if ([90, 120, 150].includes(s.map)) c.map = s.map;
  if ([1, 2, 3].includes(s.bots)) c.bots = s.bots;
  if ([0, 1, 2, 3].includes(s.obots)) c.obots = s.obots;
  if ([0, 1, 2].includes(s.diff)) c.diff = s.diff;
  if (typeof s.hb === "boolean") c.hb = s.hb;
  if (Number.isInteger(s.chests) && s.chests >= 1 && s.chests <= 10) c.chests = s.chests;
  if (s.mode === "surv" || s.mode === "pts") c.mode = s.mode;
  if ([0, 180, 300, 600].includes(s.time)) c.time = s.time;
  if ([3, 5, 10].includes(s.goal)) c.goal = s.goal;
  if ([60, 90, 120, 180, 240].includes(s.gsec)) c.gsec = s.gsec; // ゲージが1つ溜まる秒数
  if ([0.25, 0.5, 0.75, 1].includes(s.ghit)) c.ghit = s.ghit; // ヒント弾が当たったとき溜まる量
  return c;
}

export class RoomCore {
  // grace：試合中、つながりが切れた人の席を空けて待つ時間／lobbyGrace：待合室で待つ時間（タブを閉じた人が残り続けないよう短め）
  // stale：この時間なにも届かない人は、切れていると見なす（無線が黙って切れた場合の見張り）
  constructor({ now = () => Date.now(), startDelay = 3000, grace = 30000, lobbyGrace = 15000, stale = 20000 } = {}) {
    this.now = now;
    this.startDelay = startDelay;
    this.grace = grace;
    this.lobbyGrace = lobbyGrace;
    this.stale = stale;
    this.reset();
  }
  reset() {
    this.members = new Map();
    this.cfg = null;
    this.phase = "empty"; // empty → lobby → playing
    this.hostId = null;
    this.nextId = 1;
    this.votes = new Set(); // 「再戦」を押した人
  }
  list() {
    return [...this.members.values()].map((m) => ({ id: m.id, name: m.name, color: m.color, host: m.id === this.hostId, ready: !!m.num, away: !m.ws }));
  }
  send(m, obj) {
    if (!m.ws) { // つなぎ直し待ちの人：位置以外は取っておいて、戻ってきたらまとめて届ける（弾の命中・宝箱などを取りこぼさないため）
      if (obj.t !== "pos") { m.q.push(obj); if (m.q.length > MAX_QUEUE) m.q.shift(); }
      return;
    }
    try { m.ws.send(JSON.stringify(obj)); } catch (e) { /* 切れた相手には送れないだけ */ }
  }
  broadcast(obj, exceptId) {
    for (const m of this.members.values()) if (m.id !== exceptId) this.send(m, obj);
  }
  // 戻り値：{ok:true,id} または {ok:false,error}
  join(ws, { name, create, key, resume }) {
    this.sweep();
    const k = cleanKey(key);
    if (resume) return this.resumeJoin(ws, k);
    if (this.members.size === 0) {
      if (!create) return { ok: false, error: "部屋が見つかりません" };
      this.reset();
      this.phase = "lobby";
    } else if (create) {
      return { ok: false, error: "このコードは使用中です" };
    }
    if (this.phase !== "lobby") return { ok: false, error: "すでにゲームが始まっています" };
    if (this.members.size >= MAX_PLAYERS) return { ok: false, error: "部屋が満員です" };
    const used = new Set([...this.members.values()].map((m) => m.color));
    const color = COLORS.find((c) => !used.has(c)) || COLORS[0];
    const id = this.nextId++;
    const m = { id, ws, name: cleanName(name), color, last: 0, num: null, key: k, seen: this.now(), away: 0, q: [] };
    this.members.set(id, m);
    if (this.hostId === null) this.hostId = id;
    this.send(m, { t: "welcome", id, host: id === this.hostId, room: null, cfg: this.cfg, members: this.list(), now: this.now() });
    this.broadcast({ t: "members", members: this.list() }, id);
    return { ok: true, id };
  }
  // つなぎ直し：同じ key の席があれば、同じ id・同じ数字のまま新しい接続に引き継ぐ
  resumeJoin(ws, key) {
    const m = key && [...this.members.values()].find((o) => o.key === key);
    if (!m) return { ok: false, error: this.members.size === 0 ? "部屋が見つかりません" : "つなぎ直せませんでした", gone: true };
    const old = m.ws;
    m.ws = ws;
    m.away = 0;
    m.seen = this.now();
    if (old && old !== ws) { try { old.close(); } catch (e) { /* 切れた */ } }
    this.send(m, { t: "resumed", id: m.id, host: m.id === this.hostId, cfg: this.cfg, phase: this.phase, members: this.list(), now: this.now() });
    const q = m.q;
    m.q = [];
    for (const o of q) this.send(m, o);
    this.broadcast({ t: "back", id: m.id }, m.id);
    this.broadcast({ t: "members", members: this.list() }, m.id);
    return { ok: true, id: m.id, resumed: true };
  }
  // 接続が切れた：すぐには席を消さず、つなぎ直しを待つ。切れたのが古い接続なら（すでに新しい接続に替わっていれば）何もしない
  detach(id, ws) {
    const m = this.members.get(id);
    if (!m || m.ws !== ws) return false;
    m.ws = null;
    m.away = this.now();
    this.broadcast({ t: "away", id }, id);
    this.broadcast({ t: "members", members: this.list() }, id);
    return true;
  }
  isCurrent(id, ws) {
    const m = this.members.get(id);
    return !!m && m.ws === ws;
  }
  // 定期的に呼ぶ：黙り込んだ接続を「切れた」扱いにし、待ちきれなかった席を片づける
  sweep() {
    const t = this.now();
    const grace = this.phase === "playing" ? this.grace : this.lobbyGrace;
    for (const m of [...this.members.values()]) {
      if (m.ws && t - m.seen > this.stale) {
        const w = m.ws;
        this.detach(m.id, w);
        try { w.close(); } catch (e) { /* 切れた */ }
      } else if (!m.ws && t - m.away > grace) {
        this.leave(m.id);
      }
    }
  }
  message(id, raw, from) {
    const m = this.members.get(id);
    if (!m || (from !== undefined && m.ws !== from)) return; // 入れ替わった古い接続からの声は聞かない
    m.seen = this.now();
    if (typeof raw !== "string" || raw.length > MAX_MSG) return;
    let d;
    try { d = JSON.parse(raw); } catch (e) { return; }
    if (!d || typeof d !== "object") return;
    switch (d.t) {
      case "ping":
        this.send(m, { t: "pong", c: num(d.c) ? d.c : 0, s: this.now() });
        break;
      case "cfg": // 設定を決められるのは部屋を作った人（ホスト）だけ。始まる前だけ
        if (id !== this.hostId || this.phase !== "lobby") break;
        this.cfg = cleanCfg(d.cfg);
        this.broadcast({ t: "cfg", cfg: this.cfg }, id);
        break;
      case "num": { // 自分の数字（3桁）を決める。同じ数字の人がいてもよい
        if (this.phase !== "lobby") break;
        if (d.n === null) { m.num = null; this.send(m, { t: "numres", ok: true, n: null }); this.broadcast({ t: "members", members: this.list() }); break; }
        if (typeof d.n !== "string" || !/^\d{3}$/.test(d.n)) break;
        m.num = d.n;
        this.send(m, { t: "numres", ok: true, n: d.n });
        this.broadcast({ t: "members", members: this.list() });
        break;
      }
      case "start": {
        if (id !== this.hostId || this.phase !== "lobby" || this.members.size < 2 || !this.cfg) break;
        if ([...this.members.values()].some((o) => !o.ws)) { this.send(m, { t: "notice", m: "つながりが切れている人がいます。少し待ってください" }); break; }
        if ([...this.members.values()].some((o) => !o.num)) { this.send(m, { t: "notice", m: "全員が数字を決めるとスタートできます" }); break; }
        this.phase = "playing";
        this.votes.clear();
        const nums = {};
        for (const o of this.members.values()) nums[o.id] = o.num;
        this.broadcast({ t: "start", cfg: this.cfg, t0: this.now() + this.startDelay, members: this.list(), nums });
        break;
      }
      case "rematch": // 全員が押したら、同じ設定で待合室（数字の決め直し）へ戻る
        if (this.phase !== "playing") break;
        this.votes.add(id);
        this.broadcast({ t: "rematch", votes: this.votes.size, total: this.members.size });
        this.checkRematch();
        break;
      case "bye": { // 自分から抜ける（待たずに、すぐ席を空ける）
        const w = m.ws;
        this.leave(id);
        try { w.close(); } catch (e) { /* 切れた */ }
        break;
      }
      case "close": { // 部屋を解散して、全員を終わらせる
        this.broadcast({ t: "closed" });
        const all = [...this.members.values()];
        this.reset();
        for (const o of all) { try { o.ws.close(); } catch (e) { /* 切れた */ } }
        break;
      }
      case "pos": { // 位置は、そのまま他の人へ中継するだけ（1秒に50回まで）
        if (this.phase !== "playing" || !num(d.x) || !num(d.z) || !num(d.y) || !num(d.yaw)) break;
        const t = this.now();
        if (t - m.last < 20) break;
        m.last = t;
        this.broadcast({ t: "pos", id, x: d.x, z: d.z, y: d.y, yaw: d.yaw, f: num(d.f) ? d.f | 0 : 0, ts: t }, id);
        break;
      }
      case "to": // 特定の相手へ、ゲーム中のやりとり（弾の命中・判定・宝箱など）をそのまま届ける
      case "all": { // 全員へ
        if (this.phase !== "playing" || !d.m || typeof d.m !== "object" || typeof d.m.k !== "string") break;
        const out = { t: "m", from: id, m: d.m };
        if (d.t === "all") { this.broadcast(out, id); break; }
        const target = this.members.get(d.to);
        if (target && target.id !== id) this.send(target, out);
        break;
      }
      default:
        break;
    }
  }
  checkRematch() {
    if (this.phase !== "playing" || this.members.size === 0 || this.votes.size < this.members.size) return;
    this.phase = "lobby";
    this.votes.clear();
    for (const o of this.members.values()) o.num = null;
    this.broadcast({ t: "lobby", members: this.list() });
  }
  leave(id) {
    this.votes.delete(id);
    if (!this.members.delete(id)) return;
    if (this.members.size === 0) { this.reset(); return; }
    if (id === this.hostId) this.hostId = Math.min(...this.members.keys()); // 次に入った人がホストを引き継ぐ
    this.broadcast({ t: "left", id });
    this.broadcast({ t: "members", members: this.list() });
    this.checkRematch();
  }
}
