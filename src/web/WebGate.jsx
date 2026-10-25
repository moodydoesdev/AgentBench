import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { loginToGateway, wsTransport } from "../lib/transport";
import { TransportProvider } from "../lib/TransportContext";
import { setWebTransport } from "../lib/ipc";
import Logo from "../components/Logo";
import {
  createPasskey,
  passkeyCancelled,
  passkeyDeviceName,
  passkeySupported,
  signInWithPasskey,
} from "../lib/passkey";

// Web mode: the desktop bundle served by the gateway to a plain browser.
// This gate owns the token for this origin, shows the login screen until one
// exists, then installs the gateway socket as the app-wide transport and
// mounts the real App. The token lands in localStorage exactly like the phone
// PWA's (per-origin, revocable from Settings → devices).
const App = lazy(() => import("../App"));
const UsagePage = lazy(() => import("./UsagePage.jsx"));

// /usage is a standalone page: Claude plan usage, no bench, no socket.
const ON_USAGE = window.location.pathname.replace(/\/+$/, "") === "/usage";

const TOKEN_KEY = "agentbench.web.token";
const GATEWAYS_KEY = "agentbench.gateways"; // the mobile shell's pairing list
const UI_KEY = "agentbench.web.ui"; // "desktop" pins a phone to the full UI

/**
 * A phone that logs in here gets the mobile shell, not the desktop grid —
 * the full UI is unusable at phone width. ?desktop pins the full UI for this
 * browser (some tablets want it); ?mobile clears the pin.
 */
function mobilePreferred() {
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.has("desktop")) {
      localStorage.setItem(UI_KEY, "desktop");
      return false;
    }
    if (q.has("mobile")) localStorage.removeItem(UI_KEY);
    else if (localStorage.getItem(UI_KEY) === "desktop") return false;
  } catch {
    /* storage blocked — fall through to the UA */
  }
  return /Mobi|iPhone/i.test(navigator.userAgent);
}

/**
 * Hand this origin's token to the mobile shell (it reads the same pairing
 * list the PWA uses, keyed by origin) and hop to it. The entry survives, so
 * next visit /m works directly and the shell can be installed as a PWA.
 */
function hopToMobile(token) {
  try {
    const raw = JSON.parse(localStorage.getItem(GATEWAYS_KEY) ?? "[]");
    const list = Array.isArray(raw) ? raw : [];
    const url = window.location.origin;
    const prev = list.find((g) => g?.url === url);
    localStorage.setItem(
      GATEWAYS_KEY,
      JSON.stringify([
        ...list.filter((g) => g?.url !== url),
        { url, token, name: prev?.name ?? null },
      ]),
    );
  } catch {
    /* the shell will show its pairing screen instead */
  }
  window.location.replace("/m");
}

// One socket per token, module-level: a re-render, remount or double-invoked
// useMemo must never open a second WebSocket — every broker event fans out to
// every socket, so a duplicate silently doubles the tunnel's bandwidth.
let liveTransport = null; // { token, t }
function transportFor(token) {
  if (liveTransport?.token === token) return liveTransport.t;
  liveTransport?.t.close();
  const t = wsTransport({
    url: window.location.origin,
    token,
    // keeps the token out of Cloudflare's request logs
    tokenInProtocol: true,
  });
  liveTransport = { token, t };
  setWebTransport(t);
  return t;
}

function browserName() {
  const ua = navigator.userAgent;
  if (ua.includes("Edg/")) return "Edge";
  if (ua.includes("Firefox/")) return "Firefox";
  if (ua.includes("Chrome/")) return "Chrome";
  if (ua.includes("Safari/")) return "Safari";
  return "Browser";
}

function loadToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

function saveToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private windows still work for this tab's lifetime */
  }
}

