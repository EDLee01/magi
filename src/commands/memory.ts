import { SlashCommandInput } from "./registry.js";
import { formatMemory } from "../memory.js";
import { listMemdirEntries, findMemdirEntry } from "../memdir.js";
import { initMemory, listMemoryFiles, readMemoryFile } from "../memory-files.js";
import { retrieveRelevantMemory, formatMemoryContext } from "../memory-search.js";
import {
  proposeMemoryDraft,
  listDrafts,
  formatDraftReview,
  applyDraft,
  rejectDraft
} from "../memory-draft.js";
import { runDream, listDreams, showDream, applyDream, rejectDream } from "../memory-dream.js";
import { formatMemoryMerges, listMemoryMerges } from "../memory-merges.js";

export const command = {
  name: "memory",
  description: "Manage Memory files, drafts, and experimental Dream runs",
  usage:
    "/memory [init|list|show <path>|search <query>|drafts|draft show|apply|reject <id>|dream|dreams]",
  group: "Memory",
  handler: (args: string[], input: SlashCommandInput): string => {
    if (!input.paths) {
      return "Memory paths are unavailable";
    }
    const sub = args[0] ?? "list";
    const memoryRoot = input.config.memory.root;
    const rootInput = { appRoot: input.paths.root, root: memoryRoot };

    if (sub === "init") {
      const root = initMemory(rootInput);
      return `Memory initialized: ${root}`;
    }

    if (sub === "list" || args.length === 0) {
      const files = listMemoryFiles(rootInput);
      if (files.length === 0) {
        return ["No Memory files.", "", `Memory directory: ${initMemory(rootInput)}`].join("\n");
      }
      return [
        "Memory files:",
        ...files.map((file) => `  ${file.path.padEnd(36)} ${file.size} bytes`),
        "",
        "Use /memory show <path> to read a file, /memory search <query> to retrieve relevant Memory."
      ].join("\n");
    }

    if (sub === "show") {
      const target = args[1];
      if (!target) return "Usage: /memory show <path>";
      return readMemoryFile({ ...rootInput, filePath: target });
    }

    if (sub === "search") {
      const query = args.slice(1).join(" ");
      if (!query.trim()) return "Usage: /memory search <query>";
      const hits = retrieveRelevantMemory({
        ...rootInput,
        query,
        maxResults: input.config.memory.maxResults,
        sessionId: input.sessionId
      });
      return formatMemoryContext(hits) || "No matching Memory";
    }

    if (sub === "drafts") {
      const drafts = listDrafts(rootInput);
      if (drafts.length === 0) return "No Memory Drafts.";
      return [
        "Memory Drafts:",
        ...drafts.map((draft) => `  ${draft.id}  ${draft.status.padEnd(8)}  ${draft.targetFile}`)
      ].join("\n");
    }

    if (sub === "draft") {
      const action = args[1];
      const id = args[2];
      if (!action || !id) return "Usage: /memory draft <show|apply|reject> <id>";
      if (action === "show") return formatDraftReview({ ...rootInput, id });
      if (action === "apply") return `Applied Memory Draft: ${applyDraft({ ...rootInput, id }).id}`;
      if (action === "reject")
        return `Rejected Memory Draft: ${rejectDraft({ ...rootInput, id }).id}`;
      return `Unknown Memory Draft action: ${action}`;
    }

    if (sub === "dream") {
      const action = args[1];
      const id = args[2];
      if (!action) {
        const dream = runDream({ ...rootInput, paths: input.paths });
        return [
          `Experimental Dream created: ${dream.id}`,
          dream.summary,
          `Drafts: ${dream.draftIds.length}`
        ].join("\n");
      }
      if (!id) return "Usage: /memory dream <show|apply|reject> <id>";
      if (action === "show") return JSON.stringify(showDream({ ...rootInput, id }), null, 2);
      if (action === "apply") {
        const dream = applyDream({
          ...rootInput,
          id,
          paths: input.paths,
          applyDraft: (draftId) => applyDraft({ ...rootInput, id: draftId })
        });
        return `Applied Dream: ${dream.id}\nArchived graph nodes: ${dream.graphReview?.nodeIds.length ?? 0}\nRedirected graph edges: ${dream.graphReview?.redirectedEdgeCount ?? 0}\nFused graph node weights: ${dream.graphReview?.fusedWeightCount ?? 0}\nResolved graph edge conflicts: ${dream.graphReview?.resolvedEdgeConflictCount ?? 0}`;
      }
      if (action === "reject") {
        const dream = rejectDream({
          ...rootInput,
          id,
          paths: input.paths,
          rejectDraft: (draftId) => rejectDraft({ ...rootInput, id: draftId })
        });
        return `Rejected Dream: ${dream.id}\nKept graph nodes: ${dream.graphReview?.nodeIds.length ?? 0}`;
      }
      return `Unknown Dream action: ${action}`;
    }

    if (sub === "dreams") {
      const dreams = listDreams(rootInput);
      if (dreams.length === 0) return "No experimental Dream runs.";
      return [
        "Experimental Dream runs:",
        ...dreams.map(
          (dream) =>
            `  ${dream.id}  ${dream.status.padEnd(8)}  operations=${dream.operationCount} drafts=${dream.draftCount}`
        )
      ].join("\n");
    }

    if (sub === "merges") {
      const limit = readLimit(args.slice(1));
      return formatMemoryMerges(listMemoryMerges({ ...rootInput, paths: input.paths, limit }));
    }

    // Backwards compat: /memory <scope> with scope = user|project|session
    if (sub === "user" || sub === "project" || sub === "session") {
      return formatMemory({
        paths: input.paths,
        cwd: input.cwd,
        scope: sub,
        sessionId: input.sessionId
      });
    }

    if (sub === "memdir") {
      const entries = listMemdirEntries(input.paths);
      if (entries.length === 0) {
        return [
          "No memdir entries.",
          "",
          `Memdir directory: ${input.paths.root}/memdir/`,
          "Memories are saved here as typed markdown files (user/feedback/project/reference).",
          "Use /memory memdir-show <name> to view one, /memory delete <name> to propose an archive draft."
        ].join("\n");
      }
      const lines = ["Memdir entries:"];
      const byType: Record<string, typeof entries> = {
        user: [],
        feedback: [],
        project: [],
        reference: []
      };
      for (const e of entries) byType[e.type].push(e);
      for (const type of ["user", "feedback", "project", "reference"]) {
        const list = byType[type];
        if (list.length === 0) continue;
        lines.push("");
        lines.push(`  ${type}:`);
        for (const e of list) {
          lines.push(`    ${e.filename.padEnd(40)} ${e.description}`);
        }
      }
      lines.push("");
      lines.push(
        "Use /memory memdir-show <filename-or-name> to view, /memory delete <filename-or-name> to propose an archive draft."
      );
      return lines.join("\n");
    }

    if (sub === "memdir-show") {
      const target = args[1];
      if (!target) return "Usage: /memory memdir-show <filename-or-name>";
      const entry = findMemdirEntry(input.paths, target);
      if (!entry) return `Memory not found: ${target}`;
      return [
        `# ${entry.name}`,
        `Type: ${entry.type}`,
        `File: ${entry.filename}`,
        `Description: ${entry.description}`,
        "",
        entry.body
      ].join("\n");
    }

    if (sub === "delete" || sub === "remove" || sub === "rm") {
      const target = args[1];
      if (!target) return "Usage: /memory delete <filename-or-name>";
      const entry = findMemdirEntry(input.paths, target);
      if (!entry) return `Memory not found: ${target}`;
      const draft = proposeMemoryDraft({
        ...rootInput,
        targetFile: "archive/README.md",
        content: formatArchivedMemdirEntry(entry),
        reason: `Archive legacy memdir entry instead of deleting it: ${entry.filename}`,
        sourceSession: input.sessionId
      });
      return [
        `Created archive Memory Draft: ${draft.id} -> ${draft.targetFile}`,
        `Legacy memdir entry left unchanged: ${entry.filename}`,
        "Apply the draft to archive it; manual cleanup can happen after review."
      ].join("\n");
    }

    if (sub === "legacy") {
      const scope =
        args[1] === "user" || args[1] === "project" || args[1] === "session" ? args[1] : undefined;
      return formatMemory({
        paths: input.paths,
        cwd: input.cwd,
        scope,
        sessionId: input.sessionId
      });
    }

    return `Unknown subcommand: ${sub}. Usage: ${command.usage}`;
  }
};

function formatArchivedMemdirEntry(entry: {
  name: string;
  type: string;
  filename: string;
  description: string;
  body: string;
}): string {
  return [
    `## Archived legacy memory: ${entry.name}`,
    "",
    `Source: memdir/${entry.filename}`,
    `Type: ${entry.type}`,
    `Description: ${entry.description}`,
    "",
    entry.body
  ].join("\n");
}

function readLimit(args: string[]): number | undefined {
  let limit: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--limit") {
      const parsed = Number(args[++index]);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("/memory merges --limit must be a positive integer");
      }
      limit = parsed;
      continue;
    }
    throw new Error(`Unknown /memory merges option: ${arg}`);
  }
  return limit;
}
