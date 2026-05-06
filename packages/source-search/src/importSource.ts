import { createHash, randomUUID } from "node:crypto";
import { filterSupportedUris, parseDownloadSourceJson } from "./schema";
import { normalizeTitle } from "./normalize";

export type PreparedSourceImport = {
  id: string;
  name: string;
  rawHash: string;
  importedEntries: number;
  skippedEntries: number;
  entries: Array<{
    id: string;
    title: string;
    normalizedTitle: string;
    fileSize?: string;
    uploadDate?: string;
    uris: string[];
  }>;
};

export function prepareSourceImport(json: string): PreparedSourceImport {
  const source = parseDownloadSourceJson(json);
  const rawHash = createHash("sha256").update(json).digest("hex");
  const entries = source.downloads.flatMap((download) => {
    const uris = filterSupportedUris(download.uris);
    if (uris.length === 0) {
      return [];
    }

    return [
      {
        id: randomUUID(),
        title: download.title,
        normalizedTitle: normalizeTitle(download.title),
        fileSize: download.fileSize,
        uploadDate: download.uploadDate,
        uris
      }
    ];
  });

  return {
    id: randomUUID(),
    name: source.name,
    rawHash,
    importedEntries: entries.length,
    skippedEntries: source.downloads.length - entries.length,
    entries
  };
}

