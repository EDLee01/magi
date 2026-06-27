import { describe, expect, it } from "vitest";

import {
  readHeadlessInteractionMode,
  shouldAutoResolveHeadlessInteractions
} from "../src/headless-interactions.js";

describe("headless interaction mode", () => {
  it("auto-resolves in bypassPermissions unless client mode is requested", () => {
    expect(
      shouldAutoResolveHeadlessInteractions({
        permissionMode: "bypassPermissions",
        interactionMode: "auto"
      })
    ).toBe(true);
    expect(
      shouldAutoResolveHeadlessInteractions({
        permissionMode: "bypassPermissions",
        interactionMode: undefined
      })
    ).toBe(true);
    expect(
      shouldAutoResolveHeadlessInteractions({
        permissionMode: "bypassPermissions",
        interactionMode: "client"
      })
    ).toBe(false);
    expect(
      shouldAutoResolveHeadlessInteractions({
        permissionMode: "default",
        interactionMode: "client"
      })
    ).toBe(false);
  });

  it("reads interaction mode from control job payloads", () => {
    expect(readHeadlessInteractionMode("client")).toBe("client");
    expect(readHeadlessInteractionMode("auto")).toBe("auto");
    expect(readHeadlessInteractionMode("invalid")).toBeUndefined();
  });
});
