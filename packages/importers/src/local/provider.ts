import type { GameMetadataPatch, ImportedGame, ImporterProvider } from "@hynite/core";
import { selectExe } from "./exe-select";
import { identifyCandidate, type IdentifyOptions } from "./identify";
import { hashFolderPath, scanLocalRoots } from "./scan";
import type { ExeFileInfo, IdentifyResult, LocalGameCandidate, LocalScanConfig } from "./types";

export type PeMetadataLookup = (paths: string[]) => Promise<ExeFileInfo[]>;

export type LocalScanIssue = {
  candidateId: string;
  folderPath: string;
  folderName: string;
  reason: "no_exes" | "ambiguous_exe" | "ambiguous_match" | "unmatched";
  /** For ambiguous_exe / ambiguous_match — top candidates the user can pick from. */
  detail?: unknown;
};

export type LocalScanReport = {
  imported: ImportedGame[];
  /** Per-game enrichment that should be merged onto the upserted game. */
  enrichment: Map<string, { match: IdentifyResult["kind"] extends "match" ? IdentifyResult : never } | { match?: never }>;
  /** Identification matches by candidate id, used by main to register sibling sources. */
  matches: Map<string, { provider: "steam" | "igdb"; externalId: string; confidence: number; reason: string }>;
  issues: LocalScanIssue[];
};

export type LocalProviderOptions = {
  scanConfig: LocalScanConfig;
  peMetadataLookup: PeMetadataLookup;
  identify: IdentifyOptions;
  /** Optional metadata refresh hook called once the launcher knows the matched provider+id. */
  refreshMetadata?: (game: ImportedGame) => Promise<GameMetadataPatch>;
};

export class LocalImporterProvider implements ImporterProvider {
  readonly id = "local" as const;
  readonly label = "Local";

  /** Captured during the most recent scan() so callers can recover ambiguity / matches. */
  lastReport?: LocalScanReport;

  constructor(private readonly options: LocalProviderOptions) {}

  async scan(): Promise<ImportedGame[]> {
    const candidates = await scanLocalRoots(this.options.scanConfig);
    const report: LocalScanReport = {
      imported: [],
      enrichment: new Map(),
      matches: new Map(),
      issues: []
    };

    for (const candidate of candidates) {
      const game = await this.processCandidate(candidate, report);
      if (game) report.imported.push(game);
    }

    this.lastReport = report;
    return report.imported;
  }

  async refreshMetadata(game: ImportedGame): Promise<GameMetadataPatch> {
    if (this.options.refreshMetadata) {
      return this.options.refreshMetadata(game);
    }
    return { metadataStatus: "partial" };
  }

  private async processCandidate(
    candidate: LocalGameCandidate,
    report: LocalScanReport
  ): Promise<ImportedGame | undefined> {
    if (candidate.exeFiles.length === 0) {
      report.issues.push({
        candidateId: candidate.id,
        folderPath: candidate.folderPath,
        folderName: candidate.folderName,
        reason: "no_exes"
      });
      return undefined;
    }

    const peInfos = await this.options.peMetadataLookup(candidate.exeFiles);
    const exeInfos: ExeFileInfo[] = candidate.exeFiles.map((path) => {
      const info = peInfos.find((entry) => entry.path === path);
      return {
        path,
        size: info?.size ?? 0,
        productName: info?.productName,
        fileDescription: info?.fileDescription,
        companyName: info?.companyName
      };
    });

    const selection = selectExe(candidate, exeInfos);
    if (!selection) {
      report.issues.push({
        candidateId: candidate.id,
        folderPath: candidate.folderPath,
        folderName: candidate.folderName,
        reason: "no_exes"
      });
      return undefined;
    }

    if (selection.ambiguous) {
      report.issues.push({
        candidateId: candidate.id,
        folderPath: candidate.folderPath,
        folderName: candidate.folderName,
        reason: "ambiguous_exe",
        detail: selection.scored.slice(0, 5)
      });
    }

    const identification = await identifyCandidate(candidate, selection.chosen, this.options.identify);
    let title = selection.chosen.productName ?? candidate.folderName;

    if (identification.kind === "match") {
      title = identification.match.title || title;
      report.matches.set(candidate.id, {
        provider: identification.match.provider,
        externalId: identification.match.externalId,
        confidence: identification.match.confidence,
        reason: identification.match.reason
      });
    } else if (identification.kind === "ambiguous") {
      report.issues.push({
        candidateId: candidate.id,
        folderPath: candidate.folderPath,
        folderName: candidate.folderName,
        reason: "ambiguous_match",
        detail: identification.candidates
      });
    } else {
      report.issues.push({
        candidateId: candidate.id,
        folderPath: candidate.folderPath,
        folderName: candidate.folderName,
        reason: "unmatched"
      });
    }

    return {
      provider: "local",
      externalId: candidate.id,
      title,
      installState: "installed",
      installDirectory: candidate.folderPath,
      executablePath: selection.chosen.path
    };
  }
}

export { hashFolderPath };
