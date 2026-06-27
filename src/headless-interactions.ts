export type HeadlessInteractionMode = "auto" | "client";

export function shouldAutoResolveHeadlessInteractions(input: {
  permissionMode?: string;
  interactionMode?: HeadlessInteractionMode;
}): boolean {
  if (input.interactionMode === "client") {
    return false;
  }
  return input.permissionMode === "bypassPermissions";
}

export function readHeadlessInteractionMode(value: unknown): HeadlessInteractionMode | undefined {
  if (value === "auto" || value === "client") {
    return value;
  }
  return undefined;
}
