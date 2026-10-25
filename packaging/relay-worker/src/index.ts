// The AgentBench relay on Cloudflare: Workers + Durable Objects.
//
// Speaks exactly the protocol of agentbench-relay
// (src-tauri/src/relay/server.rs), so benches cannot tell them apart:
//
//   GET /v1/listen?id=<id>   host: challenge → signed hello → {"open": sid}…
//   GET /v1/connect/<id>     client: spliced to the host's /v1/accept/<sid>
//   GET /v1/accept/<sid>     host: the other half of one client connection
//   GET /healthz             "ok"
//
// One Durable Object per host id holds that host's listening socket and every
// stream to it, so pairing a client with the host's matching socket is a
// lookup inside one object. A stream id starts with the host id, which is how
// /v1/accept finds the right object. The relay never sees plaintext: benches
// encrypt end to end (relay/crypto.rs) and only ciphertext passes through.

export interface Env {
  HOSTS: DurableObjectNamespace;
}

const ID_RE = /^[a-z2-7]{26}$/;
const SID_RE = /^[a-z2-7]{26}[0-9a-f]{32}$/;
const MAX_STREAMS_PER_HOST = 128;
const ACCEPT_TIMEOUT_MS = 20_000;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/") return new Response("AgentBench relay\n");
    if (path === "/healthz") return new Response("ok");

    let id: string | null = null;
    if (path === "/v1/listen") {
      id = url.searchParams.get("id");
    } else if (path.startsWith("/v1/connect/")) {
      id = path.slice("/v1/connect/".length);
    } else if (path.startsWith("/v1/accept/")) {
      const sid = path.slice("/v1/accept/".length);
      id = SID_RE.test(sid) ? sid.slice(0, 26) : null;
    } else {
      return new Response("not found", { status: 404 });
    }
    if (!id || !ID_RE.test(id)) return new Response("bad id", { status: 400 });
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket", { status: 426 });
    }
    return env.HOSTS.get(env.HOSTS.idFromName(id)).fetch(req);
  },
};

type Attachment =
  | { role: "listen"; id: string; challenge: string; verified: boolean }
  | { role: "client"; sid: string; opened: number }
  | { role: "host"; sid: string };

export class HostRoom {
  constructor(private ctx: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/v1/listen") return this.listen(url.searchParams.get("id")!);
    if (path.startsWith("/v1/connect/")) return this.connect(path.slice("/v1/connect/".length));
    if (path.startsWith("/v1/accept/")) return this.accept(path.slice("/v1/accept/".length));
    return new Response("not found", { status: 404 });
  }

  private socketPair(attachment: Attachment, tag: string): Response & { server?: WebSocket } {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [tag]);
    server.serializeAttachment(attachment);
    const res = new Response(null, { status: 101, webSocket: client }) as Response & { server?: WebSocket };
    res.server = server;
    return res;
  }

  private listener(): WebSocket | undefined {
    return this.ctx
      .getWebSockets("listen")
      .find((ws) => (ws.deserializeAttachment() as Attachment & { verified?: boolean }).verified);
  }

  // A host proves it owns `id` by signing a challenge with the key the id is
  // a hash of; until then it is not reachable.
  private listen(id: string): Response {
    const challenge = hex(crypto.getRandomValues(new Uint8Array(32)));
    const res = this.socketPair({ role: "listen", id, challenge, verified: false }, "listen");
    res.server!.send(JSON.stringify({ challenge }));
    return res;
  }

  private connect(id: string): Response {
    const host = this.listener();
    // Refusals are plain HTTP errors before any upgrade; benches show the
    // body as the reason.
    if (!host) return new Response("that bench is not connected to this relay", { status: 404 });
    const streams = this.ctx.getWebSockets().filter((ws) => (ws.deserializeAttachment() as Attachment).role === "client");
    if (streams.length >= MAX_STREAMS_PER_HOST) {
      return new Response("too many connections to that bench", { status: 429 });
    }
    const sid = id + hex(crypto.getRandomValues(new Uint8Array(16)));
    const res = this.socketPair({ role: "client", sid, opened: Date.now() }, `c:${sid}`);
    host.send(JSON.stringify({ open: sid }));
    this.ctx.storage.setAlarm(Date.now() + ACCEPT_TIMEOUT_MS);
    return res;
  }

  // The stream id was only ever sent down the host's authenticated listening
  // socket, so holding it is the host's credential for this half.
  private accept(sid: string): Response {
    const [client] = this.ctx.getWebSockets(`c:${sid}`);
    if (!client || this.ctx.getWebSockets(`h:${sid}`).length) {
      return new Response("no such stream", { status: 404 });
    }
    const res = this.socketPair({ role: "host", sid }, `h:${sid}`);
    // whatever the client sent before the host arrived (its first handshake
    // message) goes over now, in order
    this.ctx.blockConcurrencyWhile(async () => {
      const queued = (await this.ctx.storage.get<ArrayBuffer[]>(`q:${sid}`)) ?? [];
      for (const m of queued) res.server!.send(m);
      await this.ctx.storage.delete(`q:${sid}`);
    });
    return res;
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment;
    if (a.role === "listen") {
      if (!a.verified && typeof msg === "string") await this.hello(ws, a, msg);
      return;
    }
    if (a.role === "client") {
      const [host] = this.ctx.getWebSockets(`h:${a.sid}`);
      if (host) {
        host.send(msg);
      } else {
        const key = `q:${a.sid}`;
        const queued = (await this.ctx.storage.get<(string | ArrayBuffer)[]>(key)) ?? [];
        if (queued.length < 16) {
          queued.push(msg);
          await this.ctx.storage.put(key, queued);
        }
      }
      return;
    }
    const [client] = this.ctx.getWebSockets(`c:${a.sid}`);
    client?.send(msg);
  }

  private async hello(ws: WebSocket, a: Extract<Attachment, { role: "listen" }>, text: string) {
    let hello: { dh?: string; sigPub?: string; sig?: string };
    try {
      hello = JSON.parse(text);
    } catch {
      hello = {};
    }
    const ok = await verifyListener(a.id, hello.dh, hello.sigPub, hello.sig, a.challenge);
    if (!ok) {
      ws.send(JSON.stringify({ ok: false, error: "bad signature" }));
      ws.close(4001, "bad signature");
      return;
    }
    // The newest listener wins: a host reconnecting after a network blip
    // replaces its stale half-open socket.
    for (const old of this.ctx.getWebSockets("listen")) {
      if (old !== ws && (old.deserializeAttachment() as { verified?: boolean }).verified) {
        old.close(4000, "replaced by a newer connection");
      }
    }
    ws.serializeAttachment({ ...a, verified: true });
    ws.send(JSON.stringify({ ok: true, id: a.id }));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment;
    if (a.role === "listen") return;
    const other = this.ctx.getWebSockets(a.role === "client" ? `h:${a.sid}` : `c:${a.sid}`)[0];
    // pass the reason on, so a refusal reaches the other bench intact
    const forwardable = code === 1000 || (code >= 3000 && code <= 4999);
    try {
      other?.close(forwardable ? code : 1000, reason.slice(0, 120));
    } catch {
      // already closing
    }
    if (a.role === "client") await this.ctx.storage.delete(`q:${a.sid}`);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, "");
  }

  // Clients whose host never answered within the timeout are told so.
  async alarm(): Promise<void> {
    const now = Date.now();
    let next = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment;
      if (a.role !== "client" || this.ctx.getWebSockets(`h:${a.sid}`).length) continue;
      if (now - a.opened >= ACCEPT_TIMEOUT_MS) {
        ws.close(4008, "that bench did not answer");
        await this.ctx.storage.delete(`q:${a.sid}`);
      } else {
        next = Math.max(next, a.opened + ACCEPT_TIMEOUT_MS);
      }
    }
    if (next) await this.ctx.storage.setAlarm(next);
  }
}

