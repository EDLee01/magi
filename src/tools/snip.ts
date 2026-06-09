import { spawnSync } from "node:child_process";
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";

import { ToolError } from "./errors.js";

export interface SnipResult {
  filePath: string;
  format: string;
  platform: string;
  message: string;
}

export const SnipInputSchema = {
  type: "object",
  properties: {
    format: {
      type: "string",
      enum: ["png", "jpg"],
      description: "Image format for the screenshot"
    }
  },
  required: [],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseSnipInput(input: Record<string, unknown>): { format: string } {
  const format = typeof input.format === "string" ? input.format : "png";
  if (format !== "png" && format !== "jpg") {
    throw new ToolError(`Invalid format: ${format}. Must be png or jpg`, "bad-input");
  }
  return { format };
}

export async function executeSnip(input: { format: string; cwd: string }): Promise<SnipResult> {
  const platform = os.platform();
  const tmpDir = path.join(input.cwd, ".magi-snip");

  // Ensure temp directory exists
  if (!existsSync(tmpDir)) {
    mkdirSync(tmpDir, { recursive: true });
  }

  const fileName = `snip-${Date.now()}.${input.format}`;
  const filePath = path.join(tmpDir, fileName);

  try {
    if (platform === "darwin") {
      // macOS: use screencapture
      runCaptureCommand("screencapture", ["-x", filePath]);
    } else if (platform === "linux") {
      // Linux: try gnome-screenshot first, fall back to import
      try {
        runCaptureCommand("gnome-screenshot", ["-f", filePath]);
      } catch {
        // Fall back to ImageMagick import
        runCaptureCommand("import", ["-window", "root", filePath]);
      }
    } else if (platform === "win32") {
      // Windows: use PowerShell
      const escapedFilePath = filePath.replace(/'/g, "''");
      const psCommand = `
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object {
          $bitmap = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height)
          $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
          $graphics.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size)
          $bitmap.Save('${escapedFilePath}')
          $graphics.Dispose()
          $bitmap.Dispose()
        }
      `;
      runCaptureCommand("powershell.exe", ["-NoProfile", "-Command", psCommand]);
    } else {
      throw new ToolError(`Unsupported platform: ${platform}`, "command-failed");
    }

    // Verify file was created
    if (!existsSync(filePath)) {
      throw new ToolError(`Screenshot file was not created at ${filePath}`, "command-failed");
    }

    return {
      filePath,
      format: input.format,
      platform,
      message: `Screenshot saved to ${filePath}`
    };
  } catch (error) {
    if (error instanceof ToolError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError(`Failed to take screenshot: ${message}`, "command-failed");
  }
}

function runCaptureCommand(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? result.stderr.trim() ?? `${command} failed`);
  }
}

export function formatSnipResult(result: SnipResult): string {
  return [
    `Screenshot saved: ${result.filePath}`,
    `Format: ${result.format}`,
    `Platform: ${result.platform}`,
    "",
    "You can now read this image using the FileRead tool to analyze its contents."
  ].join("\n");
}
