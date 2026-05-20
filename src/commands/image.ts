import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { SlashCommandInput } from "./registry.js";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
};

const MAX_BYTES = 10 * 1024 * 1024; // 10MB

export const command = {
  name: "image",
  aliases: ["img"],
  description: "Attach an image file to your next message (queued; sent on next prompt)",
  usage: "/image <path>",
  group: "Session",
  handler: (args: string[], input: SlashCommandInput): string => {
    if (args.length === 0) {
      return [
        "Usage: /image <path>",
        "",
        "Reads the image, encodes as base64, and queues it on the next message.",
        "Supported: png, jpg, gif, webp. Max 10MB.",
        "",
        "Note: this is a one-shot queue. Submit your next prompt and the image will be attached."
      ].join("\n");
    }
    const filePath = path.resolve(input.cwd, args[0]);
    if (!existsSync(filePath)) {
      return `File not found: ${filePath}`;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) {
      return `Unsupported image type: ${ext}. Supported: ${Object.keys(MIME_BY_EXT).join(", ")}`;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(filePath);
    } catch (error) {
      return `Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (bytes.length > MAX_BYTES) {
      return `Image too large: ${bytes.length} bytes (max ${MAX_BYTES}). Resize before attaching.`;
    }
    const base64 = bytes.toString("base64");
    // Stash on a global pending-images registry. The TUI's prompt loop should
    // attach these to the next outgoing message.
    const pending = getPendingImages();
    pending.push({ mimeType: mime, data: base64, source: filePath });
    return `Queued image: ${path.basename(filePath)} (${formatBytes(bytes.length)}, ${mime}). It will attach to your next message.`;
  }
};

interface PendingImage {
  mimeType: string;
  data: string;
  source: string;
}

interface PendingImagesGlobal {
  __magiPendingImages?: PendingImage[];
}

export function getPendingImages(): PendingImage[] {
  const g = globalThis as PendingImagesGlobal;
  if (!g.__magiPendingImages) g.__magiPendingImages = [];
  return g.__magiPendingImages;
}

export function takePendingImages(): PendingImage[] {
  const g = globalThis as PendingImagesGlobal;
  const list = g.__magiPendingImages ?? [];
  g.__magiPendingImages = [];
  return list;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
