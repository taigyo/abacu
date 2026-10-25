// ABaCu! の Worker。いまは動作確認用の骨組みだけ（Stage 19 でオンライン対戦の中身を作ります）
import { DurableObject } from "cloudflare:workers";

// 部屋。Stage 19 で、WebSocketで参加者をつなぎ、ゲームの状態をやりとりする処理を入れる
export class Room extends DurableObject {
  async fetch(request) {
    return new Response("pong（Durable Object OK）");
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // 動作確認用：/ping を開くと、Durable Object まで通っていれば「pong」と表示される
    if (url.pathname === "/ping") {
      const stub = env.ROOMS.get(env.ROOMS.idFromName("test"));
      return stub.fetch(request);
    }
    // それ以外は、今までどおり index.html や se/ を返す
    return env.ASSETS.fetch(request);
  },
};