/** Is this stored token still honored? 401 means revoked or stale. */
async function tokenValid(token) {
  try {
    const res = await fetch("/api/push/key", {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.status !== 401;
  } catch {
    // network trouble is not a verdict on the token; let the socket retry
    return true;
  }
}

const PASSKEY_OFFER_KEY = "agentbench.web.passkeyOffer"; // "no" = stop asking

function offerDeclined() {
  try {
    return localStorage.getItem(PASSKEY_OFFER_KEY) === "no";
  } catch {
    return false;
  }
}

/**
 * Shown once after a password login on a passkey-capable address: one tap
 * to make the next sign-in Face ID instead of typing.
 */
function PasskeyOffer({ token, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await createPasskey(token, passkeyDeviceName());
      onDone();
    } catch (err) {
      if (!passkeyCancelled(err)) setError(String(err.message || err));
      setBusy(false);
    }
  };
  return (
    <div className="web-login">
      <div className="web-login-card">
        <Logo className="logo" width={200} />
        <p className="web-login-warning">
          Sign in with Face ID, Touch ID or your device PIN next time instead of
          the password?
        </p>
        {error && <div className="web-login-error">{error}</div>}
        <button className="btn-primary" disabled={busy} onClick={create}>
          {busy ? "Creating…" : "Create a passkey"}
        </button>
        <button
          type="button"
          className="web-login-alt"
          disabled={busy}
          onClick={() => {
            try {
              localStorage.setItem(PASSKEY_OFFER_KEY, "no");
            } catch {
              /* asked again next time — harmless */
            }
            onDone();
          }}
        >
          Not now
        </button>
      </div>
    </div>
  );
}

function LoginScreen({ onToken }) {
  const [mode, setMode] = useState("password"); // "password" | "code"
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [offer, setOffer] = useState(null); // token awaiting the passkey offer
  const inputRef = useRef(null);
  const canPasskey = passkeySupported();

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode]);

  const passkey = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { token } = await signInWithPasskey(`Web · ${browserName()} (passkey)`);
      onToken(token);
    } catch (err) {
      if (!passkeyCancelled(err)) setError(String(err.message || err));
      setBusy(false);
    }
  };

  if (offer) return <PasskeyOffer token={offer} onDone={() => onToken(offer)} />;

  const submit = async (e) => {
    e.preventDefault();
    if (!secret.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body =
        mode === "password" ? { password: secret } : { code: secret.trim() };
      const { token } = await loginToGateway(window.location.origin, {
        ...body,
        deviceName: `Web · ${browserName()}`,
      });
      if (mode === "password" && canPasskey && !offerDeclined()) setOffer(token);
      else onToken(token);
    } catch (err) {
      setError(String(err.message || err));
      setBusy(false);
    }
  };

  return (
    <div className="web-login">
      <form className="web-login-card" onSubmit={submit}>
        <Logo className="logo" width={200} />
        <p className="web-login-warning">
          This machine runs agents with full permissions. Sign in.
        </p>
        {canPasskey && (
          <>
            <button type="button" className="btn-primary" disabled={busy} onClick={passkey}>
              Sign in with a passkey
            </button>
            <div className="web-login-or">or</div>
          </>
        )}
        <input
          ref={inputRef}
          type={mode === "password" ? "password" : "text"}
          autoComplete={mode === "password" ? "current-password" : "one-time-code"}
          placeholder={mode === "password" ? "Password" : "Pairing code (0000-0000)"}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          disabled={busy}
        />
        {error && <div className="web-login-error">{error}</div>}
        <button type="submit" className="btn-primary" disabled={busy || !secret.trim()}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <button
          type="button"
          className="web-login-alt"
          onClick={() => {
            setMode((m) => (m === "password" ? "code" : "password"));
            setSecret("");
            setError(null);
          }}
        >
          {mode === "password"
            ? "Use a one-time pairing code instead"
            : "Use the password instead"}
        </button>
      </form>
    </div>
  );
}

export default function WebGate() {
  const [token, setToken] = useState(loadToken);
  const [checked, setChecked] = useState(false);

  // A stored token may have been revoked from Settings since last visit;
  // find out before mounting the whole app against a dead credential.
  useEffect(() => {
    let alive = true;
    if (!token) {
      setChecked(true);
      return;
    }
    tokenValid(token).then((ok) => {
      if (!alive) return;
      if (!ok) {
        saveToken(null);
        setToken(null);
      }
      setChecked(true);
    });
    return () => {
      alive = false;
    };
  }, []); // once, for the stored token

  // Phones get the mobile shell. Decided before the socket opens so the
  // desktop bundle's heavy chunks are never fetched over a phone connection.
  const goMobile = token && checked && !ON_USAGE && mobilePreferred();
  useEffect(() => {
    if (goMobile) hopToMobile(token);
  }, [goMobile, token]);

  const transport = useMemo(
    () => (token && !goMobile && !ON_USAGE ? transportFor(token) : null),
    [token, goMobile],
  );

  if (!checked || goMobile) return null;
  if (ON_USAGE && token) {
    return (
      <Suspense fallback={null}>
        <UsagePage
          token={token}
          onSignOut={() => {
            saveToken(null);
            setToken(null);
          }}
        />
      </Suspense>
    );
  }
  if (!transport) {
    return (
      <LoginScreen
        onToken={(t) => {
          saveToken(t);
          setToken(t);
        }}
      />
    );
  }
  return (
    <TransportProvider transport={transport}>
      <Suspense fallback={null}>
        <App />
      </Suspense>
    </TransportProvider>
  );
}
