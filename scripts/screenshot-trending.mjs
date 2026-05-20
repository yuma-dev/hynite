import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../");
const SHOT = path.join(ROOT, "scripts", "trending-screenshot.png");
const ELECTRON = path.join(ROOT, "node_modules/electron/dist/electron.exe");
const APP = path.join(ROOT, "apps/desktop");

// Launch electron with remote debugging
const proc = spawn(ELECTRON, [".", "--remote-debugging-port=9223"], {
  cwd: APP,
  env: { ...process.env, NODE_ENV: "production" },
  stdio: ["ignore", "pipe", "pipe"],
});

proc.stdout.on("data", d => process.stdout.write("[app] " + d));
proc.stderr.on("data", d => process.stderr.write("[app] " + d));

// Poll until the CDP endpoint is ready
async function waitForCdp(port, maxMs = 20_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error("CDP endpoint not ready after " + maxMs + "ms");
}

try {
  console.log("Waiting for CDP...");
  const info = await waitForCdp(9223);
  console.log("CDP ready:", info.Browser);

  const browser = await chromium.connectOverCDP(`http://localhost:9223`);
  const contexts = browser.contexts();
  console.log("Contexts:", contexts.length);

  let page;
  for (const ctx of contexts) {
    const pages = ctx.pages();
    console.log("Context pages:", pages.map(p => p.url()));
    const main = pages.find(p => !p.url().startsWith("devtools://") && !p.url().includes("splash") && p.url() !== "about:blank");
    if (main) { page = main; break; }
  }
  if (!page) {
    // Try new page event
    const allPages = contexts.flatMap(c => c.pages());
    page = allPages[0];
  }

  console.log("Using page:", page?.url());
  await new Promise(r => setTimeout(r, 4000));

  // Navigate to trending
  const navResult = await page.evaluate(() => {
    const el = [...document.querySelectorAll("button, a, [role=button]")]
      .find(e => /trending/i.test(e.textContent ?? ""));
    el?.click();
    return el ? ("clicked: " + el.textContent?.trim()) : "not found";
  });
  console.log("Nav:", navResult);

  await new Promise(r => setTimeout(r, 2500));
  await page.screenshot({ path: SHOT, fullPage: false });
  console.log("Screenshot saved:", SHOT);

  await browser.close();
} finally {
  proc.kill();
}
