import { MagiToolUsePart } from "./providers/ir.js";
import { AskUserQuestionAnswer, AskUserQuestionRequest } from "./tools/user-question.js";

export type ActiveInteractionKind = "approval" | "question";
export type ActiveInteractionStatus = "pending" | "resolved" | "timeout" | "cancelled";

export interface ActiveInteractionView {
  kind: ActiveInteractionKind;
  status: ActiveInteractionStatus;
  sessionId: string;
  jobId: string;
  toolUseId: string;
  toolName: string;
  createdAt: string;
  updatedAt: string;
  timeoutAt?: string;
  reason?: string;
  toolUse: MagiToolUsePart;
  question?: AskUserQuestionRequest;
  approved?: boolean;
  answer?: AskUserQuestionAnswer;
  cancelReason?: string;
}

export class ActiveInteractionTimeoutError extends Error {
  readonly status = "timeout" as const;

  constructor(message: string) {
    super(message);
    this.name = "ActiveInteractionTimeoutError";
  }
}

export class ActiveInteractionCancelledError extends Error {
  readonly status = "cancelled" as const;

  constructor(message: string) {
    super(message);
    this.name = "ActiveInteractionCancelledError";
  }
}

export class ActiveInteractionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActiveInteractionNotFoundError";
  }
}

export class ActiveInteractionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActiveInteractionStateError";
  }
}

type PendingApproval = ActiveInteractionView & {
  kind: "approval";
  resolve: (approved: boolean) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
};

type PendingQuestion = ActiveInteractionView & {
  kind: "question";
  question: AskUserQuestionRequest;
  resolve: (answer: AskUserQuestionAnswer) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
};

type PendingInteraction = PendingApproval | PendingQuestion;

export class ActiveInteractionRegistry {
  private readonly defaultTimeoutMs: number;
  private readonly activeJobs = new Map<
    string,
    { sessionId: string; jobId: string; createdAt: string }
  >();
  private readonly interactions = new Map<string, PendingInteraction>();

  constructor(input: { timeoutMs?: number } = {}) {
    this.defaultTimeoutMs = input.timeoutMs ?? 300_000;
  }

  registerJob(input: { sessionId: string; jobId: string }): void {
    this.activeJobs.set(input.jobId, {
      sessionId: input.sessionId,
      jobId: input.jobId,
      createdAt: new Date().toISOString()
    });
  }

  unregisterJob(jobId: string, reason = "job finished"): void {
    for (const interaction of this.listInteractions({ jobId, status: "pending" })) {
      this.cancelInteraction({
        jobId,
        toolUseId: interaction.toolUseId,
        reason
      });
    }
    this.activeJobs.delete(jobId);
    for (const [key, interaction] of this.interactions) {
      if (interaction.jobId === jobId) {
        this.clearTimer(interaction);
        this.interactions.delete(key);
      }
    }
  }

  isJobActive(jobId: string): boolean {
    return this.activeJobs.has(jobId);
  }

  listInteractions(
    input: {
      jobId?: string;
      status?: ActiveInteractionStatus;
      kind?: ActiveInteractionKind;
    } = {}
  ): ActiveInteractionView[] {
    return [...this.interactions.values()]
      .filter((interaction) => (input.jobId ? interaction.jobId === input.jobId : true))
      .filter((interaction) => (input.status ? interaction.status === input.status : true))
      .filter((interaction) => (input.kind ? interaction.kind === input.kind : true))
      .map(toView);
  }

  getInteraction(input: { jobId: string; toolUseId: string }): ActiveInteractionView | undefined {
    const interaction = this.interactions.get(this.key(input.jobId, input.toolUseId));
    return interaction ? toView(interaction) : undefined;
  }

  getPendingQuestion(input: { jobId: string; toolUseId: string }): ActiveInteractionView & {
    kind: "question";
    question: AskUserQuestionRequest;
  } {
    const interaction = this.getPending(input.jobId, input.toolUseId, "question");
    return toView(interaction) as ActiveInteractionView & {
      kind: "question";
      question: AskUserQuestionRequest;
    };
  }

  waitForApproval(input: {
    sessionId: string;
    jobId: string;
    toolUse: MagiToolUsePart;
    reason: string;
    timeoutMs?: number;
  }): Promise<boolean> {
    this.ensureJob(input.sessionId, input.jobId);
    const key = this.key(input.jobId, input.toolUse.id);
    if (this.interactions.get(key)?.status === "pending") {
      throw new ActiveInteractionStateError(
        `Interaction already pending for ${input.jobId}/${input.toolUse.id}`
      );
    }
    return new Promise<boolean>((resolve, reject) => {
      const now = new Date();
      const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
      const interaction: PendingApproval = {
        kind: "approval",
        status: "pending",
        sessionId: input.sessionId,
        jobId: input.jobId,
        toolUseId: input.toolUse.id,
        toolName: input.toolUse.name,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        timeoutAt: new Date(now.getTime() + timeoutMs).toISOString(),
        reason: input.reason,
        toolUse: input.toolUse,
        resolve,
        reject
      };
      interaction.timer = this.createTimeoutTimer(interaction, timeoutMs);
      this.interactions.set(key, interaction);
    });
  }

