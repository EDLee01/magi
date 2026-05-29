import { describe, expect, it } from "vitest";
import {
  encodePromptWithImages,
  parsePromptIntoParts,
  messageText,
  type MagiMessage
} from "../src/providers/ir.js";

describe("image content parts", () => {
  describe("encodePromptWithImages", () => {
    it("returns the bare prompt when no images", () => {
      expect(encodePromptWithImages("hi", [])).toBe("hi");
    });

    it("prepends sentinel-wrapped blocks for each image", () => {
      const out = encodePromptWithImages("describe this", [{ mimeType: "image/png", data: "AAA" }]);
      expect(out).toContain("MAGI_IMAGE");
      expect(out).toContain("image/png");
      expect(out).toContain("AAA");
      expect(out.endsWith("describe this")).toBe(true);
    });
  });

  describe("parsePromptIntoParts", () => {
    it("returns one text part for plain prompts", () => {
      const parts = parsePromptIntoParts("hello world");
      expect(parts.length).toBe(1);
      expect(parts[0]).toMatchObject({ type: "text", text: "hello world" });
    });

    it("extracts a single image part and trailing text", () => {
      const encoded = encodePromptWithImages("what is this?", [
        { mimeType: "image/jpeg", data: "BASE64DATA" }
      ]);
      const parts = parsePromptIntoParts(encoded);
      expect(parts.length).toBe(2);
      expect(parts[0]).toMatchObject({ type: "image", mimeType: "image/jpeg", data: "BASE64DATA" });
      expect(parts[1]).toMatchObject({ type: "text", text: "what is this?" });
    });

    it("extracts multiple images in order", () => {
      const encoded = encodePromptWithImages("compare", [
        { mimeType: "image/png", data: "A" },
        { mimeType: "image/png", data: "B" }
      ]);
      const parts = parsePromptIntoParts(encoded);
      const images = parts.filter((p) => p.type === "image");
      expect(images).toHaveLength(2);
      expect((images[0] as { data: string }).data).toBe("A");
      expect((images[1] as { data: string }).data).toBe("B");
    });

    it("falls back to a single text part on malformed input", () => {
      const parts = parsePromptIntoParts("<<MAGI_IMAGE:image/png|AAA");
      // No closing sentinel — entire prompt becomes text
      expect(parts.length).toBe(1);
      expect(parts[0].type).toBe("text");
    });
  });

  describe("messageText with image", () => {
    it("renders a placeholder for image parts", () => {
      const msg: MagiMessage = {
        role: "user",
        content: [
          { type: "text", text: "look:" },
          { type: "image", mimeType: "image/png", data: "X" }
        ]
      };
      const text = messageText(msg);
      expect(text).toContain("look:");
      expect(text).toContain("[image image/png]");
    });
  });
});
