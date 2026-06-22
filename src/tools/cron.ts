import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface CronJobRecord {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt: string;
}

export interface CronStoreData {
  version: 1;
  jobs: CronJobRecord[];
}

export interface CronCreateInput {
  cron: string;
  prompt: string;
  recurring?: boolean;
  durable?: boolean;
  now?: Date;
}

export interface CronUpdateInput {
  id: string;
  cron?: string;
  prompt?: string;
  recurring?: boolean;
  durable?: boolean;
  enabled?: boolean;
  now?: Date;
}

export interface CronRunResult {
  job: CronJobRecord;
  prompt: string;
}

export const CRON_CREATE_SCHEMA = {
  type: "object",
  properties: {
    cron: { type: "string" },
    prompt: { type: "string" },
    recurring: { type: "boolean" },
    durable: { type: "boolean" }
  },
  required: ["cron", "prompt"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export const CRON_UPDATE_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    cron: { type: "string" },
    prompt: { type: "string" },
    recurring: { type: "boolean" },
    durable: { type: "boolean" },
    enabled: { type: "boolean" }
  },
  required: ["id"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export const CRON_DELETE_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" }
  },
  required: ["id"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export const CRON_LIST_SCHEMA = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function createCronJob(input: CronCreateInput): CronJobRecord {
  const now = input.now ?? new Date();
  const cron = normalizeCron(input.cron);
  const prompt = readNonEmptyString(input.prompt, "prompt");
  return {
    id: randomUUID(),
    cron,
    prompt,
    recurring: input.recurring ?? true,
    durable: input.durable ?? true,
    enabled: true,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    nextRunAt: nextCronRun(cron, now).toISOString()
  };
}

export function updateCronJob(job: CronJobRecord, input: CronUpdateInput): CronJobRecord {
  const now = input.now ?? new Date();
  const cron = input.cron === undefined ? job.cron : normalizeCron(input.cron);
  const prompt =
    input.prompt === undefined ? job.prompt : readNonEmptyString(input.prompt, "prompt");
  return {
    ...job,
    cron,
    prompt,
    recurring: input.recurring ?? job.recurring,
    durable: input.durable ?? job.durable,
    enabled: input.enabled ?? job.enabled,
    updatedAt: now.toISOString(),
    nextRunAt:
      cron !== job.cron || input.enabled === true
        ? nextCronRun(cron, now).toISOString()
        : job.nextRunAt
  };
}

export function loadCronStore(filePath: string): CronStoreData {
  if (!existsSync(filePath)) {
    return { version: 1, jobs: [] };
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.jobs)) {
    throw new Error(`Invalid cron store: ${filePath}`);
  }
  return {
    version: 1,
    jobs: parsed.jobs.map(readCronJob)
  };
}

export function saveCronStore(filePath: string, store: CronStoreData): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  // Cron prompts are model-authored instructions that later run headlessly —
  // keep the store owner-only so it can't be read or tampered with by others.
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, filePath);
}

export function cronStorePathFromRoot(stateRoot: string): string {
  return path.join(stateRoot, "cron-jobs.json");
}

export function addCronJob(filePath: string, input: CronCreateInput): CronJobRecord {
  const store = loadCronStore(filePath);
  const job = createCronJob(input);
  store.jobs.push(job);
  saveCronStore(filePath, store);
  return job;
}

export function applyCronUpdate(filePath: string, input: CronUpdateInput): CronJobRecord {
  const store = loadCronStore(filePath);
  const index = store.jobs.findIndex((job) => job.id === input.id);
  if (index === -1) {
    throw new Error(`Cron job not found: ${input.id}`);
  }
  const updated = updateCronJob(store.jobs[index], input);
  store.jobs[index] = updated;
  saveCronStore(filePath, store);
  return updated;
}

export function deleteCronJob(filePath: string, id: string): CronJobRecord {
  const store = loadCronStore(filePath);
  const index = store.jobs.findIndex((job) => job.id === id);
  if (index === -1) {
    throw new Error(`Cron job not found: ${id}`);
  }
  const [deleted] = store.jobs.splice(index, 1);
  saveCronStore(filePath, store);
  return deleted;
}

export function listCronJobs(filePath: string): CronJobRecord[] {
  return loadCronStore(filePath).jobs.sort((left, right) =>
    left.nextRunAt.localeCompare(right.nextRunAt)
  );
}

export function takeDueCronJobs(filePath: string, now = new Date()): CronRunResult[] {
  const store = loadCronStore(filePath);
  const due: CronRunResult[] = [];
  const updatedJobs = store.jobs.map((job) => {
    if (!job.enabled || new Date(job.nextRunAt).getTime() > now.getTime()) {
      return job;
    }
    due.push({ job, prompt: job.prompt });
    const next = job.recurring
      ? {
          ...job,
          lastRunAt: now.toISOString(),
          nextRunAt: nextCronRun(job.cron, now).toISOString(),
          updatedAt: now.toISOString()
        }
      : { ...job, lastRunAt: now.toISOString(), enabled: false, updatedAt: now.toISOString() };
    return next;
  });
  if (due.length > 0) {
    saveCronStore(filePath, { version: 1, jobs: updatedJobs });
  }
  return due;
}

