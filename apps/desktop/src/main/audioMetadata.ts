import { closeSync, openSync, readSync } from "node:fs";
import { extname } from "node:path";

export type AudioMetadata = {
  title?: string;
  artist?: string;
  album?: string;
  copyright?: string;
};

export type AudioArtwork = {
  mimeType: string;
  bytes: Buffer;
};

type Mp3Id3Data = AudioMetadata & {
  artwork?: AudioArtwork;
};

function synchsafeToInt(bytes: Buffer, offset: number): number {
  return ((bytes[offset] ?? 0) & 0x7f) << 21
    | ((bytes[offset + 1] ?? 0) & 0x7f) << 14
    | ((bytes[offset + 2] ?? 0) & 0x7f) << 7
    | ((bytes[offset + 3] ?? 0) & 0x7f);
}

function decodeId3TextFrame(bytes: Buffer): string | undefined {
  if (bytes.length < 2) return undefined;
  const encoding = bytes[0];
  const data = bytes.subarray(1);
  let text: string;
  if (encoding === 1 || encoding === 2) {
    text = data.toString("utf16le");
  } else if (encoding === 3) {
    text = data.toString("utf8");
  } else {
    text = data.toString("latin1");
  }
  const cleaned = text.replace(/^\uFEFF/, "").replace(/\0/g, "").trim();
  return cleaned || undefined;
}

function findUtf16Terminator(bytes: Buffer, offset: number): number {
  for (let i = offset; i + 1 < bytes.length; i += 2) {
    if (bytes[i] === 0 && bytes[i + 1] === 0) {
      return i;
    }
  }
  return -1;
}

function normalizeImageMime(value: string): string | undefined {
  const mime = value.trim().toLowerCase();
  if (mime === "image/jpg" || mime === "jpg" || mime === "jpeg") return "image/jpeg";
  if (mime === "png") return "image/png";
  if (mime === "gif") return "image/gif";
  if (mime === "webp") return "image/webp";
  return /^image\/(jpeg|png|gif|webp)$/.test(mime) ? mime : undefined;
}

function decodeApicFrame(bytes: Buffer): AudioArtwork | undefined {
  if (bytes.length < 5) return undefined;
  const encoding = bytes[0] ?? 0;
  let offset = 1;
  const mimeEnd = bytes.indexOf(0, offset);
  if (mimeEnd < 0) return undefined;
  const mimeType = normalizeImageMime(bytes.subarray(offset, mimeEnd).toString("latin1"));
  if (!mimeType) return undefined;

  offset = mimeEnd + 1;
  if (offset >= bytes.length) return undefined;
  offset += 1; // picture type

  const descriptionEnd = encoding === 1 || encoding === 2
    ? findUtf16Terminator(bytes, offset)
    : bytes.indexOf(0, offset);
  if (descriptionEnd < 0) return undefined;
  offset = descriptionEnd + (encoding === 1 || encoding === 2 ? 2 : 1);

  const artworkBytes = bytes.subarray(offset);
  return artworkBytes.length > 0 ? { mimeType, bytes: Buffer.from(artworkBytes) } : undefined;
}

function readMp3Id3Data(filePath: string): Mp3Id3Data {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const header = Buffer.alloc(10);
    if (readSync(fd, header, 0, header.length, 0) !== header.length) return {};
    if (header.subarray(0, 3).toString("latin1") !== "ID3") return {};
    const version = header[3];
    const tagSize = synchsafeToInt(header, 6);
    const bytes = Buffer.alloc(10 + tagSize);
    header.copy(bytes, 0);
    readSync(fd, bytes, 10, tagSize, 10);
    const end = bytes.length;
    const metadata: Mp3Id3Data = {};
    let offset = 10;

    while (offset + 10 <= end) {
      const frameId = bytes.subarray(offset, offset + 4).toString("latin1");
      if (!/^[A-Z0-9]{4}$/.test(frameId)) break;
      const frameSize = version === 4 ? synchsafeToInt(bytes, offset + 4) : bytes.readUInt32BE(offset + 4);
      offset += 10;
      if (frameSize <= 0 || offset + frameSize > end) break;
      const payload = bytes.subarray(offset, offset + frameSize);
      if (frameId === "APIC" && !metadata.artwork) {
        metadata.artwork = decodeApicFrame(payload);
      } else {
        const value = decodeId3TextFrame(payload);
        if (value) {
          if (frameId === "TIT2") metadata.title = value;
          if (frameId === "TPE1") metadata.artist = value;
          if (frameId === "TALB") metadata.album = value;
          if (frameId === "TCOP") metadata.copyright = value;
        }
      }
      offset += frameSize;
    }

    return metadata;
  } catch {
    return {};
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failure after metadata best-effort read.
      }
    }
  }
}

export function readAudioMetadata(filePath: string): AudioMetadata {
  return extname(filePath).toLowerCase() === ".mp3" ? readMp3Id3Data(filePath) : {};
}

export function readAudioArtwork(filePath: string): AudioArtwork | undefined {
  return extname(filePath).toLowerCase() === ".mp3" ? readMp3Id3Data(filePath).artwork : undefined;
}
