// ABaCu! の Worker：静的ファイル（index.html, se/）の配信と、オンライン対戦の「部屋」
import { DurableObject } from "cloudflare:workers";
import { RoomCore } from "./room-core.js";

// 部屋＝Durable Object。同じコードの部屋には、いつも同じ Room がつながる
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new RoomCore();
    this.timer = null;
  }
  // 見張り番：5秒ごとに、黙り込んだ接続を「切れた」と見なし、待ちきれなかった席を片づける。部屋が空になったら止める
  watch() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try { this.core.sweep(); } catch (e) { /* 見張りが止まらないように */ }
      if (this.core.members.size === 0) { clearInterval(this.timer); this.timer = null; }
    }, 5000);
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
      key: url.searchParams.get("key"),
      resume: url.searchParams.get("resume") === "1",
    });
    if (!r.ok) {
      sock.send(JSON.stringify({ t: "err", m: r.error, gone: !!r.gone }));
      sock.close();
    } else {
      const id = r.id;
      server.addEventListener("message", (e) => {
        try { this.core.message(id, typeof e.data === "string" ? e.data : "", sock); } catch (err) { /* 1通の不具合で接続を巻き込まない */ }
      });
      // 切れても、すぐには席を消さない（つなぎ直しを待つ）。待ちきれなかった席は watch() が片づける
      const bye = () => { try { this.core.detach(id, sock); } catch (err) { /* 無視 */ } };
      server.addEventListener("close", bye);
      server.addEventListener("error", bye);
      this.watch();
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