export function formatCronJob(job: CronJobRecord): string {
  return [
    `id: ${job.id}`,
    `cron: ${job.cron}`,
    `prompt: ${job.prompt}`,
    `recurring: ${job.recurring ? "true" : "false"}`,
    `durable: ${job.durable ? "true" : "false"}`,
    `enabled: ${job.enabled ? "true" : "false"}`,
    job.lastRunAt ? `lastRunAt: ${job.lastRunAt}` : undefined,
    `nextRunAt: ${job.nextRunAt}`
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function formatCronList(jobs: CronJobRecord[]): string {
  if (jobs.length === 0) {
    return "No cron jobs";
  }
  return jobs.map(formatCronJob).join("\n\n");
}

export function normalizeCron(value: string): string {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      "Cron expression must have exactly 5 fields: minute hour day-of-month month day-of-week"
    );
  }
  fields.forEach((field, index) => {
    parseCronField(field, CRON_FIELD_BOUNDS[index], CRON_FIELD_NAMES[index]);
  });
  return fields.join(" ");
}

export function nextCronRun(expression: string, from = new Date()): Date {
  const cron = parseCron(expression);
  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const limit = 366 * 24 * 60;
  for (let attempts = 0; attempts < limit; attempts += 1) {
    if (matchesCron(cron, candidate)) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  throw new Error(`Cron expression has no run within one year: ${expression}`);
}

function parseCron(expression: string): Array<Set<number>> {
  const fields = normalizeCron(expression).split(" ");
  return fields.map((field, index) =>
    parseCronField(field, CRON_FIELD_BOUNDS[index], CRON_FIELD_NAMES[index])
  );
}

function matchesCron(cron: Array<Set<number>>, date: Date): boolean {
  const values = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay()
  ];
  return cron.every((field, index) => field.has(values[index]));
}

function parseCronField(
  field: string,
  bounds: { min: number; max: number },
  name: string
): Set<number> {
  const values = new Set<number>();
  for (const piece of field.split(",")) {
    parseCronPiece(piece, bounds, name).forEach((value) => values.add(value));
  }
  if (values.size === 0) {
    throw new Error(`Cron field ${name} produced no values`);
  }
  return values;
}

function parseCronPiece(
  piece: string,
  bounds: { min: number; max: number },
  name: string
): number[] {
  const [rangePart, stepPart] = piece.split("/");
  if (piece.includes("/") && (stepPart === undefined || stepPart === "")) {
    throw new Error(`Cron field ${name} has an empty step`);
  }
  const step = stepPart === undefined ? 1 : readCronNumber(stepPart, bounds, `${name} step`);
  if (step < 1) {
    throw new Error(`Cron field ${name} step must be >= 1`);
  }
  const range =
    rangePart === "*"
      ? { start: bounds.min, end: bounds.max }
      : readCronRange(rangePart, bounds, name);
  const values: number[] = [];
  for (let value = range.start; value <= range.end; value += step) {
    values.push(value);
  }
  return values;
}

function readCronRange(
  value: string,
  bounds: { min: number; max: number },
  name: string
): { start: number; end: number } {
  if (value.includes("-")) {
    const [startText, endText] = value.split("-");
    const start = readCronNumber(startText, bounds, `${name} range start`);
    const end = readCronNumber(endText, bounds, `${name} range end`);
    if (end < start) {
      throw new Error(`Cron field ${name} range end must be >= start`);
    }
    return { start, end };
  }
  const number = readCronNumber(value, bounds, name);
  return { start: number, end: number };
}

function readCronNumber(
  value: string | undefined,
  bounds: { min: number; max: number },
  name: string
): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error(`Cron field ${name} must be a number`);
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < bounds.min || number > bounds.max) {
    throw new Error(`Cron field ${name} must be between ${bounds.min} and ${bounds.max}`);
  }
  return number;
}

function readCronJob(value: unknown): CronJobRecord {
  if (!isRecord(value)) {
    throw new Error("Cron job must be an object");
  }
  return {
    id: readNonEmptyString(value.id, "id"),
    cron: normalizeCron(readNonEmptyString(value.cron, "cron")),
    prompt: readNonEmptyString(value.prompt, "prompt"),
    recurring: readBoolean(value.recurring, "recurring"),
    durable: readBoolean(value.durable, "durable"),
    enabled: readBoolean(value.enabled, "enabled"),
    createdAt: readNonEmptyString(value.createdAt, "createdAt"),
    updatedAt: readNonEmptyString(value.updatedAt, "updatedAt"),
    lastRunAt:
      value.lastRunAt === undefined ? undefined : readNonEmptyString(value.lastRunAt, "lastRunAt"),
    nextRunAt: readNonEmptyString(value.nextRunAt, "nextRunAt")
  };
}

function readNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Cron ${name} must be a non-empty string`);
  }
  return value;
}

function readBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Cron ${name} must be a boolean`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CRON_FIELD_BOUNDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 }
] as const;

const CRON_FIELD_NAMES = ["minute", "hour", "day-of-month", "month", "day-of-week"] as const;