  waitForQuestion(input: {
    sessionId: string;
    jobId: string;
    toolUse: MagiToolUsePart;
    question: AskUserQuestionRequest;
    timeoutMs?: number;
  }): Promise<AskUserQuestionAnswer> {
    this.ensureJob(input.sessionId, input.jobId);
    const key = this.key(input.jobId, input.toolUse.id);
    if (this.interactions.get(key)?.status === "pending") {
      throw new ActiveInteractionStateError(
        `Interaction already pending for ${input.jobId}/${input.toolUse.id}`
      );
    }
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const now = new Date();
      const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
      const interaction: PendingQuestion = {
        kind: "question",
        status: "pending",
        sessionId: input.sessionId,
        jobId: input.jobId,
        toolUseId: input.toolUse.id,
        toolName: input.toolUse.name,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        timeoutAt: new Date(now.getTime() + timeoutMs).toISOString(),
        toolUse: input.toolUse,
        question: input.question,
        resolve,
        reject
      };
      interaction.timer = this.createTimeoutTimer(interaction, timeoutMs);
      this.interactions.set(key, interaction);
    });
  }

  resolveApproval(input: {
    jobId: string;
    toolUseId: string;
    approved: boolean;
  }): ActiveInteractionView {
    const interaction = this.getPending(input.jobId, input.toolUseId, "approval");
    if (interaction.kind !== "approval") {
      throw new ActiveInteractionNotFoundError(
        `No active approval interaction for ${input.jobId}/${input.toolUseId}`
      );
    }
    interaction.status = "resolved";
    interaction.updatedAt = new Date().toISOString();
    interaction.approved = input.approved;
    this.clearTimer(interaction);
    interaction.resolve(input.approved);
    return toView(interaction);
  }

  resolveQuestion(input: {
    jobId: string;
    toolUseId: string;
    answer: AskUserQuestionAnswer;
  }): ActiveInteractionView {
    const interaction = this.getPending(input.jobId, input.toolUseId, "question");
    if (interaction.kind !== "question") {
      throw new ActiveInteractionNotFoundError(
        `No active question interaction for ${input.jobId}/${input.toolUseId}`
      );
    }
    interaction.status = "resolved";
    interaction.updatedAt = new Date().toISOString();
    interaction.answer = input.answer;
    this.clearTimer(interaction);
    interaction.resolve(input.answer);
    return toView(interaction);
  }

  cancelInteraction(input: {
    jobId: string;
    toolUseId: string;
    reason?: string;
  }): ActiveInteractionView {
    const interaction = this.getPending(input.jobId, input.toolUseId);
    this.cancelPendingInteraction(interaction, input.reason);
    return toView(interaction);
  }

  close(reason = "registry closed"): void {
    for (const interaction of this.interactions.values()) {
      if (interaction.status === "pending") {
        this.cancelPendingInteraction(interaction, reason);
      } else {
        this.clearTimer(interaction);
      }
    }
    this.activeJobs.clear();
    this.interactions.clear();
  }

  private ensureJob(sessionId: string, jobId: string): void {
    if (!this.activeJobs.has(jobId)) {
      this.registerJob({ sessionId, jobId });
    }
  }

  private createTimeoutTimer(
    interaction: PendingInteraction,
    timeoutMs: number
  ): NodeJS.Timeout | undefined {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return undefined;
    }
    const timer = setTimeout(() => {
      if (interaction.status !== "pending") {
        return;
      }
      interaction.status = "timeout";
      interaction.updatedAt = new Date().toISOString();
      interaction.reject(
        new ActiveInteractionTimeoutError(
          `Interaction ${interaction.jobId}/${interaction.toolUseId} timed out`
        )
      );
    }, timeoutMs);
    timer.unref?.();
    return timer;
  }

  private getPending(
    jobId: string,
    toolUseId: string,
    kind?: ActiveInteractionKind
  ): PendingInteraction {
    const interaction = this.interactions.get(this.key(jobId, toolUseId));
    if (!interaction) {
      throw new ActiveInteractionNotFoundError(`No active interaction for ${jobId}/${toolUseId}`);
    }
    if (kind && interaction.kind !== kind) {
      throw new ActiveInteractionNotFoundError(
        `No active ${kind} interaction for ${jobId}/${toolUseId}`
      );
    }
    if (interaction.status !== "pending") {
      throw new ActiveInteractionStateError(
        `Interaction ${jobId}/${toolUseId} is ${interaction.status}`
      );
    }
    return interaction;
  }

  private clearTimer(interaction: PendingInteraction): void {
    if (interaction.timer) {
      clearTimeout(interaction.timer);
      interaction.timer = undefined;
    }
  }

  private cancelPendingInteraction(interaction: PendingInteraction, reason?: string): void {
    interaction.status = "cancelled";
    interaction.updatedAt = new Date().toISOString();
    interaction.cancelReason = reason;
    this.clearTimer(interaction);
    interaction.reject(
      new ActiveInteractionCancelledError(
        `Interaction ${interaction.jobId}/${interaction.toolUseId} was cancelled${reason ? `: ${reason}` : ""}`
      )
    );
  }

  private key(jobId: string, toolUseId: string): string {
    return `${jobId}\0${toolUseId}`;
  }
}

export function interactionErrorStatus(error: unknown): ActiveInteractionStatus | undefined {
  if (error instanceof ActiveInteractionTimeoutError) {
    return "timeout";
  }
  if (error instanceof ActiveInteractionCancelledError) {
    return "cancelled";
  }
  return undefined;
}

function toView(interaction: PendingInteraction): ActiveInteractionView {
  return {
    kind: interaction.kind,
    status: interaction.status,
    sessionId: interaction.sessionId,
    jobId: interaction.jobId,
    toolUseId: interaction.toolUseId,
    toolName: interaction.toolName,
    createdAt: interaction.createdAt,
    updatedAt: interaction.updatedAt,
    timeoutAt: interaction.timeoutAt,
    reason: interaction.reason,
    toolUse: interaction.toolUse,
    question: interaction.kind === "question" ? interaction.question : undefined,
    approved: interaction.approved,
    answer: interaction.answer,
    cancelReason: interaction.cancelReason
  };
}
