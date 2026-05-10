/* eslint-disable no-console */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSingleCandidate, identifyCandidate, selectExe, type ExeFileInfo, type IdentifyCandidate } from "@hynite/importers";
import { searchSteamStore } from "../apps/desktop/src/main/steamSearchService";

type RpcResponse<T> = { id?: string; result?: T; error?: { message: string } };

class TinyBridge {
  private process?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  async getFileVersionInfo(paths: string[]): Promise<Array<{
    path: string; exists: boolean; size?: number;
    productName?: string | null; fileDescription?: string | null; companyName?: string | null;
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
        } catch {/* */}
      }
      idx = this.buffer.indexOf("\n");
    }
  }

  shutdown(): void { this.process?.kill(); }
}

async function addOne(bridge: TinyBridge, label: string, args: { folderPath?: string; executablePath?: string }) {
  console.log(`\n— ${label} —`);
  console.log(`   args: ${JSON.stringify(args)}`);
  const folderPath = args.folderPath ?? (args.executablePath ? dirname(args.executablePath) : undefined);
  if (!folderPath) { console.log("   (no path)"); return; }

  const candidate = await buildSingleCandidate(folderPath);
  if (!candidate) { console.log("   no exes found"); return; }

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

  let chosenExe: ExeFileInfo;
  if (args.executablePath) {
    chosenExe = exeInfos.find((info) => info.path.toLowerCase() === args.executablePath!.toLowerCase()) ?? {
      path: args.executablePath, size: 0
    };
  } else {
    const selection = selectExe(candidate, exeInfos);
    if (!selection) { console.log("   no exe selected"); return; }
    chosenExe = selection.chosen;
  }

  const identification = await identifyCandidate(candidate, chosenExe, {
    steamSearch: async (query) => {
      const found = await searchSteamStore(query, fetch);
      return found.slice(0, 6).map((entry): IdentifyCandidate => ({
        provider: "steam", externalId: entry.appId, title: entry.title,
        confidence: 0, reason: "search", releaseDate: entry.releaseDate
      }));
    }
  });

  console.log(`   chosen exe: ${chosenExe.path}`);
  console.log(`   PE ProductName: ${chosenExe.productName ?? "(none)"}`);
  if (identification.kind === "match") {
    console.log(`   ✓ MATCH: ${identification.match.title} (${identification.match.provider}:${identification.match.externalId} conf=${identification.match.confidence.toFixed(2)} reason=${identification.match.reason})`);
  } else if (identification.kind === "ambiguous") {
    console.log(`   ? AMBIGUOUS top=${identification.candidates[0]?.title} (conf=${identification.topConfidence.toFixed(2)})`);
    for (const cand of identification.candidates.slice(0, 3)) {
      console.log(`        - ${cand.title} (${cand.provider}:${cand.externalId})`);
    }
  } else {
    console.log(`   ✗ unmatched (${identification.reason})`);
  }
}

async function main() {
  const bridge = new TinyBridge();
  // Folder mode
  await addOne(bridge, "Folder mode: Diablo IV", { folderPath: "F:\\Games\\Diablo IV" });
  await addOne(bridge, "Folder mode: jackbox (test ambiguous exe)", { folderPath: "F:\\Games\\jackbox" });
  // Exe mode (override exe selection)
  await addOne(bridge, "Exe mode: Risk of Rain 2 nested", {
    executablePath: "C:\\Users\\Fabia\\Documents\\online-fix\\Risk of Rain 2\\Risk.of.Rain.2.v1.4.1.886-OFME\\Risk of Rain 2\\Risk of Rain 2.exe"
  });
  bridge.shutdown();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
