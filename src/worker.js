// ABaCu! の Worker：静的ファイル（index.html, se/）の配信と、オンライン対戦の「部屋」
import { DurableObject } from "cloudflare:workers";
import { RoomCore } from "./room-core.js";

// 部屋＝Durable Object。同じコードの部屋には、いつも同じ Room がつながる
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new RoomCore();
  }
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocketで接続してください", { status: 426 });
    }
    const url = new URL(request.url);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const sock = {
      send: (s) => { try { server.send(s); } catch (e) { /* 切れた */ } },
      close: () => { try { server.close(); } catch (e) { /* 切れた */ } },
    };
    const r = this.core.join(sock, {
      name: url.searchParams.get("name"),
      create: url.searchParams.get("create") === "1",
    });
    if (!r.ok) {
      sock.send(JSON.stringify({ t: "err", m: r.error }));
      sock.close();
    } else {
      const id = r.id;
      server.addEventListener("message", (e) => this.core.message(id, typeof e.data === "string" ? e.data : ""));
      const bye = () => this.core.leave(id);
      server.addEventListener("close", bye);
      server.addEventListener("error", bye);
    }
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 動作確認用：/ping
    if (url.pathname === "/ping") {
      return new Response("pong（Worker OK）");
    }

    // オンライン対戦：/ws/ABCD （4文字の部屋コード）
    const m = url.pathname.match(/^\/ws\/([A-Za-z0-9]{4})$/);
    if (m) {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("WebSocketで接続してください", { status: 426 });
      const origin = request.headers.get("Origin"); // 他のサイトのページからの接続は断る
      if (origin) {
        let host = "";
        try { host = new URL(origin).host; } catch (e) { /* 不正なOrigin */ }
        if (host !== url.host) return new Response("forbidden", { status: 403 });
      }
      const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1].toUpperCase()));
      return stub.fetch(request);
    }

    // それ以外は、今までどおり index.html や se/ を返す
    return env.ASSETS.fetch(request);
  },
};