// ---------------------------------------------------------------- crypto
// Mirrors relay/crypto.rs: id = base32(sha256("agentbench-relay-id" | dh |
// sigPub))[..16 bytes], lowercase, no padding; the hello signature is
// ECDSA P-256 / SHA-256 over "agentbench-relay-listen-v1" | challenge, as
// raw r||s.

const enc = new TextEncoder();

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function unhex(s: string | undefined): Uint8Array | null {
  if (!s || s.length % 2 || /[^0-9a-f]/.test(s)) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function base32(b: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of b) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

async function idOf(dh: Uint8Array, sigPub: Uint8Array): Promise<string> {
  const data = new Uint8Array([...enc.encode("agentbench-relay-id"), ...dh, ...sigPub]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return base32(digest.slice(0, 16));
}

// P-256 field prime and curve constant b; a = -3.
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

function modpow(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  base %= m;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % m;
    base = (base * base) % m;
    exp >>= 1n;
  }
  return result;
}

function toBig(b: Uint8Array): bigint {
  return BigInt("0x" + (hex(b) || "0"));
}

function toBytes32(n: bigint): Uint8Array {
  return unhex(n.toString(16).padStart(64, "0"))!;
}

// WebCrypto imports only uncompressed points; benches send compressed ones.
// Recover y from x (p ≡ 3 mod 4, so the square root is a power), checking the
// point is on the curve.
function decompress(c: Uint8Array): Uint8Array | null {
  if (c.length !== 33 || (c[0] !== 2 && c[0] !== 3)) return null;
  const x = toBig(c.slice(1));
  if (x >= P) return null;
  const y2 = (((x * x) % P) * x - 3n * x + B) % P;
  const rhs = (y2 + P) % P;
  let y = modpow(rhs, (P + 1n) / 4n, P);
  if ((y * y) % P !== rhs) return null;
  if ((y & 1n) !== BigInt(c[0] & 1)) y = P - y;
  return new Uint8Array([4, ...toBytes32(x), ...toBytes32(y)]);
}

async function verifyListener(
  id: string,
  dhHex: string | undefined,
  sigPubHex: string | undefined,
  sigHex: string | undefined,
  challengeHex: string,
): Promise<boolean> {
  const dh = unhex(dhHex);
  const sigPub = unhex(sigPubHex);
  const sig = unhex(sigHex);
  const challenge = unhex(challengeHex)!;
  if (!dh || !sigPub || !sig || dh.length !== 33 || sigPub.length !== 33 || sig.length !== 64) return false;
  if (!decompress(dh)) return false;
  if ((await idOf(dh, sigPub)) !== id) return false;
  const point = decompress(sigPub);
  if (!point) return false;
  try {
    const key = await crypto.subtle.importKey("raw", point, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const msg = new Uint8Array([...enc.encode("agentbench-relay-listen-v1"), ...challenge]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, msg);
  } catch {
    return false;
  }
}
