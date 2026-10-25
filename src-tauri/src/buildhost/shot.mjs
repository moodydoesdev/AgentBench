// Headless page capture for AgentBench build hosts. abkit.sh runs this with
// the kit's Node and Playwright (~/.agentbench/builds/kit). The browser is
// headless, so nothing ever appears on the host's screen.
//
// stdout is a short report for the agent — HTTP status, console errors,
// uncaught exceptions — because a screenshot of a blank page says less than
// the TypeError that caused it.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const kit = join(homedir(), ".agentbench", "builds", "kit", "package.json");
const { chromium, webkit, firefox, devices } = createRequire(kit)("playwright");

const opts = { width: 1440, height: 900, browser: "chromium", steps: [] };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === "--url") opts.url = next();
  else if (a === "--out") opts.out = next();
  else if (a === "--width") opts.width = Number(next());
  else if (a === "--height") opts.height = Number(next());
  else if (a === "--browser") opts.browser = next();
  else if (a === "--full") opts.full = true;
  else if (a === "--wait") opts.wait = next();
  else if (a === "--delay") opts.delay = Number(next());
  else if (a === "--appearance") opts.appearance = next();
  else if (a === "--device") opts.device = next();
  else if (a === "--do") opts.steps.push(next());
  else if (a === "--selftest") opts.selftest = true;
  else throw new Error(`unknown option ${a}`);
}

const engines = { chromium, webkit, firefox };

if (opts.selftest) {
  const b = await chromium.launch();
  await b.close();
  console.log("ok");
  process.exit(0);
}

const engine = engines[opts.browser];
if (!engine) throw new Error(`unknown browser ${opts.browser} (chromium, webkit, firefox)`);

const notes = [];
let failed = false;
const browser = await engine.launch();
try {
  // --device "iPhone 15" borrows Playwright's viewport, scale and user agent.
  const preset = opts.device ? devices[opts.device] : null;
  if (opts.device && !preset) throw new Error(`unknown device "${opts.device}"`);
  const context = await browser.newContext({
    ...(preset ?? { viewport: { width: opts.width, height: opts.height } }),
    colorScheme: opts.appearance === "dark" ? "dark" : opts.appearance === "light" ? "light" : undefined,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") notes.push(`console.${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => notes.push(`uncaught: ${e.message}`));
  page.on("requestfailed", (r) => notes.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));

  const res = await page.goto(opts.url, { waitUntil: "networkidle", timeout: 60_000 }).catch(async (e) => {
    // networkidle never settles on pages holding a socket open (HMR); the
    // load event is good enough there.
    notes.push(`navigation: ${e.message.split("\n")[0]}`);
    return page.goto(opts.url, { waitUntil: "load", timeout: 60_000 });
  });
  if (res) notes.unshift(`HTTP ${res.status()} ${page.url()}`);

  if (opts.wait) await page.waitForSelector(opts.wait, { timeout: 30_000 });

  // Steps: click:SEL  type:SEL=TEXT  press:KEY  hover:SEL  wait:SEL
  //        goto:URL   sleep:MS      scroll:PX
  for (const step of opts.steps) {
    const at = step.indexOf(":");
    const verb = at < 0 ? step : step.slice(0, at);
    const arg = at < 0 ? "" : step.slice(at + 1);
    if (verb === "click") await page.click(arg, { timeout: 15_000 });
    else if (verb === "type" || verb === "fill") {
      const eq = arg.indexOf("=");
      await page.fill(arg.slice(0, eq), arg.slice(eq + 1), { timeout: 15_000 });
    } else if (verb === "press") await page.keyboard.press(arg);
    else if (verb === "hover") await page.hover(arg, { timeout: 15_000 });
    else if (verb === "wait") await page.waitForSelector(arg, { timeout: 30_000 });
    else if (verb === "goto") await page.goto(new URL(arg, page.url()).href, { waitUntil: "load" });
    else if (verb === "sleep") await page.waitForTimeout(Number(arg));
    else if (verb === "scroll") await page.mouse.wheel(0, Number(arg));
    else throw new Error(`unknown step "${step}"`);
  }
  await page.waitForTimeout(opts.delay ?? (opts.steps.length ? 500 : 250));
  await page.screenshot({ path: opts.out, fullPage: !!opts.full });
} catch (e) {
  notes.push(`error: ${e.message.split("\n")[0]}`);
  failed = true;
} finally {
  await browser.close();
}
console.log(notes.slice(0, 40).join("\n"));
process.exit(failed ? 1 : 0);
