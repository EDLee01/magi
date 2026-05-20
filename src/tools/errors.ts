export type ToolErrorKind =
  | "outside-workspace"
  | "file-too-large"
  | "binary-file"
  | "not-found"
  | "bad-input"
  | "approval-required"
  | "command-failed"
  | "timeout";

export class ToolError extends Error {
  readonly kind: ToolErrorKind;

  constructor(message: string, kind: ToolErrorKind) {
    super(message);
    this.name = "ToolError";
    this.kind = kind;
  }
}
