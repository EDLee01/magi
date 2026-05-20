import { describe, expect, it } from "vitest";

import { endOfWord, firstNonBlank, nextWord, prevWord } from "../src/vim/lineEditor.js";

describe("vim mode motions", () => {
  describe("nextWord (w)", () => {
    it("moves to start of next word", () => {
      expect(nextWord("hello world", 0)).toBe(6);
      expect(nextWord("hello world foo", 6)).toBe(12);
    });

    it("skips multiple spaces", () => {
      expect(nextWord("a   b", 0)).toBe(4);
    });

    it("at end of buffer returns buffer length", () => {
      expect(nextWord("hello", 4)).toBe(5);
    });

    it("handles punctuation", () => {
      expect(nextWord("foo,bar", 0)).toBe(4);
    });
  });

  describe("prevWord (b)", () => {
    it("moves to start of previous word", () => {
      expect(prevWord("hello world", 6)).toBe(0);
      expect(prevWord("hello world foo", 12)).toBe(6);
    });

    it("at start returns 0", () => {
      expect(prevWord("hello", 0)).toBe(0);
    });

    it("from middle of word goes to start of word", () => {
      expect(prevWord("hello", 3)).toBe(0);
    });
  });

  describe("endOfWord (e)", () => {
    it("moves to end of current word", () => {
      expect(endOfWord("hello world", 0)).toBe(4);
      expect(endOfWord("hello world", 6)).toBe(10);
    });

    it("skips whitespace to next word", () => {
      expect(endOfWord("a  b", 1)).toBe(3);
    });
  });

  describe("firstNonBlank (^)", () => {
    it("returns first non-whitespace position", () => {
      expect(firstNonBlank("   hello")).toBe(3);
      expect(firstNonBlank("\t\tfoo")).toBe(2);
    });

    it("returns 0 for non-indented text", () => {
      expect(firstNonBlank("hello")).toBe(0);
    });

    it("returns 0 for empty buffer", () => {
      expect(firstNonBlank("")).toBe(0);
    });
  });
});
