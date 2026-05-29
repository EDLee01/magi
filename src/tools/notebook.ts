/**
 * Notebook tools: NotebookEdit and NotebookRead.
 * Jupyter notebook (.ipynb) cell manipulation and inspection.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveWorkspacePath } from "./workspace.js";

export const NotebookReadInputSchema = {
  type: "object",
  properties: {
    notebook_path: { type: "string", description: "Absolute path to the .ipynb file" },
    max_cells: { type: "number", description: "Max cells to display (default all)" }
  },
  required: ["notebook_path"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export const NotebookEditInputSchema = {
  type: "object",
  properties: {
    notebook_path: { type: "string", description: "Absolute path to the .ipynb file" },
    cell_number: { type: "number", description: "0-indexed cell number to edit" },
    new_source: { type: "string", description: "New source content for the cell" },
    cell_type: {
      type: "string",
      enum: ["code", "markdown"],
      description: "Cell type (required for insert)"
    },
    edit_mode: {
      type: "string",
      enum: ["replace", "insert", "delete"],
      description: "Edit mode (default: replace)"
    }
  },
  required: ["notebook_path", "new_source"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export interface NotebookEditInput {
  notebookPath: string;
  cellNumber?: number;
  newSource: string;
  cellType?: "code" | "markdown";
  editMode: "replace" | "insert" | "delete";
}

export function parseNotebookEditInput(input: Record<string, unknown>): NotebookEditInput {
  const notebookPath = input.notebook_path;
  if (typeof notebookPath !== "string" || !notebookPath.trim()) {
    throw new Error("notebook_path is required");
  }
  const newSource = input.new_source;
  if (typeof newSource !== "string") {
    throw new Error("new_source is required");
  }
  let editMode: "replace" | "insert" | "delete" = "replace";
  if (input.edit_mode !== undefined) {
    if (
      input.edit_mode !== "replace" &&
      input.edit_mode !== "insert" &&
      input.edit_mode !== "delete"
    ) {
      throw new Error("edit_mode must be replace, insert, or delete");
    }
    editMode = input.edit_mode;
  }
  let cellType: "code" | "markdown" | undefined;
  if (input.cell_type !== undefined) {
    if (input.cell_type !== "code" && input.cell_type !== "markdown") {
      throw new Error("cell_type must be code or markdown");
    }
    cellType = input.cell_type;
  }
  return {
    notebookPath: notebookPath.trim(),
    cellNumber: typeof input.cell_number === "number" ? input.cell_number : undefined,
    newSource,
    cellType,
    editMode
  };
}

export function executeNotebookEdit(cwd: string, input: NotebookEditInput): string {
  const resolved = resolveWorkspacePath(cwd, input.notebookPath);
  if (!existsSync(resolved.absolutePath)) {
    throw new Error(`Notebook not found: ${resolved.relativePath}`);
  }
  if (!resolved.absolutePath.endsWith(".ipynb")) {
    throw new Error("File must be a .ipynb notebook");
  }

  const raw = readFileSync(resolved.absolutePath, "utf8");
  const notebook = JSON.parse(raw);
  if (!notebook.cells || !Array.isArray(notebook.cells)) {
    throw new Error("Invalid notebook format: missing cells array");
  }

  const cellIndex = input.cellNumber ?? 0;

  if (input.editMode === "delete") {
    if (cellIndex < 0 || cellIndex >= notebook.cells.length) {
      throw new Error(`Cell index ${cellIndex} out of range (0-${notebook.cells.length - 1})`);
    }
    notebook.cells.splice(cellIndex, 1);
    writeFileSync(resolved.absolutePath, JSON.stringify(notebook, null, 1) + "\n", "utf8");
    return `Deleted cell ${cellIndex} from ${resolved.relativePath} (${notebook.cells.length} cells remaining)`;
  }

  if (input.editMode === "insert") {
    if (!input.cellType) {
      throw new Error("cell_type is required for insert mode");
    }
    const newCell = createCell(input.cellType, input.newSource);
    const insertAt = Math.min(cellIndex, notebook.cells.length);
    notebook.cells.splice(insertAt, 0, newCell);
    writeFileSync(resolved.absolutePath, JSON.stringify(notebook, null, 1) + "\n", "utf8");
    return `Inserted ${input.cellType} cell at index ${insertAt} in ${resolved.relativePath} (${notebook.cells.length} cells)`;
  }

  // replace
  if (cellIndex < 0 || cellIndex >= notebook.cells.length) {
    throw new Error(`Cell index ${cellIndex} out of range (0-${notebook.cells.length - 1})`);
  }
  const cell = notebook.cells[cellIndex];
  cell.source = input.newSource
    .split("\n")
    .map((line: string, i: number, arr: string[]) => (i < arr.length - 1 ? line + "\n" : line));
  if (input.cellType) {
    cell.cell_type = input.cellType;
  }
  writeFileSync(resolved.absolutePath, JSON.stringify(notebook, null, 1) + "\n", "utf8");
  return `Replaced cell ${cellIndex} in ${resolved.relativePath} (${input.cellType ?? cell.cell_type})`;
}

function createCell(cellType: "code" | "markdown", source: string): Record<string, unknown> {
  const sourceLines = source
    .split("\n")
    .map((line, i, arr) => (i < arr.length - 1 ? line + "\n" : line));
  if (cellType === "code") {
    return {
      cell_type: "code",
      execution_count: null,
      metadata: {},
      outputs: [],
      source: sourceLines
    };
  }
  return {
    cell_type: "markdown",
    metadata: {},
    source: sourceLines
  };
}

export interface NotebookReadInput {
  notebookPath: string;
  maxCells?: number;
}

export function parseNotebookReadInput(input: Record<string, unknown>): NotebookReadInput {
  const notebookPath = input.notebook_path;
  if (typeof notebookPath !== "string" || !notebookPath.trim()) {
    throw new Error("notebook_path is required");
  }
  return {
    notebookPath: notebookPath.trim(),
    maxCells:
      typeof input.max_cells === "number" && input.max_cells > 0 ? input.max_cells : undefined
  };
}

export function executeNotebookRead(cwd: string, input: NotebookReadInput): string {
  const resolved = resolveWorkspacePath(cwd, input.notebookPath);
  if (!existsSync(resolved.absolutePath)) {
    throw new Error(`Notebook not found: ${resolved.relativePath}`);
  }
  if (!resolved.absolutePath.endsWith(".ipynb")) {
    throw new Error("File must be a .ipynb notebook");
  }

  const raw = readFileSync(resolved.absolutePath, "utf8");
  const notebook = JSON.parse(raw);
  if (!notebook.cells || !Array.isArray(notebook.cells)) {
    throw new Error("Invalid notebook format: missing cells array");
  }

  const cells = input.maxCells ? notebook.cells.slice(0, input.maxCells) : notebook.cells;
  const output: string[] = [`Notebook: ${resolved.relativePath}`];
  output.push(
    `Cells: ${notebook.cells.length} total${input.maxCells ? ` (showing first ${input.maxCells})` : ""}`
  );
  output.push("");

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const cellType = cell.cell_type ?? "unknown";
    const source = Array.isArray(cell.source)
      ? cell.source.join("")
      : typeof cell.source === "string"
        ? cell.source
        : "";
    const execCount = cell.execution_count != null ? ` [exec: ${cell.execution_count}]` : "";

    output.push(`--- Cell ${i} (${cellType})${execCount} ---`);
    output.push(source || "(empty)");
    output.push("");
  }

  return output.join("\n");
}
