import { z } from "zod";

export const downloadSourceFileSchema = z.object({
  name: z.string().min(1),
  downloads: z.array(
    z.object({
      title: z.string().min(1),
      fileSize: z.string().optional(),
      uris: z.array(z.string().min(1)),
      uploadDate: z.string().optional()
    })
  )
});

export type DownloadSourceFile = z.infer<typeof downloadSourceFileSchema>;

export function parseDownloadSourceJson(json: string): DownloadSourceFile {
  const parsed = JSON.parse(json) as unknown;
  return downloadSourceFileSchema.parse(parsed);
}

export function filterSupportedUris(uris: string[]): string[] {
  return uris.filter((uri) => {
    const lower = uri.toLocaleLowerCase();
    return lower.startsWith("magnet:") || lower.startsWith("https://") || lower.startsWith("http://");
  });
}

