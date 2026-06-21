import { describe, it, expect } from "vitest";
import {
  classifyTask,
  scoreCandidate,
  routeAuto,
  routeAutoDetailed,
  ModelCapabilities,
  RouteKind
} from "../src/routing/model-router.js";
import { MagiConfig } from "../src/config.js";

describe("ModelRouter", () => {
  describe("classifyTask", () => {
    it("classifies short non-technical prompts as quick", () => {
      expect(classifyTask("hello")).toBe("quick");
      expect(classifyTask("what time is it?")).toBe("quick");
      expect(classifyTask("translate this to French")).toBe("quick");
    });

    it("classifies code-related prompts as coding", () => {
      expect(classifyTask("write a function that sorts an array")).toBe("coding");
      expect(classifyTask("fix the import statement in my module")).toBe("coding");
      expect(classifyTask("add async await to the fetch call and handle the return value")).toBe(
        "coding"
      );
    });

    it("classifies reasoning prompts without code keywords as reasoning", () => {
      expect(
        classifyTask("explain why the earth orbits the sun and analyze the implications of gravity")
      ).toBe("reasoning");
      expect(
        classifyTask(
          "compare and evaluate the trade-offs between these two approaches to urban planning"
        )
      ).toBe("reasoning");
    });

    it("classifies review prompts as review", () => {
      expect(
        classifyTask(
          "review this code for quality issues and suggest improvements to optimize performance"
        )
      ).toBe("review");
      expect(classifyTask("refactor the authentication module to simplify the logic")).toBe(
        "review"
      );
    });

    it("classifies prompts with images as vision", () => {
      expect(classifyTask("describe this", true)).toBe("vision");
      expect(classifyTask("write a function based on this diagram", true)).toBe("vision");
    });

    it("classifies very long prompts as long_context", () => {
      const longPrompt = "word ".repeat(60_000);
      expect(classifyTask(longPrompt)).toBe("long_context");
    });
  });

  describe("scoreCandidate", () => {
    const claudeOpus: ModelCapabilities = {
      family: "claude",
      role: "opus",
      contextWindow: 200_000,
      supportsVision: true
    };
    const claudeHaiku: ModelCapabilities = {
      family: "claude",
      role: "haiku",
      contextWindow: 200_000,
      supportsVision: true
    };
    const deepseek: ModelCapabilities = {
      family: "deepseek",
      role: "main",
      contextWindow: 128_000,
      supportsVision: false
    };
    const gemini: ModelCapabilities = {
      family: "gemini",
      role: "main",
      contextWindow: 1_000_000,
      supportsVision: true
    };

    it("scores claude highest for coding tasks", () => {
      const claudeScore = scoreCandidate(claudeOpus, "coding");
      const deepseekScore = scoreCandidate(deepseek, "coding");
      expect(claudeScore).toBeGreaterThan(deepseekScore);
    });

    it("scores deepseek highest for reasoning tasks", () => {
      const deepseekScore = scoreCandidate(deepseek, "reasoning");
      const claudeScore = scoreCandidate(claudeOpus, "reasoning");
      expect(deepseekScore).toBeGreaterThan(claudeScore);
    });

    it("scores haiku highest for quick tasks", () => {
      const haikuScore = scoreCandidate(claudeHaiku, "quick");
      const opusScore = scoreCandidate(claudeOpus, "quick");
      expect(haikuScore).toBeGreaterThan(opusScore);
    });

    it("scores large context window models highest for long_context", () => {
      const geminiScore = scoreCandidate(gemini, "long_context");
      const claudeScore = scoreCandidate(claudeOpus, "long_context");
      expect(geminiScore).toBeGreaterThan(claudeScore);
    });

    it("scores vision-capable models for vision tasks", () => {
      const claudeScore = scoreCandidate(claudeOpus, "vision");
      const deepseekScore = scoreCandidate(deepseek, "vision");
      expect(claudeScore).toBeGreaterThan(deepseekScore);
    });

    it("scores coding-specialized models higher for coding and review work", () => {
      const generalGpt: ModelCapabilities = {
        family: "gpt",
        role: "main",
        contextWindow: 1_050_000,
        supportsVision: true
      };
      const codex: ModelCapabilities = {
        family: "gpt",
        role: "main",
        contextWindow: 400_000,
        supportsVision: true,
        specialty: "coding",
        priority: 3
      };
      expect(scoreCandidate(codex, "coding")).toBeGreaterThan(scoreCandidate(generalGpt, "coding"));
      expect(scoreCandidate(codex, "review")).toBeGreaterThan(scoreCandidate(generalGpt, "review"));
    });
  });

  describe("routeAuto", () => {
    function makeConfig(router: Record<string, ModelCapabilities>): MagiConfig {
      return {
        version: "0.1",
        control: { bind: "127.0.0.1", port: 8765 },
        providers: {
          claude: { type: "openai", baseUrl: "http://localhost/v1" },
          deepseek: { type: "openai", baseUrl: "http://localhost/v1" }
        },
        models: {
          aliases: {
            coding: "claude:claude-opus",
            reasoning: "deepseek:deepseek-r1",
            fast: "claude:claude-haiku"
          },
          fallbacks: {},
          router
        },
        mcp: { servers: {} },
        hooks: [],
        context: { recentMessages: 6 },
        memory: {
          enabled: false,
          autoWrite: "off",
          maxResults: 5,
          scopes: [],
          dream: { enabled: false, intervalMs: 86400000 }
        },
        webSearch: {
          locale: "en",
          market: "us",
          mainlandBoost: false,
          queryParam: "q",
          resultsPath: "results",
          titlePath: "title",
          urlPath: "url",
          snippetPath: "snippet",
          maxResults: 5
        }
      };
    }

    it("returns undefined when no router config", () => {
      const config = makeConfig({});
      // router is undefined when empty
      config.models.router = undefined;
      expect(routeAuto(config, "hello")).toBeUndefined();
    });

    it("picks the best alias for a coding prompt", () => {
      const config = makeConfig({
        coding: { family: "claude", role: "opus", contextWindow: 200_000, supportsVision: true },
        reasoning: {
          family: "deepseek",
          role: "main",
          contextWindow: 128_000,
          supportsVision: false
        },
        fast: { family: "claude", role: "haiku", contextWindow: 200_000, supportsVision: true }
      });
      const result = routeAuto(config, "write a function that implements binary search");
      expect(result).toBeDefined();
      expect(result!.source).toBe("coding");
    });

    it("picks the reasoning alias for reasoning prompts", () => {
      const config = makeConfig({
        coding: { family: "claude", role: "opus", contextWindow: 200_000, supportsVision: true },
        reasoning: {
          family: "deepseek",
          role: "main",
          contextWindow: 128_000,
          supportsVision: false
        },
        fast: { family: "claude", role: "haiku", contextWindow: 200_000, supportsVision: true }
      });
      const result = routeAuto(
        config,
        "explain why quantum entanglement implies non-locality and analyze the implications"
      );
      expect(result).toBeDefined();
      expect(result!.source).toBe("reasoning");
    });

    it("picks the fast alias for quick prompts", () => {
      const config = makeConfig({
        coding: { family: "claude", role: "opus", contextWindow: 200_000, supportsVision: true },
        reasoning: {
          family: "deepseek",
          role: "main",
          contextWindow: 128_000,
          supportsVision: false
        },
        fast: { family: "claude", role: "haiku", contextWindow: 200_000, supportsVision: true }
      });
      const result = routeAuto(config, "hi");
      expect(result).toBeDefined();
      expect(result!.source).toBe("fast");
    });
  });

  describe("RouteContext (plan mode, token threshold, tool_heavy)", () => {
    it("forces planning route when isPlanMode is set", () => {
      expect(classifyTask("write a function", { isPlanMode: true })).toBe("planning");
      expect(classifyTask("hi", { isPlanMode: true })).toBe("planning");
    });

    it("forces long_context when estimatedContextTokens exceeds threshold", () => {
      expect(classifyTask("simple prompt", { estimatedContextTokens: 250_000 })).toBe(
        "long_context"
      );
      // Below threshold — falls through to normal classification
      expect(classifyTask("hi", { estimatedContextTokens: 100_000 })).toBe("quick");
    });

    it("respects custom longContextThreshold", () => {
      expect(
        classifyTask("simple", { estimatedContextTokens: 100_000, longContextThreshold: 80_000 })
      ).toBe("long_context");
    });

    it("classifies tool_heavy prompts when keywords match", () => {
      expect(classifyTask("scaffold a new project with typescript and tests")).toBe("tool_heavy");
      expect(classifyTask("migrate codebase to use new auth library")).toBe("tool_heavy");
      expect(classifyTask("bootstrap a fresh nextjs project with tailwind")).toBe("tool_heavy");
    });

    it("review keywords still take precedence over tool_heavy regex", () => {
      expect(classifyTask("refactor the authentication module to simplify the logic")).toBe(
        "review"
      );
    });
  });

  describe("routeAutoDetailed", () => {
    function makeFullConfig(router: Record<string, ModelCapabilities>): MagiConfig {
      const aliases: Record<string, string> = {};
      for (const key of Object.keys(router)) {
        aliases[key] = `claude:${key}-model`;
      }
      return {
        version: "0.1",
        control: { bind: "127.0.0.1", port: 8765 },
        providers: { claude: { type: "openai", baseUrl: "http://localhost/v1" } },
        models: { aliases, fallbacks: {}, router },
        mcp: { servers: {} },
        hooks: [],
        context: { recentMessages: 6 },
        memory: {
          enabled: false,
          autoWrite: "off",
          maxResults: 5,
          scopes: [],
          dream: { enabled: false, intervalMs: 86400000 }
        },
        webSearch: {
          locale: "en",
          market: "us",
          mainlandBoost: false,
          queryParam: "q",
          resultsPath: "results",
          titlePath: "title",
          urlPath: "url",
          snippetPath: "snippet",
          maxResults: 5
        }
      } as unknown as MagiConfig;
    }

    it("returns full decision with task kind, score, and candidate ranking", () => {
      const config = makeFullConfig({
        fast: { family: "claude", role: "haiku", contextWindow: 200_000, supportsVision: true },
        main: { family: "claude", role: "sonnet", contextWindow: 200_000, supportsVision: true },
        deep: { family: "claude", role: "opus", contextWindow: 200_000, supportsVision: true }
      });
      const decision = routeAutoDetailed(
        config,
        "design the architecture for a distributed system with bounded contexts and propose a plan for the migration with clear roadmap"
      );
      expect(decision).toBeDefined();
      expect(decision!.routeKind).toBe("planning");
      expect(decision!.candidates.length).toBe(3);
      expect(decision!.candidates[0].score).toBeGreaterThanOrEqual(decision!.candidates[1].score);
      expect(decision!.chosenAlias).toBe("deep");
    });

    it("upgrades selection when isPlanMode is set", () => {
      const config = makeFullConfig({
        fast: { family: "claude", role: "haiku", contextWindow: 200_000, supportsVision: true },
        main: { family: "claude", role: "sonnet", contextWindow: 200_000, supportsVision: true },
        deep: { family: "claude", role: "opus", contextWindow: 200_000, supportsVision: true }
      });
      const trivialDecision = routeAutoDetailed(config, "hi");
      const planDecision = routeAutoDetailed(config, "hi", { isPlanMode: true });
      expect(trivialDecision!.chosenAlias).toBe("fast");
      expect(planDecision!.chosenAlias).toBe("deep");
      expect(planDecision!.routeKind).toBe("planning");
    });

    it("forces long_context routing when context exceeds threshold", () => {
      const config = makeFullConfig({
        fast: { family: "claude", role: "haiku", contextWindow: 200_000, supportsVision: true },
        long: { family: "gemini", role: "main", contextWindow: 1_000_000, supportsVision: false }
      });
      const decision = routeAutoDetailed(config, "tell me a joke", {
        estimatedContextTokens: 250_000
      });
      expect(decision!.routeKind).toBe("long_context");
      expect(decision!.chosenAlias).toBe("long");
    });

    it("returns undefined when no router config is present", () => {
      const config = makeFullConfig({});
      const decision = routeAutoDetailed(config, "hello");
      expect(decision).toBeUndefined();
    });

    it("routes coding work to a coding-specialized alias over a larger general model", () => {
      const config = makeFullConfig({
        main: { family: "gpt", role: "main", contextWindow: 1_050_000, supportsVision: true },
        codex: {
          family: "gpt",
          role: "main",
          contextWindow: 400_000,
          supportsVision: true,
          specialty: "coding",
          priority: 3
        }
      });
      const decision = routeAutoDetailed(
        config,
        "implement a function that parses TypeScript imports and updates every file"
      );
      expect(decision!.chosenAlias).toBe("codex");
    });
  });
});
