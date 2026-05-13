import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = join(root, "node_modules", "electron-vite", "bin", "electron-vite.js");
const env = { ...process.env };
const args = process.argv.slice(2).filter((arg) => {
  if (arg === "--startup-profile") {
    env.HYNITE_STARTUP_PROFILE = "1";
    return false;
  }

  if (arg === "--onboarding-preview") {
    env.HYNITE_ONBOARDING_PREVIEW = "1";
    return false;
  }

  return true;
});

delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(process.execPath, [bin, ...args], {
  cwd: root,
  env,
  stdio: "inherit",
  shell: false
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  }
  process.exit(code ?? 0);
});
