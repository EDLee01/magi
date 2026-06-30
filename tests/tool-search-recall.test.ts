import { describe, expect, it } from "vitest";

import {
  parseToolSearchReveal,
  resolveInitialExposedToolNames,
  TOOL_PACKS
} from "../src/tool-loading.js";
import { getBuiltinToolRegistry } from "../src/tools/registry.js";
import { executeToolSearch } from "../src/tools/tool-search.js";

function searchableTools() {
  return [...getBuiltinToolRegistry().values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    category: tool.category,
    tags: tool.tags,
    inputSchema: tool.inputSchema,
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  }));
}

function firstToolSearchResult(output: string): string | undefined {
  return output.match(/^1\. (\S+)/m)?.[1];
}

function topToolSearchResults(output: string, count = 5): string[] {
  if (output.startsWith("No tools match")) {
    return [];
  }
  return [...output.matchAll(/^\d+\. (\S+)/gm)].slice(0, count).map((match) => match[1]!);
}

function search(query: string, profile: "medium" | "full" = "medium"): string {
  return executeToolSearch({ query, maxResults: 5 }, searchableTools(), {
    coreToolNames: new Set(resolveInitialExposedToolNames(profile))
  });
}

function expectTop(query: string, expected: string | string[]): void {
  const output = search(query);
  expect(output).not.toContain("No tools match");
  const tops = topToolSearchResults(output);
  const allowed = Array.isArray(expected) ? expected : [expected];
  expect(allowed).toContain(tops[0]);
}

describe("ToolSearch recall benchmark", () => {
  describe("Chinese file edit", () => {
    it.each([
      ["修改文件内容", ["FilePatch", "FileEdit", "FileWrite"]],
      ["编辑文件", ["FilePatch", "FileEdit", "FileWrite"]],
      ["帮我把 config 改一下", ["FilePatch", "FileEdit", "FileWrite"]],
      ["新建一个文件", ["FileWrite", "FileEdit", "FilePatch"]],
      ["打补丁修复 bug", ["FilePatch", "FileEdit"]]
    ])("top-1 for %s", (query, expected) => {
      expectTop(query, expected);
      expect(search(query)).toContain("intent: file-edit");
    });
  });

  describe("Chinese memory", () => {
    it.each([
      ["记住这个偏好", "Memorize"],
      ["以后记得用 pnpm", "Memorize"],
      ["保存偏好设置", "Memorize"],
      ["记忆不对请纠正", "MemoryCorrect"],
      ["纠正之前的记忆", "MemoryCorrect"]
    ])("top-1 for %s", (query, expected) => {
      expectTop(query, expected);
    });
  });

  describe("Chinese git", () => {
    it.each([
      ["查看 git 提交历史", "GitLog"],
      ["git diff 暂存区", "GitDiff"],
      ["创建新分支", "GitBranchCreate"],
      ["查看 pr diff", "GitHubPRDiff"]
    ])("top-1 for %s", (query, expected) => {
      expectTop(query, expected);
    });
  });

  describe("Chinese planning", () => {
    it.each([
      ["创建待办任务", "TodoWrite"],
      ["进入计划模式", ["EnterPlanMode", "TodoWrite"]]
    ])("top-1 for %s", (query, expected) => {
      expectTop(query, expected);
    });
  });

  describe("Chinese search and web", () => {
    it.each([
      ["查找匹配 ts 的文件", ["Glob", "Grep", "FileFind"]],
      ["搜索代码里的 TODO", ["Grep", "Glob"]],
      ["联网搜索一下", "WebSearch"],
      ["打开网页看看", ["Browser", "WebBrowser", "WebFetch"]],
      ["你能联网搜索吗", "WebSearch"]
    ])("top-1 for %s", (query, expected) => {
      expectTop(query, expected);
    });
  });

  describe("Chinese edge cases", () => {
    it.each([
      ["覆盖写入 readme", ["FileWrite", "FilePatch", "FileEdit"]],
      ["有什么工具可以用", "ToolSearch"],
      ["看看之前聊过什么", "SessionSearch"],
      ["删文件", "FileDelete"],
      ["复制文件到目录", ["FileCopy", "FileMove"]]
    ])("top-1 for %s", (query, expected) => {
      expectTop(query, expected);
    });
  });

  describe("Chinese misc tasks", () => {
    it.each([
      ["运行测试验证", "VerifyPlanExecution"],
      ["查 typescript 定义", "LSP"],
      ["ssh 连远程服务器", "SshExec"],
      ["创建定时任务", "CronCreate"],
      ["学一个 workflow 技能", "Skill"],
      ["启动子代理并行处理", "Agent"]
    ])("top-1 for %s", (query, expected) => {
      expectTop(query, expected);
    });
  });

  describe("English baseline on medium profile", () => {
    it.each([
      ["write a new file", "FileWrite"],
      ["apply patch to source", "FilePatch"],
      ["remember this preference", "Memorize"],
      ["create todo list", "TodoWrite"],
      ["find files by pattern", ["Glob", "Grep", "FileFind"]],
      ["can you search the web", "WebSearch"],
      ["run npm test", "VerifyPlanExecution"]
    ])("top-1 for %s", (query, expected) => {
      expectTop(query, expected);
    });

    it("ranks git history toward GitLog in top 3", () => {
      const tops = topToolSearchResults(search("git commit history"));
      expect(tops.slice(0, 3)).toContain("GitLog");
    });
  });

  describe("pack and select recall", () => {
    it("loads every tool pack by name", () => {
      const core = new Set(resolveInitialExposedToolNames("medium"));
      for (const packName of Object.keys(TOOL_PACKS)) {
        const output = executeToolSearch(
          { query: `pack:${packName}`, maxResults: 5 },
          searchableTools(),
          { coreToolNames: core }
        );
        expect(output).toContain(`Pack: ${packName}`);
        expect(parseToolSearchReveal(output).length).toBeGreaterThan(0);
      }
    });

    it("selects deferred tools by exact name", () => {
      const core = new Set(resolveInitialExposedToolNames("medium"));
      for (const name of ["FileWrite", "GitLog", "Memorize", "Browser", "Agent"]) {
        const output = executeToolSearch(
          { query: `select:${name}`, maxResults: 1 },
          searchableTools(),
          { coreToolNames: core }
        );
        expect(output).toContain(`Tool: ${name}`);
        expect(parseToolSearchReveal(output)).toEqual([name]);
      }
    });
  });

  describe("aggregate recall stats", () => {
    it("meets minimum top-1 recall on the curated set", () => {
      const cases: Array<{ query: string; expected: string[] }> = [
        { query: "修改文件内容", expected: ["FilePatch", "FileEdit", "FileWrite"] },
        { query: "记住这个偏好", expected: ["Memorize"] },
        { query: "查看 git 提交历史", expected: ["GitLog"] },
        { query: "创建待办任务", expected: ["TodoWrite"] },
        { query: "搜索代码里的 TODO", expected: ["Grep", "Glob"] },
        { query: "write a new file", expected: ["FileWrite"] },
        { query: "apply patch to source", expected: ["FilePatch"] },
        { query: "remember this preference", expected: ["Memorize"] }
      ];

      let top1 = 0;
      for (const item of cases) {
        const tops = topToolSearchResults(search(item.query));
        if (item.expected.includes(tops[0] ?? "")) {
          top1 += 1;
        }
      }

      expect(top1 / cases.length).toBeGreaterThanOrEqual(0.9);
    });
  });
});

