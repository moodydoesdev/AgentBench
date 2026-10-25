# AgentBench relay

Link benches that are on different networks, such as a laptop at home and a
PC in an office, without opening a port, running a tunnel or joining a VPN.
Both machines dial out to an AgentBench relay, and the relay pairs them up.

```
  Mac ──wss──▶ relay ◀──wss── PC
   └──── end-to-end encrypted ────┘
```

The relay only forwards ciphertext. It cannot read your code, see your
tokens, or run anything on either machine. A relayed bench works like any
linked bench, with its terminals and agents in your sidebar. It is also a
**build host** (`bench:<name>`) that agents can build on and screenshot with
`agentbench-build`, and it needs no SSH server.

## 1. Run a relay

Any server both machines can reach will do. It keeps no state.

**On Cloudflare (no server).** `packaging/relay-worker` is the same relay as
a Worker with Durable Objects. It speaks the same protocol and runs on the
free plan. To deploy it to a hostname on one of your zones:

```sh
cd packaging/relay-worker
npx wrangler@4.149.0 deploy --domain relay.example.com
```

Cloudflare issues the certificate and creates the DNS record. Check it with
`curl https://relay.example.com/healthz`. One Durable Object holds each
host's listening socket and the streams to it, and it only ever forwards
ciphertext, as the Rust relay does.

**On your own server:**

Docker:

```sh
docker build -f packaging/relay/Dockerfile -t agentbench-relay src-tauri
docker run -d --name agentbench-relay --restart unless-stopped -p 127.0.0.1:8480:8480 agentbench-relay
```

Without Docker:

```sh
cd src-tauri && cargo build --release --no-default-features --bin agentbench-relay
sudo cp target/release/agentbench-relay /usr/local/bin/
sudo cp ../packaging/relay/agentbench-relay.service /etc/systemd/system/
sudo systemctl enable --now agentbench-relay
```

Then put TLS in front of it so benches connect with `wss://`. With Caddy:

```
relay.example.com {
    reverse_proxy 127.0.0.1:8480
}
```

Traefik and nginx work too: anything that proxies WebSockets. In Dokploy,
deploy the Dockerfile as an application on port 8480 and give it a domain.
Check it with `curl https://relay.example.com/healthz`, which should print
`ok`.

## 2. Link two benches

On the machine you want to reach (the PC):

1. **Settings → Linked benches → Across networks, through a relay.**
2. Enter the relay address (`relay.example.com`) and press **Listen on
   relay**. The dot turns green when it's connected.
3. Press **Create link code** and copy the `abr1.…` code.

On the machine you're working from (the Mac):

1. **Settings → Linked benches → Link to a bench through a relay.**
2. Paste the code and press **Link**.

The PC appears in the sidebar and as the build host `bench:<pc-name>`.
Agents can also link from the CLI with `agentbench-build link abr1.…`.

Link codes work **once**, for **ten minutes**. A code grants access to the
machine that made it, so send it privately.

## Security

- **End to end.** Every connection starts with a handshake between the two
  benches, using P-256 ECDH, HKDF-SHA256 and HMAC confirmation. Each frame
  after that is AES-256-GCM with a counter nonce. The relay sees which two
  machines are talking, when, and roughly how much. It sees nothing of the
  content.
- **The relay can't impersonate the PC.** A bench's relay id is a hash of its
  public keys. The link code carries the id, so the Mac checks it reached
  exactly those keys. The PC must also sign a challenge to listen under its
  id, so no one else can claim it.
- **The relay can't impersonate the Mac.** The PC only admits keys it
  authorized when a link code was used. Each code holds a one-time 256-bit
  secret, too strong for a relay watching the handshake to guess.
- **Forward secrecy.** Every connection uses fresh ephemeral keys.
- **Two locks.** Behind the relay, the PC's gateway still checks the Mac's
  bearer token on every request, as it does for any linked bench. Running
  build commands needs a token paired as a bench, so phones and browsers
  can't.

**Revoking access:** on the PC, the relay card lists each linked bench by key
fingerprint. **Revoke** blocks it at the relay layer straight away. To revoke
its gateway token as well, use **Remote access → Paired devices**. On the Mac,
**Unlink** forgets the link.

Keys live in the AgentBench config folder:
- `relay-identity.json`: this machine's keys, owner-only.
- `relay.json`: relay settings and authorized keys.
- `relay-peers.json`: the benches you linked to, with their tokens,
  owner-only.

## Build hosts over the relay

A relayed bench is a build host with no extra setup. `agentbench-build` sends
each command over the encrypted link to the bench's gateway. The gateway runs
it the way sshd would, so sync, run, artifacts, provisioning and screenshots
all work as with an SSH host. This works for Windows benches too, with no
OpenSSH Server needed.

## Limits

- The link is one-way: the Mac reaches the PC. To reach the Mac from the PC,
  make a link code on the Mac and paste it on the PC.
- Both machines need a version of AgentBench with relay support. The relay
  protocol is versioned (`/v1/`), so updating the apps doesn't mean
  redeploying the relay.
