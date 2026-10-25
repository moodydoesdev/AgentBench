/**
 * Passkey (WebAuthn) ceremonies against a gateway.
 *
 * The gateway speaks base64url for every binary field; this module converts
 * at the edge so callers deal in plain JSON. A passkey is bound to the host
 * the page is served from, so these only make sense for the gateway at this
 * page's own origin (bench.example.com behind the tunnel, not a tailnet IP).
 */

const b64urlToBytes = (s) => {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const bytesToB64url = (buf) => {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** WebAuthn runs only in a secure context on a real host name. */
export function passkeySupported() {
  if (typeof window === "undefined" || !window.PublicKeyCredential) return false;
  if (!window.isSecureContext) return false;
  const host = window.location.hostname;
  // IP literals can never be a relying party
  return !/^[\d.]+$/.test(host) && !host.includes(":");
}

async function post(path, body, token) {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `request failed (${res.status})`);
  return json;
}

/** The user dismissing the system sheet is not an error worth showing. */
export function passkeyCancelled(err) {
  return err?.name === "NotAllowedError" || err?.name === "AbortError";
}

/** Sign in with a passkey held for this site. Resolves to { token, machine }. */
export async function signInWithPasskey(deviceName) {
  const opts = await post("/api/passkey/login/start");
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBytes(opts.challenge),
      rpId: opts.rpId,
      timeout: opts.timeout,
      userVerification: opts.userVerification,
      allowCredentials: [],
    },
  });
  const r = cred.response;
  return post("/api/passkey/login/finish", {
    id: bytesToB64url(cred.rawId),
    clientDataJSON: bytesToB64url(r.clientDataJSON),
    authenticatorData: bytesToB64url(r.authenticatorData),
    signature: bytesToB64url(r.signature),
    deviceName,
  });
}

/** Create a passkey for this site. Needs a signed-in device token. */
export async function createPasskey(token, name) {
  const opts = await post("/api/passkey/register/start", {}, token);
  const cred = await navigator.credentials.create({
    publicKey: {
      ...opts,
      challenge: b64urlToBytes(opts.challenge),
      user: { ...opts.user, id: b64urlToBytes(opts.user.id) },
      excludeCredentials: opts.excludeCredentials.map((c) => ({
        ...c,
        id: b64urlToBytes(c.id),
      })),
    },
  });
  const r = cred.response;
  const spki = r.getPublicKey?.();
  if (!spki) throw new Error("this browser is too old to create passkeys here");
  return post(
    "/api/passkey/register/finish",
    {
      id: bytesToB64url(cred.rawId),
      clientDataJSON: bytesToB64url(r.clientDataJSON),
      authenticatorData: bytesToB64url(r.getAuthenticatorData()),
      publicKey: bytesToB64url(spki),
      alg: r.getPublicKeyAlgorithm(),
      name,
    },
    token,
  );
}

export async function listPasskeys(token) {
  const res = await fetch("/api/passkeys", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`could not load passkeys (${res.status})`);
  return res.json();
}

export function removePasskey(token, id) {
  return post("/api/passkeys/remove", { id }, token);
}

/** A name for the passkey list: which device made it. */
export function passkeyDeviceName() {
  const ua = navigator.userAgent;
  const m = /(iPhone|iPad|Android|Macintosh|Windows|Linux)/.exec(ua);
  const os = m ? (m[1] === "Macintosh" ? "Mac" : m[1]) : "Device";
  const browser = ua.includes("Edg/")
    ? "Edge"
    : ua.includes("Firefox/")
      ? "Firefox"
      : ua.includes("Chrome/") || ua.includes("CriOS/")
        ? "Chrome"
        : "Safari";
  return `${os} · ${browser}`;
}