describe("ToolSearch Chinese recall", () => {
  it("recalls edit tools from Chinese file-edit queries", () => {
    for (const query of ["修改文件内容", "编辑文件", "帮我把 config 改一下"]) {
      const output = search(query);
      expect(output).not.toContain("No tools match");
      expect(["FilePatch", "FileEdit", "FileWrite"]).toContain(firstToolSearchResult(output));
      expect(output).toContain("intent: file-edit");
    }
  });

  it("recalls memory tools from Chinese remember queries", () => {
    for (const query of ["记住这个偏好", "以后记得用这个方案", "保存偏好设置"]) {
      const output = search(query);
      expect(output).not.toContain("No tools match");
      expect(firstToolSearchResult(output)).toBe("Memorize");
      expect(output).toContain("intent: memory-write");
    }
  });

  it("recalls git log from Chinese git history queries", () => {
    const output = search("查看 git 提交历史");
    expect(output).not.toContain("No tools match");
    expect(firstToolSearchResult(output)).toBe("GitLog");
    expect(output).toContain("intent: git-workflow");
  });

  it("recalls todo tools from Chinese planning queries", () => {
    const output = search("创建待办任务");
    expect(output).not.toContain("No tools match");
    expect(firstToolSearchResult(output)).toBe("TodoWrite");
    expect(output).toContain("intent: planning-state");
  });

  it("still recalls web search from Chinese capability queries", () => {
    const output = search("联网搜索一下");
    expect(firstToolSearchResult(output)).toBe("WebSearch");
  });

  it("recalls workspace search tools from Chinese find-file queries", () => {
    const output = search("查找匹配 ts 的文件");
    expect(output).not.toContain("No tools match");
    expect(["Glob", "Grep", "FileFind"]).toContain(firstToolSearchResult(output));
  });
});
