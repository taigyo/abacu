// 部屋の中身（通信そのものとは切り離した純粋なロジック）。テストしやすいように分けてある。
// ws は { send(文字列), close() } を持つ物なら何でもよい。
export const MAX_PLAYERS = 4;
const COLORS = ["#ff6b9d", "#2ec4b6", "#ffd23f", "#7fb0ff"];
const MAX_MSG = 2000;

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
  if (s.mode === "surv" || s.mode === "pts") c.mode = s.mode;
  if ([0, 180, 300, 600].includes(s.time)) c.time = s.time;
  if ([3, 5, 10].includes(s.goal)) c.goal = s.goal;
  return c;
}

export class RoomCore {
  constructor({ now = () => Date.now(), startDelay = 3000 } = {}) {
    this.now = now;
    this.startDelay = startDelay;
    this.reset();
  }
  reset() {
    this.members = new Map();
    this.cfg = null;
    this.phase = "empty"; // empty → lobby → playing
    this.hostId = null;
    this.nextId = 1;
  }
  list() {
    return [...this.members.values()].map((m) => ({ id: m.id, name: m.name, color: m.color, host: m.id === this.hostId }));
  }
  send(m, obj) {
    try { m.ws.send(JSON.stringify(obj)); } catch (e) { /* 切れた相手には送れないだけ */ }
  }
  broadcast(obj, exceptId) {
    for (const m of this.members.values()) if (m.id !== exceptId) this.send(m, obj);
  }
  // 戻り値：{ok:true,id} または {ok:false,error}
  join(ws, { name, create }) {
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
    const m = { id, ws, name: cleanName(name), color, last: 0 };
    this.members.set(id, m);
    if (this.hostId === null) this.hostId = id;
    this.send(m, { t: "welcome", id, host: id === this.hostId, room: null, cfg: this.cfg, members: this.list(), now: this.now() });
    this.broadcast({ t: "members", members: this.list() }, id);
    return { ok: true, id };
  }
  message(id, raw) {
    const m = this.members.get(id);
    if (!m || typeof raw !== "string" || raw.length > MAX_MSG) return;
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
      case "start":
        if (id !== this.hostId || this.phase !== "lobby" || this.members.size < 2 || !this.cfg) break;
        this.phase = "playing";
        this.broadcast({ t: "start", cfg: this.cfg, t0: this.now() + this.startDelay, members: this.list() });
        break;
      case "pos": { // 位置は、そのまま他の人へ中継するだけ（1秒に40回まで）
        if (this.phase !== "playing" || !num(d.x) || !num(d.z) || !num(d.y) || !num(d.yaw)) break;
        const t = this.now();
        if (t - m.last < 25) break;
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
  leave(id) {
    if (!this.members.delete(id)) return;
    if (this.members.size === 0) { this.reset(); return; }
    if (id === this.hostId) this.hostId = Math.min(...this.members.keys()); // 次に入った人がホストを引き継ぐ
    this.broadcast({ t: "left", id });
    this.broadcast({ t: "members", members: this.list() });
  }
}
