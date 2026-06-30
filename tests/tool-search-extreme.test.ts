import { describe, expect, it } from "vitest";

import { resolveInitialExposedToolNames } from "../src/tool-loading.js";
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

function topResults(query: string, count = 5): string[] {
  const output = executeToolSearch({ query, maxResults: count }, searchableTools(), {
    coreToolNames: new Set(resolveInitialExposedToolNames("medium"))
  });
  if (output.startsWith("No tools match")) {
    return [];
  }
  return [...output.matchAll(/^\d+\. (\S+)/gm)].slice(0, count).map((match) => match[1]!);
}

function expectTop1(query: string, expected: string | string[]): void {
  const tops = topResults(query);
  expect(tops.length).toBeGreaterThan(0);
  const allowed = Array.isArray(expected) ? expected : [expected];
  expect(allowed).toContain(tops[0]);
}

function expectTop3(query: string, expected: string | string[]): void {
  const tops = topResults(query, 3);
  expect(tops.length).toBeGreaterThan(0);
  const allowed = Array.isArray(expected) ? expected : [expected];
  expect(tops.some((name) => allowed.includes(name))).toBe(true);
}

describe("ToolSearch extreme recall", () => {
  describe("ultra-short queries", () => {
    it.each([
      ["删", "FileDelete"],
      ["搜", ["Grep", "WebSearch", "Glob"]],
      ["记", "Memorize"]
    ])("top-1 for %s", (query, expected) => {
      expectTop1(query, expected);
    });
  });

  describe("informal Chinese", () => {
    it.each([
      ["改下代码", ["FilePatch", "FileEdit", "FileWrite"]],
      ["搜一下这个函数在哪", ["Grep", "LSP", "Glob"]],
      ["搞个新分支", "GitBranchCreate"],
      ["stash 一下", "GitStash"],
      ["回滚 commit", ["GitReset", "GitCheckout"]],
      ["撸个测试", ["VerifyPlanExecution", "Bash"]]
    ])("top-1 for %s", (query, expected) => {
      expectTop1(query, expected);
    });
  });

  describe("mixed language", () => {
    it.each([
      ["fix bug in 这个模块", ["FilePatch", "FileEdit", "Grep"]],
      ["run git status 看看", "GitStatus"],
      ["用 playwright 打开页面", ["Browser", "WebBrowser"]],
      ["decode base64 字符串", "Base64"],
      ["parse json path", "JsonQuery"]
    ])("top-1 for %s", (query, expected) => {
      expectTop1(query, expected);
    });
  });

  describe("obscure deferred tools", () => {
    it.each([
      ["查看目录树结构", ["TreeView", "DirList", "Glob"]],
      ["截个图", ["Snip", "Browser"]],
      ["后台监控进程输出", ["Monitor", "TaskOutput"]],
      ["发 HTTP 请求调 API", "HttpRequest"],
      ["draft 一个 learning 笔记", "LearningDraft"],
      ["进 worktree 改代码", "EnterWorktree"],
      ["who am i on this machine", ["WhoAmI", "SystemInfo"]],
      ["磁盘还剩多少空间", "DiskUsage"],
      ["kill 掉这个进程", "KillProcess"],
      ["列出 cron 任务", "CronList"],
      ["读 notebook 单元格", ["NotebookRead", "NotebookEdit"]],
      ["peer 列表", "ListPeers"]
    ])("top-1 for %s", (query, expected) => {
      expectTop1(query, expected);
    });
  });

  describe("ambiguous and noisy queries", () => {
    it.each([
      ["帮我查一下", ["Grep", "Glob", "ToolSearch", "WebSearch"]],
      ["搜索web并记住", ["WebSearch", "Memorize"]],
      ["git pr 评论", ["GitHubPRView", "GitHubIssueView"]],
      ["issue 详情", "GitHubIssueView"],
      ["修改文件！！！", ["FilePatch", "FileEdit"]],
      ["  记住偏好  ", "Memorize"],
      ["只读看看文件内容", "FileRead"],
      ["不要改文件先搜索", ["Grep", "Glob"]]
    ])("top-1 for %s", (query, expected) => {
      expectTop1(query, expected);
    });

    it.each([
      ["serch the web pls", "WebSearch"],
      ["editt file content", ["FileEdit", "FilePatch"]]
    ])("top-1 for typo query %s", (query, expected) => {
      expectTop1(query, expected);
    });

    it("ranks vague action queries in top 3", () => {
      expectTop3("处理一下", ["Agent", "Bash", "ToolSearch", "FilePatch"]);
    });
  });

  describe("aggregate extreme recall", () => {
    it("keeps top-1 recall above 90% on the extreme set", () => {
      const cases: Array<{ query: string; expected: string[] }> = [
        { query: "删", expected: ["FileDelete"] },
        { query: "改下代码", expected: ["FilePatch", "FileEdit", "FileWrite"] },
        { query: "stash 一下", expected: ["GitStash"] },
        { query: "decode base64 字符串", expected: ["Base64"] },
        { query: "截个图", expected: ["Snip", "Browser"] },
        { query: "列出 cron 任务", expected: ["CronList"] },
        { query: "peer 列表", expected: ["ListPeers"] },
        { query: "serch the web pls", expected: ["WebSearch"] },
        { query: "不要改文件先搜索", expected: ["Grep", "Glob"] },
        { query: "处理一下", expected: ["Agent", "Bash", "ToolSearch", "FilePatch"] }
      ];

      let top1 = 0;
      for (const item of cases) {
        const tops = topResults(item.query);
        if (item.expected.includes(tops[0] ?? "")) {
          top1 += 1;
        }
      }

      expect(top1 / cases.length).toBeGreaterThanOrEqual(0.9);
    });
  });
});
