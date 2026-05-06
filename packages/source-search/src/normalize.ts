const editionWords = [
  "deluxe",
  "ultimate",
  "complete",
  "definitive",
  "goty",
  "game of the year",
  "remastered",
  "remake",
  "standard",
  "edition",
  "bundle",
  "collection",
  "repack",
  "multi",
  "windows",
  "pc"
];

export function normalizeTitle(title: string): string {
  let value = title
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "")
    .replace(/&/g, " and ")
    .replace(/\b(vr|hd|dx\d+|x64|x86)\b/g, " ")
    .replace(/[\[\]().:_\-+/\\|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  for (const word of editionWords) {
    value = value.replace(new RegExp(`\\b${word}\\b`, "g"), " ");
  }

  return value.replace(/\s+/g, " ").trim();
}

