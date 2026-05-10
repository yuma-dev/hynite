/* eslint-disable no-console */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hashFolderPath,
  identifyCandidate,
  scanLocalRoots,
  selectExe,
  type ExeFileInfo,
  type IdentifyCandidate,
  type LocalGameCandidate
} from "@hynite/importers";
import { searchSteamStore } from "../apps/desktop/src/main/steamSearchService";

// ---------- Tiny native-bridge client (FileVersionInfo only) ---------------

type RpcResponse<T> = { id?: string; result?: T; error?: { message: string } };

class TinyBridge {
  private process?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  async getFileVersionInfo(paths: string[]): Promise<Array<{
    path: string;
    exists: boolean;
    size?: number;
    productName?: string | null;
    fileDescription?: string | null;
    companyName?: string | null;
  }>> {
    if (paths.length === 0) return [];
    const result = await this.request<{ results: any[] }>("getFileVersionInfo", { paths });
    return result.results ?? [];
  }

  private request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const child = this.ensureProcess();
    const id = randomUUID();
    return new Promise<T>((resolveReq, reject) => {
      this.pending.set(id, { resolve: resolveReq as (v: unknown) => void, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.process && !this.process.killed) return this.process;
    const here = dirname(fileURLToPath(import.meta.url));
    const projectPath = resolve(here, "../native/Hynite.NativeBridge/Hynite.NativeBridge.csproj");
    const child = spawn("dotnet", ["run", "--project", projectPath, "-c", "Release"], {
      cwd: dirname(projectPath),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => process.stderr.write(`[bridge] ${chunk}`));
    this.process = child;
    return child;
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx = this.buffer.indexOf("\n");
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.startsWith("{")) {
        try {
          const response = JSON.parse(line) as RpcResponse<unknown>;
          if (response.id) {
            const pending = this.pending.get(response.id);
            if (pending) {
              this.pending.delete(response.id);
              if (response.error) pending.reject(new Error(response.error.message));
              else pending.resolve(response.result);
            }
          }
        } catch {
          // not a response line
        }
      }
      idx = this.buffer.indexOf("\n");
    }
  }

  shutdown(): void {
    this.process?.kill();
  }
}

// ---------- Main test ------------------------------------------------------

async function main() {
  const roots = [
    { path: "F:\\Games", depth: 1 },
    { path: "C:\\Users\\Fabia\\Documents\\online-fix", depth: 1 }
  ];

  console.log("Scanning roots...");
  const startScan = Date.now();
  const candidates = await scanLocalRoots({
    roots,
    excludePatterns: ["^_redist$", "^Tools$", "^Saves$", "^Backups$", "^DLC$", "^_CommonRedist$"]
  });
  console.log(`Found ${candidates.length} candidates in ${Date.now() - startScan}ms\n`);

  const bridge = new TinyBridge();

  const results: Array<{
    candidate: LocalGameCandidate;
    chosenExe: string;
    exeAmbiguous: boolean;
    matchKind: string;
    matchTitle?: string;
    matchProvider?: string;
    matchExternalId?: string;
    matchConfidence?: number;
    matchReason?: string;
  }> = [];

  for (const candidate of candidates) {
    process.stdout.write(`. ${candidate.folderName} `);
    const peInfos = await bridge.getFileVersionInfo(candidate.exeFiles);
    const exeInfos: ExeFileInfo[] = candidate.exeFiles.map((path) => {
      const info = peInfos.find((entry) => entry.path === path);
      return {
        path,
        size: info?.size ?? 0,
        productName: info?.productName ?? undefined,
        fileDescription: info?.fileDescription ?? undefined,
        companyName: info?.companyName ?? undefined
      };
    });
    const selection = selectExe(candidate, exeInfos);
    if (!selection) {
      console.log("(no exe)");
      continue;
    }

    const identification = await identifyCandidate(candidate, selection.chosen, {
      steamSearch: async (query) => {
        try {
          const found = await searchSteamStore(query, fetch);
          return found.slice(0, 6).map((entry): IdentifyCandidate => ({
            provider: "steam",
            externalId: entry.appId,
            title: entry.title,
            confidence: 0,
            reason: "search",
            releaseDate: entry.releaseDate
          }));
        } catch (error) {
          console.warn(`\n  steam search failed for "${query}":`, error);
          return [];
        }
      }
    });

    const baseRecord = {
      candidate,
      chosenExe: selection.chosen.path.replace(candidate.folderPath, ""),
      exeAmbiguous: selection.ambiguous
    };

    if (identification.kind === "match") {
      console.log(`→ ${identification.match.title} (${identification.match.provider}:${identification.match.externalId} conf=${identification.match.confidence.toFixed(2)} via ${identification.match.reason})`);
      results.push({
        ...baseRecord,
        matchKind: "match",
        matchTitle: identification.match.title,
        matchProvider: identification.match.provider,
        matchExternalId: identification.match.externalId,
        matchConfidence: identification.match.confidence,
        matchReason: identification.match.reason
      });
    } else if (identification.kind === "ambiguous") {
      const top = identification.candidates[0];
      console.log(`? AMBIGUOUS top=${top?.title} (conf=${identification.topConfidence.toFixed(2)})`);
      results.push({ ...baseRecord, matchKind: "ambiguous", matchTitle: top?.title, matchConfidence: identification.topConfidence });
    } else {
      console.log(`✗ unmatched (${identification.reason})`);
      results.push({ ...baseRecord, matchKind: "unmatched" });
    }
  }

  bridge.shutdown();

  // ---- Summary ----
  console.log("\n========== SUMMARY ==========");
  const matched = results.filter((r) => r.matchKind === "match").length;
  const ambiguous = results.filter((r) => r.matchKind === "ambiguous").length;
  const unmatched = results.filter((r) => r.matchKind === "unmatched").length;
  const exeAmbiguous = results.filter((r) => r.exeAmbiguous).length;
  console.log(`Total candidates:   ${results.length}`);
  console.log(`Matched:            ${matched} (${pct(matched, results.length)})`);
  console.log(`Ambiguous match:    ${ambiguous} (${pct(ambiguous, results.length)})`);
  console.log(`Unmatched:          ${unmatched} (${pct(unmatched, results.length)})`);
  console.log(`Exe ambiguity flag: ${exeAmbiguous} (${pct(exeAmbiguous, results.length)})`);

  console.log("\n--- Per-candidate detail (sorted by confidence) ---");
  const sorted = [...results].sort((a, b) => (a.matchConfidence ?? 0) - (b.matchConfidence ?? 0));
  for (const r of sorted) {
    const conf = r.matchConfidence !== undefined ? r.matchConfidence.toFixed(2) : "----";
    const status =
      r.matchKind === "match" ? "✓" : r.matchKind === "ambiguous" ? "?" : "✗";
    const flag = r.exeAmbiguous ? " [exe?]" : "";
    console.log(`${status} [${conf}] ${r.candidate.folderName.padEnd(50)} → ${r.matchTitle ?? "—"} (${r.matchProvider ?? "—"}:${r.matchExternalId ?? "—"} ${r.matchReason ?? ""})${flag}`);
    console.log(`     exe: ${r.chosenExe}`);
  }
}

function pct(n: number, d: number): string {
  if (d === 0) return "0%";
  return `${Math.round((n / d) * 100)}%`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
