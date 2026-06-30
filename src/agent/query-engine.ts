import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  MagiMessage,
  MagiToolUsePart,
  messageText,
  parsePromptIntoParts,
  textMessage
} from "../providers/ir.js";
import { SessionStore } from "../session-store.js";
import { AgentRoute, AgentQueryEvent, AgentQueryResult, runAgentQuery } from "./query.js";
import { AgentToolResult, ToolPermissionMode } from "./tools.js";
import { HookDefinition, HookEvent, McpServerConfig, WebSearchConfig } from "../config.js";
import { executeHooks, HookResult } from "../hooks/runner.js";
import { compactSessionWithHooks } from "../context/compaction.js";
import { computeSessionContextBudget } from "../context/token-budget.js";
import { buildLayeredContext } from "../context/layers.js";
import {
  AskUserQuestionAnswer,
  buildHeadlessAutoAskUserQuestionAnswer,
  UserQuestionResolver
} from "../tools/user-question.js";
import { shouldAutoResolveHeadlessInteractions } from "../headless-interactions.js";
import type { HeadlessInteractionMode } from "../headless-interactions.js";
import { UserMessageSink } from "../tools/user-message.js";
import { ActiveInteractionRegistry, interactionErrorStatus } from "../interactions.js";
import { appendMemory, MemoryScope } from "../memory.js";
import { retrieveRelevantMemory, formatMemoryContext } from "../memory-search.js";
import { MemoryNode, MemoryNodeStore, MemoryNodeType } from "../memory-node-store.js";
import {
  decideMemoryWrite,
  type MemoryCorrectionDecision,
  type MemoryWriteDecision
} from "../memory-write-decision.js";
import { buildSystemInstructions } from "./system-prompt.js";
import { augmentPromptWithNudges } from "./capability-nudge.js";
import { buildFeishuLocaleNudge, isFeishuLocalePrompt } from "./feishu-locale-nudge.js";
import { getBuiltinToolDefinitions, SubAgentRequest, SubAgentResult } from "../tools/registry.js";
import type { ToolPermissionRules } from "../tools/registry.js";
import { formatGoalContext, getGoal } from "../goal.js";
import { formatPlanContext, getLatestPlanReview } from "../plan-state.js";
import { checkPlanExecutionGuard } from "../plan-execution-guard.js";
import { findSkill, listSkills } from "../skills/loader.js";
import { formatSessionRecallContext, searchSessions } from "../session-search.js";
import { maybeProposePostTaskLearningDraft } from "../learning-draft.js";
import { correctMemory } from "../memory-correction.js";
import {
  filterMemoryHitsByRecallEvidence,
  type ModelRecallPlannerRoute,
  planRecall,
  planRecallWithModel,
  promptNamesSkillExactly,
  RecallDecision,
  scoreSkillForRecall,
  selectHotMemoryNodes
} from "./recall-policy.js";

export interface QueryEngineInput {
  store: SessionStore;
  sessionId: string;
  jobId?: string;
  cwd: string;
  routes: AgentRoute[];
  env?: NodeJS.ProcessEnv;
  stateRoot?: string;
  webSearchConfig?: WebSearchConfig;
  permissionMode?: ToolPermissionMode;
  interactionMode?: HeadlessInteractionMode;
  toolRules?: ToolPermissionRules;
  approvalResolver?: (request: {
    toolUse: import("../providers/ir.js").MagiToolUsePart;
    reason: string;
    diff?: string;
  }) => Promise<boolean> | boolean;
  userQuestionResolver?: UserQuestionResolver;
  userMessageSink?: UserMessageSink;
  spawnSubAgent?: (request: SubAgentRequest) => Promise<SubAgentResult>;
  activeInteractions?: ActiveInteractionRegistry;
  interactionTimeoutMs?: number;
  hooks?: HookDefinition[];
  mcp?: {
    servers: Record<string, McpServerConfig>;
  };
  collectEvents?: boolean;
  signal?: AbortSignal;
  onStreamEvent?: (event: AgentQueryEvent) => void;
  stream?: boolean;
  contextOptions?: {
    recentMessages?: number;
    autoCompactTokenThreshold?: number;
    autoCompactMessageThreshold?: number;
    compactionModel?: string;
    compactionRoute?: AgentRoute;
  };
  memoryOptions?: {
    paths?: import("../paths.js").MagiPaths;
    enabled?: boolean;
    autoWrite?: "off" | "explicit";
    maxResults?: number;
    scopes?: MemoryScope[];
    root?: string;
    selectionRoute?: import("../memory-selection.js").MemorySelectionRoute;
    recallPlannerRoute?: ModelRecallPlannerRoute;
    writeDecisionRoute?: import("../memory-write-decision.js").MemoryWriteDecisionRoute;
  };
}

export interface QueryEngineResult extends AgentQueryResult {
  jobId: string;
  events: AgentQueryEvent[];
}

type MemoryOptionsWithPaths = NonNullable<QueryEngineInput["memoryOptions"]> & {
  paths: import("../paths.js").MagiPaths;
};

export class QueryEngine {
  private readonly input: QueryEngineInput;
  private readonly toolUses = new Map<string, MagiToolUsePart>();
  private readonly memoryWriteJobs = new Set<string>();

  constructor(input: QueryEngineInput) {
    this.input = input;
  }

  async submitMessage(prompt: string): Promise<QueryEngineResult> {
    const jobId = this.input.jobId ?? randomUUID();
    const events: AgentQueryEvent[] = [];
    const currentUserMessageId = this.input.store.appendMessage({
      sessionId: this.input.sessionId,
      role: "user",
      content: prompt,
      metadata: { source: "query-engine" }
    });
    this.input.store.recordJob({
      id: jobId,
      sessionId: this.input.sessionId,
      kind: "agent.query",
      status: "running",
      metadata: {
        provider: this.input.routes[0]?.providerName,
        model: this.input.routes[0]?.model
      }
    });
    this.input.store.recordAudit({
      sessionId: this.input.sessionId,
      jobId,
      action: "agent.query.started",
      target: this.input.routes[0]?.providerName,
      metadata: { routeCount: this.input.routes.length }
    });
    this.input.activeInteractions?.registerJob({ sessionId: this.input.sessionId, jobId });
    const memoryWrite = await this.handleExplicitMemoryWrite(prompt, jobId);
    events.push(...memoryWrite);
    const promptHooks = await this.executeSessionHooks("user_prompt_submit", jobId, {
      source: "query",
      provider: this.input.routes[0]?.providerName,
      model: this.input.routes[0]?.model,
      prompt
    });
    events.push(...promptHooks);
    const startHooks = await this.executeSessionHooks("session_start", jobId, {
      source: "query",
      provider: this.input.routes[0]?.providerName,
      model: this.input.routes[0]?.model
    });
    events.push(...startHooks);
    const preparedContext = await this.prepareContext(
      prompt,
      jobId,
      currentUserMessageId,
      this.memoryWriteJobs.has(jobId)
    );
    events.push(...preparedContext.events);

    const iterator = runAgentQuery({
      routes: this.input.routes,
      messages: preparedContext.messages,
      cwd: this.input.cwd,
      env: this.input.env,
      stateRoot: this.input.stateRoot,
      memoryRoot: this.input.memoryOptions?.root,
      webSearchConfig: this.input.webSearchConfig,
      permissionMode: this.input.permissionMode,
      toolRules: this.input.toolRules,
      approvalResolver: (request) => this.resolveApproval(jobId, request),
      userQuestionResolver: (request) => this.resolveUserQuestion(jobId, request),
      userMessageSink: this.input.userMessageSink,
      spawnSubAgent: this.input.spawnSubAgent,
      hooks: this.input.hooks,
      sessionId: this.input.sessionId,
      signal: this.input.signal,
      mcp: this.input.mcp
        ? {
            servers: this.input.mcp.servers,
            tokenLookup: (serverName: string) =>
              this.input.store.getMcpOAuthToken(serverName)?.accessToken,
            tokenRefresh: async (serverName: string) => {
              try {
                const { refreshStoredToken } = await import("../mcp/oauth-flow.js");
                return await refreshStoredToken({ serverName, store: this.input.store });
              } catch {
                return undefined;
              }
            }
          }
        : undefined,
      onStreamEvent: this.input.onStreamEvent,
      toolExecutionGuard: ({ toolUse }) => this.applyPlanExecutionGuard(jobId, toolUse),
      stream: this.input.stream
    });

    let final: AgentQueryResult | undefined;
    try {
      let next = await iterator.next();
      while (!next.done) {
        events.push(next.value);
        events.push(...(await this.persistEvent(jobId, next.value)));
        next = await iterator.next();
      }
      final = next.value;
      this.input.store.appendMessage({
        sessionId: this.input.sessionId,
        role: "assistant",
        content: final.text,
        metadata: {
          provider: final.providerName,
          model: final.model,
          turns: final.turns,
          attempts: final.attempts
        }
      });
      this.input.store.updateJobStatus({
        id: jobId,
        status: "completed",
        metadata: {
          provider: final.providerName,
          model: final.model,
          turns: final.turns,
          attempts: final.attempts
        }
      });
      this.input.store.recordUsage({
        sessionId: this.input.sessionId,
        provider: final.providerName,
        model: final.model,
        inputTokens: final.usage.inputTokens,
        outputTokens: final.usage.outputTokens,
        costUsd: 0
      });
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: "agent.query.completed",
        target: final.providerName,
        metadata: { turns: final.turns, attempts: final.attempts }
      });
      const endHooks = await this.executeSessionHooks("session_end", jobId, {
        source: "query",
        provider: final.providerName,
        model: final.model,
        lastAssistantMessage: final.text
      });
      events.push(...endHooks);
      this.proposePostTaskLearningDraft(jobId, prompt, final.text, events);
      return { ...final, jobId, events };
    } catch (error) {
      const cancelled = isAbortError(error) || this.input.signal?.aborted === true;
      this.input.store.updateJobStatus({
        id: jobId,
        status: cancelled ? "cancelled" : "failed",
        metadata: { error: error instanceof Error ? error.message : String(error) }
      });
      if (!cancelled || !events.some((event) => event.type === "cancelled")) {
        this.input.store.recordAudit({
          sessionId: this.input.sessionId,
          jobId,
          action: cancelled ? "agent.query.cancelled" : "agent.query.failed",
          metadata: {
            error: error instanceof Error ? error.message : String(error),
            reason: this.input.signal?.reason ? String(this.input.signal.reason) : undefined
          }
        });
      }
      await this.executeSessionHooks("session_end", jobId, {
        source: "query",
        provider: this.input.routes[0]?.providerName,
        model: this.input.routes[0]?.model,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      this.input.activeInteractions?.unregisterJob(jobId);
    }
  }

  private async resolveApproval(
    jobId: string,
    request: { toolUse: MagiToolUsePart; reason: string; diff?: string }
  ): Promise<boolean> {
    if (
      this.input.activeInteractions &&
      shouldAutoResolveHeadlessInteractions({
        permissionMode: this.input.permissionMode,
        interactionMode: this.input.interactionMode
      })
    ) {
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: "agent.approval.auto_resolved",
        target: request.toolUse.name,
        metadata: {
          status: "resolved",
          interactionKind: "approval",
          toolUseId: request.toolUse.id,
          approved: true,
          auto: true,
          reason: request.reason
        }
      });
      return true;
    }

    if (!this.input.activeInteractions) {
      return this.input.approvalResolver?.(request) ?? false;
    }

    const wait = this.input.activeInteractions.waitForApproval({
      sessionId: this.input.sessionId,
      jobId,
      toolUse: request.toolUse,
      reason: request.reason,
      timeoutMs: this.input.interactionTimeoutMs
    });
    const cleanupAbort = this.cancelInteractionOnAbort({
      jobId,
      toolUseId: request.toolUse.id,
      reason: "request aborted"
    });
    const pending = this.input.activeInteractions.getInteraction({
      jobId,
      toolUseId: request.toolUse.id
    });
    this.input.store.recordAudit({
      sessionId: this.input.sessionId,
      jobId,
      action: "agent.approval.pending",
      target: request.toolUse.name,
      metadata: {
        status: "pending",
        interactionKind: "approval",
        toolUseId: request.toolUse.id,
        toolUse: request.toolUse,
        reason: request.reason,
        diff: request.diff,
        cwd: this.input.cwd,
        timeoutAt: pending?.timeoutAt
      }
    });

    try {
      const approved = await wait;
      const resolved = this.input.activeInteractions.getInteraction({
        jobId,
        toolUseId: request.toolUse.id
      });
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: "agent.approval.resolved",
        target: request.toolUse.name,
        metadata: {
          status: "resolved",
          interactionKind: "approval",
          toolUseId: request.toolUse.id,
          approved,
          resolvedAt: resolved?.updatedAt
        }
      });
      return approved;
    } catch (error) {
      const status = interactionErrorStatus(error);
      if (status) {
        const current = this.input.activeInteractions.getInteraction({
          jobId,
          toolUseId: request.toolUse.id
        });
        this.input.store.recordAudit({
          sessionId: this.input.sessionId,
          jobId,
          action: status === "timeout" ? "agent.approval.timeout" : "agent.approval.cancelled",
          target: request.toolUse.name,
          metadata: {
            status,
            interactionKind: "approval",
            toolUseId: request.toolUse.id,
            reason: current?.cancelReason ?? request.reason,
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }
      throw error;
    } finally {
      cleanupAbort();
    }
  }

  private async resolveUserQuestion(
    jobId: string,
    request: Parameters<UserQuestionResolver>[0]
  ): Promise<AskUserQuestionAnswer> {
    if (!this.input.activeInteractions) {
      if (!this.input.userQuestionResolver) {
        throw new Error("AskUserQuestion requires an interactive user question resolver");
      }
      return await this.input.userQuestionResolver(request);
    }

    if (
      shouldAutoResolveHeadlessInteractions({
        permissionMode: this.input.permissionMode,
        interactionMode: this.input.interactionMode
      })
    ) {
      const answer = buildHeadlessAutoAskUserQuestionAnswer(request.question);
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: "agent.user_question.auto_resolved",
        target: request.toolUse.name,
        metadata: {
          status: "resolved",
          interactionKind: "question",
          toolUseId: request.toolUse.id,
          questionCount: request.question.questions.length,
          answer,
          auto: true
        }
      });
      return answer;
    }

    const wait = this.input.activeInteractions.waitForQuestion({
      sessionId: this.input.sessionId,
      jobId,
      toolUse: request.toolUse,
      question: request.question,
      timeoutMs: this.input.interactionTimeoutMs
    });
    const cleanupAbort = this.cancelInteractionOnAbort({
      jobId,
      toolUseId: request.toolUse.id,
      reason: "request aborted"
    });
    const pending = this.input.activeInteractions.getInteraction({
      jobId,
      toolUseId: request.toolUse.id
    });
    this.input.store.recordAudit({
      sessionId: this.input.sessionId,
      jobId,
      action: "agent.user_question.pending",
      target: request.toolUse.name,
      metadata: {
        status: "pending",
        interactionKind: "question",
        toolUseId: request.toolUse.id,
        toolUse: request.toolUse,
        questionCount: request.question.questions.length,
        question: request.question,
        timeoutAt: pending?.timeoutAt
      }
    });

    try {
      const answer = await wait;
      const resolved = this.input.activeInteractions.getInteraction({
        jobId,
        toolUseId: request.toolUse.id
      });
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: "agent.user_question.resolved",
        target: request.toolUse.name,
        metadata: {
          status: "resolved",
          interactionKind: "question",
          toolUseId: request.toolUse.id,
          questionCount: request.question.questions.length,
          answer,
          resolvedAt: resolved?.updatedAt
        }
      });
      return answer;
    } catch (error) {
      const status = interactionErrorStatus(error);
      if (status) {
        const current = this.input.activeInteractions.getInteraction({
          jobId,
          toolUseId: request.toolUse.id
        });
        this.input.store.recordAudit({
          sessionId: this.input.sessionId,
          jobId,
          action:
            status === "timeout" ? "agent.user_question.timeout" : "agent.user_question.cancelled",
          target: request.toolUse.name,
          metadata: {
            status,
            interactionKind: "question",
            toolUseId: request.toolUse.id,
            questionCount: request.question.questions.length,
            reason: current?.cancelReason,
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }
      throw error;
    } finally {
      cleanupAbort();
    }
  }

  private cancelInteractionOnAbort(input: {
    jobId: string;
    toolUseId: string;
    reason: string;
  }): () => void {
    const signal = this.input.signal;
    if (!signal) {
      return () => undefined;
    }
    const cancel = () => {
      try {
        this.input.activeInteractions?.cancelInteraction(input);
      } catch {
        // The interaction may have already resolved or timed out.
      }
    };
    if (signal.aborted) {
      cancel();
      return () => undefined;
    }
    signal.addEventListener("abort", cancel, { once: true });
    return () => signal.removeEventListener("abort", cancel);
  }

  private async executeSessionHooks(
    event: HookEvent,
    jobId: string,
    context: {
      source: "query";
      provider?: string;
      model?: string;
      prompt?: string;
      message?: string;
      title?: string;
      notificationType?: string;
      lastAssistantMessage?: string;
      error?: string;
    },
    extraContext?: Partial<import("../hooks/runner.js").HookContext>
  ): Promise<AgentQueryEvent[]> {
    const results = await executeHooks({
      event,
      hooks: this.input.hooks ?? [],
      env: this.input.env,
      context: {
        sessionId: this.input.sessionId,
        jobId,
        cwd: this.input.cwd,
        permissionMode: this.input.permissionMode,
        ...context,
        ...extraContext
      },
      promptModel: async ({ model, messages }) => {
        const route = this.input.routes[0];
        const response = await route.adapter.complete({ model, messages });
        return { text: response.text };
      }
    });
    const events = results.map(
      (result): AgentQueryEvent => ({
        type: "hook_result",
        event,
        result
      })
    );
    for (const hookEvent of events) {
      await this.persistEvent(jobId, hookEvent);
    }
    return events;
  }

  private async prepareContext(
    prompt: string,
    jobId: string,
    currentUserMessageId: number,
    skipPreTaskRecall = false
  ): Promise<{ messages: MagiMessage[]; events: AgentQueryEvent[] }> {
    const events: AgentQueryEvent[] = [];
    const session = this.input.store.getSession(this.input.sessionId);
    if (!session) {
      return { messages: [textMessage("user", prompt)], events };
    }

    const summaries = this.input.store.listContextSummaries(session.id);
    const budget = computeSessionContextBudget({ session, summaries });
    const tokenThreshold = this.input.contextOptions?.autoCompactTokenThreshold;
    const messageThreshold = this.input.contextOptions?.autoCompactMessageThreshold;
    // Count messages NOT yet covered by an existing summary so we don't
    // re-trigger compaction immediately after a recent compact.
    const lastSummary = summaries[summaries.length - 1];
    const messagesSinceCompact = lastSummary
      ? Math.max(0, session.messages.length - lastSummary.sourceMessageCount)
      : session.messages.length;
    const tokenTriggered = tokenThreshold !== undefined && budget.estimatedTokens > tokenThreshold;
    const messageTriggered =
      messageThreshold !== undefined && messagesSinceCompact > messageThreshold;
    if (tokenTriggered || messageTriggered) {
      const route = this.input.contextOptions?.compactionRoute ?? this.input.routes[0];
      const compactModel =
        this.input.contextOptions?.compactionRoute?.model ??
        this.input.contextOptions?.compactionModel;
      const compacted = await compactSessionWithHooks({
        store: this.input.store,
        sessionId: session.id,
        hooks: this.input.hooks ?? [],
        cwd: this.input.cwd,
        env: this.input.env,
        trigger: "auto",
        modelRunner: compactModel
          ? {
              adapter: route.adapter,
              providerName: route.providerName,
              model: compactModel
            }
          : undefined
      });
      const compactEvent: AgentQueryEvent = {
        type: "compact_boundary",
        summaryId: compacted.summary.id,
        sourceMessageCount: compacted.summary.sourceMessageCount,
        estimatedTokensBefore: budget.estimatedTokens
      };
      events.push(compactEvent);
      await this.persistEvent(jobId, compactEvent);
    }

    const recallDecision = await this.planPreTaskRecall(prompt, skipPreTaskRecall);
    this.recordRecallDecision(jobId, recallDecision);

    const hotMemoryNodes: MemoryNode[] = [];
    const skippedHotMemory: Array<{
      nodeId: string;
      title: string;
      type: MemoryNode["type"];
      reason: string;
    }> = [];
    const messages = buildSessionMessages({
      store: this.input.store,
      sessionId: session.id,
      prompt,
      currentUserMessageId,
      recentMessages: this.input.contextOptions?.recentMessages ?? 20,
      memoryContext: await this.buildMemoryContext(prompt, jobId, recallDecision),
      goalContext: this.input.memoryOptions?.paths
        ? formatGoalContext(getGoal(this.input.memoryOptions.paths, session.id))
        : undefined,
      planContext: this.input.memoryOptions?.paths
        ? formatPlanContext(
            getLatestPlanReview(this.input.memoryOptions.paths.stateRoot, session.id)
          )
        : undefined,
      cwd: this.input.cwd,
      paths: this.input.memoryOptions?.paths,
      hotMemoryLimit: recallDecision.budgets.hotMemory,
      hotMemoryNodeSink: (nodes) => hotMemoryNodes.push(...nodes),
      hotMemoryFilter: (nodes) => {
        const selected = selectHotMemoryNodes({
          nodes,
          prompt,
          cwd: this.input.cwd,
          budget: recallDecision.budgets.hotMemory
        });
        skippedHotMemory.push(...selected.skipped);
        return selected.nodes;
      }
    });
    this.recordHotMemoryInjection(jobId, hotMemoryNodes, skippedHotMemory, recallDecision);

    return { messages, events };
  }

  private async planPreTaskRecall(
    prompt: string,
    skipPreTaskRecall: boolean
  ): Promise<RecallDecision> {
    const memory = this.input.memoryOptions;
    const skills = memory?.paths ? listSkills(memory.paths) : [];
    const hasMemory = Boolean(memory?.paths && memory.enabled !== false);
    const hasSkills = skills.length > 0;

    if (skipPreTaskRecall) {
      const decision = planRecall({
        prompt,
        cwd: this.input.cwd,
        hasMemory: false,
        hasSkills: false
      });
      const skippedReason = "explicit memory write or correction already handled before recall";
      return {
        ...decision,
        constraints: [skippedReason],
        skipped: {
          hotMemory: [skippedReason],
          memorySearch: [skippedReason],
          session: [skippedReason],
          skill: [skippedReason]
        }
      };
    }

    const plannerRoute = memory?.recallPlannerRoute;
    const hasInventory = plannerRoute
      ? hasSkills || (hasMemory && memory?.paths ? hasStoredRecallInventory(memory.paths) : false)
      : false;
    return planRecallWithModel({
      prompt,
      cwd: this.input.cwd,
      hasMemory,
      hasSkills,
      skills,
      route: hasInventory ? plannerRoute : undefined,
      signal: this.input.signal
    });
  }

  private async handleExplicitMemoryWrite(
    prompt: string,
    jobId: string
  ): Promise<AgentQueryEvent[]> {
    const memory = this.input.memoryOptions;
    if (!memory?.paths || memory.enabled === false || memory.autoWrite === "off") {
      return [];
    }
    const memoryWithPaths: MemoryOptionsWithPaths = { ...memory, paths: memory.paths };
    const write = await decideMemoryWrite({
      prompt,
      route: memoryWithPaths.writeDecisionRoute,
      signal: this.input.signal
    });
    if (!write) {
      return [];
    }
    if (write.action === "correct") {
      this.applyExplicitMemoryCorrection(write, jobId, memoryWithPaths);
      return [];
    }
    this.writeExplicitMemoryNode(write, jobId, memoryWithPaths);
    return [];
  }

  private writeExplicitMemoryNode(
    write: MemoryWriteDecision,
    jobId: string,
    memory: MemoryOptionsWithPaths
  ): void {
    this.memoryWriteJobs.add(jobId);
    const nodeStore = MemoryNodeStore.open(memory.paths);
    let node: MemoryNode;
    try {
      node = nodeStore.upsertNode({
        type: write.type,
        title: explicitMemoryTitle(write.type, write.content),
        summary: write.content,
        body: write.content,
        weight: write.scope === "session" ? 0.55 : 0.95,
        source: "explicit",
        sourceSessionId: this.input.sessionId,
        metadata: {
          scope: write.scope,
          classifiedType: write.type,
          decisionMethod: write.method,
          confidence: write.confidence,
          providerName: write.providerName,
          model: write.model
        }
      });
    } finally {
      nodeStore.close();
    }
    if (write.scope === "session") {
      appendMemory({
        paths: memory.paths,
        scope: "session",
        cwd: this.input.cwd,
        sessionId: this.input.sessionId,
        text: write.content
      });
    }
    this.input.store.recordAudit({
      sessionId: this.input.sessionId,
      jobId,
      action: "agent.memory.written",
      target: node.id,
      metadata: {
        scope: write.scope,
        nodeId: node.id,
        type: node.type,
        weight: node.weight,
        source: "explicit",
        decisionMethod: write.method,
        confidence: write.confidence,
        providerName: write.providerName,
        model: write.model
      }
    });
    if (write.usage) {
      this.input.store.recordUsage({
        sessionId: this.input.sessionId,
        provider: write.providerName ?? "memory-decision",
        model: write.model ?? "memory-decision",
        inputTokens: write.usage.inputTokens,
        outputTokens: write.usage.outputTokens,
        costUsd: 0,
        metadata: { purpose: "memory-write-decision" }
      });
    }
  }

  private applyExplicitMemoryCorrection(
    correction: MemoryCorrectionDecision,
    jobId: string,
    memory: MemoryOptionsWithPaths
  ): void {
    this.memoryWriteJobs.add(jobId);
    const result = correctMemory({
      appRoot: memory.paths.root,
      root: memory.root,
      paths: memory.paths,
      sessionId: this.input.sessionId,
      target: correction.target,
      reason: correction.reason,
      replacement: correction.replacement,
      replacementTitle: correction.replacementTitle,
      replacementSummary: correction.replacementSummary,
      replacementType: correction.replacementType,
      metadata: {
        decisionMethod: correction.method,
        confidence: correction.confidence,
        providerName: correction.providerName,
        model: correction.model
      }
    });
    this.input.store.recordAudit({
      sessionId: this.input.sessionId,
      jobId,
      action: "agent.memory.corrected",
      target: result.disputed.id,
      metadata: {
        target: correction.target,
        reason: correction.reason,
        disputedNodeId: result.disputed.id,
        replacementNodeId: result.replacement?.id,
        edgeCount: result.edgeCount,
        decisionMethod: correction.method,
        confidence: correction.confidence,
        providerName: correction.providerName,
        model: correction.model
      }
    });
    if (correction.usage) {
      this.input.store.recordUsage({
        sessionId: this.input.sessionId,
        provider: correction.providerName ?? "memory-decision",
        model: correction.model ?? "memory-decision",
        inputTokens: correction.usage.inputTokens,
        outputTokens: correction.usage.outputTokens,
        costUsd: 0,
        metadata: { purpose: "memory-correction-decision" }
      });
    }
  }

  private recordRecallDecision(jobId: string, decision: RecallDecision): void {
    this.input.store.recordAudit({
      sessionId: this.input.sessionId,
      jobId,
      action: "agent.recall.decision",
      target: this.input.sessionId,
      metadata: {
        taskKind: decision.taskKind,
        budgets: decision.budgets,
        reasons: decision.reasons,
        skipped: decision.skipped,
        matchedTerms: decision.matchedTerms,
        method: decision.method,
        constraints: decision.constraints,
        selectedSkills: decision.selectedSkills,
        planner: decision.planner
          ? {
              providerName: decision.planner.providerName,
              model: decision.planner.model
            }
          : undefined,
        fallbackReason: decision.fallbackReason
      }
    });
  }

  private recordHotMemoryInjection(
    jobId: string,
    nodes: MemoryNode[],
    skipped: Array<{ nodeId: string; title: string; type: MemoryNode["type"]; reason: string }>,
    decision: RecallDecision
  ): void {
    if (nodes.length === 0 && decision.budgets.hotMemory <= 0) {
      return;
    }
    this.input.store.recordAudit({
      sessionId: this.input.sessionId,
      jobId,
      action: "agent.memory.hot.injected",
      target: this.input.sessionId,
      metadata: {
        resultCount: nodes.length,
        decision: nodes.length > 0 ? "injected" : "skipped",
        budget: decision.budgets.hotMemory,
        reasons: decision.reasons.hotMemory,
        skippedReasons: decision.skipped.hotMemory,
        skippedNodes: skipped.slice(0, 10),
        nodeIds: nodes.map((node) => node.id),
        types: nodes.map((node) => node.type),
        titles: nodes.map((node) => node.title),
        weights: nodes.map((node) => node.weight)
      }
    });
  }

  private async buildMemoryContext(
    prompt: string,
    jobId: string,
    recallDecision: RecallDecision
  ): Promise<string | undefined> {
    const memory = this.input.memoryOptions;
    if (!memory?.paths) {
      return undefined;
    }
    const sections: string[] = [];

    if (memory.enabled !== false && recallDecision.budgets.memorySearch > 0) {
      const rawMemoryHits = retrieveRelevantMemory({
        appRoot: memory.paths.root,
        root: memory.root,
        query: prompt,
        maxResults: Math.max(memory.maxResults ?? 5, recallDecision.budgets.memorySearch),
        legacy: {
          paths: memory.paths,
          cwd: this.input.cwd,
          sessionId: this.input.sessionId,
          scopes: memory.scopes
        },
        sessionId: this.input.sessionId
      });
      const memoryHits = filterMemoryHitsByRecallEvidence(
        rawMemoryHits,
        prompt,
        this.input.cwd
      ).slice(0, recallDecision.budgets.memorySearch);
      const formalMemoryContext = formatMemoryContext(memoryHits);
      if (formalMemoryContext) {
        sections.push(formalMemoryContext);
      }
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: "agent.memory.retrieved",
        target: this.input.sessionId,
        metadata: {
          resultCount: memoryHits.length,
          rawResultCount: rawMemoryHits.length,
          decision: memoryHits.length > 0 ? "injected" : "skipped",
          budget: recallDecision.budgets.memorySearch,
          reasons: recallDecision.reasons.memorySearch,
          skippedReasons: recallDecision.skipped.memorySearch,
          matchedTerms: recallDecision.matchedTerms.memorySearch,
          method: "wiki-search",
          sources: Array.from(new Set(memoryHits.map((hit) => hit.source))),
          sourceKinds: Array.from(new Set(memoryHits.map((hit) => hit.sourceKind).filter(Boolean))),
          graphResultCount: memoryHits.filter((hit) => hit.source === "graph").length,
          nodeIds: memoryHits.map((hit) => hit.nodeId).filter(Boolean),
          chunkIds: memoryHits.map((hit) => hit.chunkId).filter(Boolean),
          files: memoryHits.map((hit) => hit.file)
        }
      });
    } else if (memory.enabled !== false) {
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: "agent.memory.retrieved",
        target: this.input.sessionId,
        metadata: {
          resultCount: 0,
          rawResultCount: 0,
          decision: "skipped",
          budget: recallDecision.budgets.memorySearch,
          reasons: recallDecision.reasons.memorySearch,
          skippedReasons: recallDecision.skipped.memorySearch,
          matchedTerms: recallDecision.matchedTerms.memorySearch,
          method: "wiki-search",
          sources: [],
          sourceKinds: [],
          graphResultCount: 0,
          nodeIds: [],
          chunkIds: [],
          files: []
        }
      });
    }

    const skillIndex = this.buildSkillIndexContext();
    if (skillIndex) {
      sections.push(skillIndex);
    }

    const skillContext = this.buildSkillRecallContext(prompt, jobId, recallDecision);
    if (skillContext) {
      sections.push(skillContext);
    }

    let sessionHits: ReturnType<typeof searchSessions> = [];
    if (recallDecision.budgets.session > 0) {
      sessionHits = searchSessions(this.input.store, {
        query: prompt,
        limit: recallDecision.budgets.session,
        window: 2,
        currentSessionId: this.input.sessionId
      });
      const sessionContext = formatSessionRecallContext(sessionHits);
      if (sessionContext) {
        sections.push(sessionContext);
      }
    }
    this.input.store.recordAudit({
      sessionId: this.input.sessionId,
      jobId,
      action: "agent.session.recalled",
      target: this.input.sessionId,
      metadata: {
        query: prompt.slice(0, 500),
        resultCount: sessionHits.length,
        decision: sessionHits.length > 0 ? "injected" : "skipped",
        budget: recallDecision.budgets.session,
        reasons: recallDecision.reasons.session,
        skippedReasons: recallDecision.skipped.session,
        matchedTerms: recallDecision.matchedTerms.session,
        sessions: sessionHits.map((hit) => hit.session.id)
      }
    });
    if (sections.length === 0) return undefined;
    return sections.join("\n\n");
  }

  /**
   * A lightweight, always-present index of every installed skill (name + one-line
   * description). Keyword recall is fragile — it silently drops skills whose
   * trigger words the user didn't happen to type. The index instead keeps every
   * skill visible to the main model, which is far better at judging intent than a
   * keyword matcher. The model loads a skill's full procedure on demand via the
   * Skill tool. buildSkillRecallContext still injects full bodies for strong/named
   * matches as an optimization, but the index guarantees nothing is invisible.
   */
  private buildSkillIndexContext(): string | undefined {
    const paths = this.input.memoryOptions?.paths;
    if (!paths) return undefined;
    const skills = listSkills(paths);
    if (skills.length === 0) return undefined;
    const lines = [
      "[Available Skills]",
      "Reusable procedures you can run. When the user's request matches one, load its full steps with the Skill tool (Skill({skill:\"<name>\"})) and follow them. If several fit, pick the single best match; if none fit, ignore this list. Don't mention skills the user didn't ask about.",
      ""
    ];
    for (const skill of skills) {
      lines.push(`- ${skill.name}: ${skill.summary.slice(0, 300)}`);
    }
    return lines.join("\n").trim();
  }

  private buildSkillRecallContext(
    prompt: string,
    jobId: string,
    recallDecision: RecallDecision
  ): string | undefined {
    const paths = this.input.memoryOptions?.paths;
    if (!paths) return undefined;

    // Score every installed skill against the prompt up front. scoreSkillForRecall
    // gives a skill +12 when the prompt names it directly (e.g. "verify ...",
    // "use the stuck skill"), which is a much stronger signal than the keyword
    // classifier that produces budgets.skill. Previously this scoring happened
    // *after* an early `budgets.skill <= 0` return, so a prompt that named a skill
    // but didn't trip the SKILL/CODING keyword lists (or got classified as
    // memory_dependent first) was dropped despite a perfect name match — the
    // "sometimes injected, sometimes not" flakiness. Compute hits first, then let
    // a strong name match guarantee budget instead of being gated out by it.
    const selectedNames = recallDecision.selectedSkills ?? [];
    const selectedHits = selectedNames
      .map((name, index) => {
        const skill = findSkill(paths, name);
        return skill
          ? {
              skill,
              score: 1000 - index,
              matchedTerms: ["model-selected"]
            }
          : undefined;
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const scoredHits = listSkills(paths)
      .map((skill) => {
        const full = findSkill(paths, skill.name) ?? skill;
        return scoreSkillForRecall(full, prompt);
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort(
        (left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name)
      );

    // Full-body injection is now reserved for HIGH-CONFIDENCE matches only:
    // a skill the model's recall planner explicitly selected, or one whose full
    // name the user typed as a standalone token ("verify ...", "用 stuck 帮我").
    // Everything else is already visible in the always-present [Available Skills]
    // index, which the model loads on demand — so we no longer dump full bodies
    // for weak keyword-budget matches (which also stops multiple same-purpose
    // skills from all being injected at once on a generic "用 skill 做PPT"). Exact
    // name matching avoids an incidental "route-clean.txt" forcing "route-clean-helper".
    const MAX_FULL_BODY_SKILLS = 3;
    const exactHits = scoredHits.filter((hit) => promptNamesSkillExactly(hit.skill.name, prompt));
    const hits = dedupeSkillHits([...selectedHits, ...exactHits]).slice(0, MAX_FULL_BODY_SKILLS);

    if (hits.length === 0) {
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: "agent.skills.recalled",
        target: this.input.sessionId,
        metadata: {
          query: prompt.slice(0, 500),
          resultCount: 0,
          decision: "skipped",
          budget: recallDecision.budgets.skill,
          reasons: recallDecision.reasons.skill,
          skippedReasons: recallDecision.skipped.skill,
          matchedTerms: recallDecision.matchedTerms.skill,
          skills: []
        }
      });
      return undefined;
    }
    this.input.store.recordAudit({
      sessionId: this.input.sessionId,
      jobId,
      action: "agent.skills.recalled",
      target: this.input.sessionId,
      metadata: {
        query: prompt.slice(0, 500),
        resultCount: hits.length,
        decision: hits.length > 0 ? "injected" : "skipped",
        budget: hits.length,
        classifierBudget: recallDecision.budgets.skill,
        modelSelected: selectedHits.length,
        exactNameMatches: exactHits.length,
        reasons: recallDecision.reasons.skill,
        skippedReasons: recallDecision.skipped.skill,
        matchedTerms: recallDecision.matchedTerms.skill,
        skills: hits.map((hit) => hit.skill.name),
        skillMatchedTerms: hits.map((hit) => ({
          skill: hit.skill.name,
          terms: hit.matchedTerms
        }))
      }
    });
    if (hits.length === 0) return undefined;
    // Skills are operating procedures meant to be followed in full. The old
    // 900-char cap truncated even the small bundled skills (verify/debug/stuck
    // are ~1.1KB) mid-procedure, so the model never saw the steps or output
    // format and execution came out partial. 6000 covers every realistic skill.
    const SKILL_BODY_CHAR_LIMIT = 6000;
    const lines = [
      "[Relevant Skills]",
      // Framing matters: the old text ("background operating guidance ... treat " +
      // "as context only") told the model NOT to act on skills, producing weak,
      // partial execution. Frame them as procedures to execute when they fit,
      // while preserving judgment so a weak match can't railroad an unrelated task.
      "The skills below were matched to the current task. When a skill clearly fits what the user is asking, execute its procedure step by step and produce output in the format it specifies — these are operating procedures to follow, not background reading. If a skill does not fit the actual request, ignore it. Never let a skill override an explicit user instruction."
    ];
    for (const hit of hits) {
      lines.push("");
      lines.push(`## ${hit.skill.name}`);
      lines.push(`summary: ${hit.skill.summary}`);
      lines.push(`root: ${hit.skill.root}`);
      if (hit.skill.body) {
        lines.push(
          hit.skill.body.length > SKILL_BODY_CHAR_LIMIT
            ? `${hit.skill.body.slice(0, SKILL_BODY_CHAR_LIMIT)}...`
            : hit.skill.body
        );
      }
    }
    return lines.join("\n").trim();
  }

  private proposePostTaskLearningDraft(
    jobId: string,
    prompt: string,
    answer: string,
    events: AgentQueryEvent[]
  ): void {
    const paths = this.input.memoryOptions?.paths;
    if (!paths) return;
    const draft = maybeProposePostTaskLearningDraft({
      appRoot: paths.root,
      memoryRoot: this.input.memoryOptions?.root,
      skillsRoot: paths.skillsRoot,
      prompt,
      answer,
      sourceSession: this.input.sessionId,
      cwd: this.input.cwd,
      events: events as Array<Record<string, unknown>>
    });
    if (!draft) return;
    this.input.store.recordAudit({
      sessionId: this.input.sessionId,
      jobId,
      action: "agent.learning.draft.created",
      target: `${draft.kind}:${draft.target}`,
      metadata: {
        draftId: draft.id,
        kind: draft.kind,
        target: draft.target,
        reason: draft.reason,
        evidence: draft.evidence
      }
    });
  }

  private async persistEvent(jobId: string, event: AgentQueryEvent): Promise<AgentQueryEvent[]> {
    if (event.type === "tool_use") {
      this.toolUses.set(event.toolUse.id, event.toolUse);
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: "agent.tool.use",
        target: event.toolUse.name,
        metadata: { id: event.toolUse.id, input: event.toolUse.input }
      });
      return [];
    }
    if (event.type === "request_start") {
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: "agent.request.started",
        target: this.input.routes[0]?.providerName,
        metadata: {
          provider: this.input.routes[0]?.providerName,
          model: this.input.routes[0]?.model
        }
      });
      return [];
    }
    if (event.type === "tool_context") {
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: "agent.tool_context.reported",
        target: "tools",
        metadata: event
      });
      return [];
    }
    if (event.type === "text_delta") {
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: "agent.text.delta",
        target: this.input.routes[0]?.providerName,
        metadata: {
          length: event.text.length,
          text: event.text,
          preview: event.text.slice(0, 240)
        }
      });
      return [];
    }
    if (event.type === "assistant_message") {
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: "agent.assistant.message",
        target: this.input.routes[0]?.providerName,
        metadata: {
          text: messageText(event.message),
          partCount: event.message.content.length,
          textLength: event.message.content
            .filter((part) => part.type === "text")
            .reduce((sum, part) => sum + part.text.length, 0),
          toolUseCount: event.message.content.filter((part) => part.type === "tool-use").length
        }
      });
      return [];
    }
    if (event.type === "tool_result") {
      this.input.store.appendMessage({
        sessionId: this.input.sessionId,
        role: "tool",
        content: event.content,
        metadata: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          retryable: event.retryable
        }
      });
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: event.isError ? "agent.tool.failed" : "agent.tool.completed",
        target: event.toolName,
        metadata: {
          toolCallId: event.toolCallId,
          ...(event.isError ? { reason: event.content } : {})
        }
      });
      const toolUse = this.toolUses.get(event.toolCallId);
      const extraEvents: AgentQueryEvent[] = [];
      if (event.isError && event.content.startsWith("Permission ")) {
        this.input.store.recordAudit({
          sessionId: this.input.sessionId,
          jobId,
          action: "agent.permission.denied",
          target: event.toolName,
          metadata: { toolCallId: event.toolCallId, reason: event.content }
        });
        extraEvents.push(
          ...(await this.executeSessionHooks(
            "permission_denied",
            jobId,
            {
              source: "query",
              provider: this.input.routes[0]?.providerName,
              model: this.input.routes[0]?.model,
              error: event.content
            },
            {
              toolName: event.toolName,
              toolInput: toolUse?.input,
              toolUseId: event.toolCallId,
              reason: event.content
            }
          ))
        );
      }
      if (event.toolName === "TodoWrite" && !event.isError) {
        this.input.store.recordAudit({
          sessionId: this.input.sessionId,
          jobId,
          action: "agent.todo.updated",
          target: this.input.sessionId,
          metadata: buildTodoAuditMetadata(event.toolCallId, toolUse)
        });
      }
      if (event.toolName === "Config" && !event.isError) {
        if (toolUse?.input.value !== undefined) {
          this.input.store.recordAudit({
            sessionId: this.input.sessionId,
            jobId,
            action: "agent.config.updated",
            target: typeof toolUse.input.setting === "string" ? toolUse.input.setting : "unknown",
            metadata: {
              toolCallId: event.toolCallId,
              valueType: typeof toolUse.input.value
            }
          });
          extraEvents.push(
            ...(await this.executeSessionHooks(
              "config_change",
              jobId,
              {
                source: "query",
                provider: this.input.routes[0]?.providerName,
                model: this.input.routes[0]?.model
              },
              {
                toolName: event.toolName,
                toolInput: toolUse.input,
                toolUseId: event.toolCallId,
                filePath: this.input.stateRoot
                  ? `${this.input.stateRoot}/../config.yaml`
                  : undefined
              }
            ))
          );
        }
      }
      if (event.toolName === "Skill" && !event.isError) {
        if (typeof toolUse?.input.skill === "string") {
          this.input.store.recordAudit({
            sessionId: this.input.sessionId,
            jobId,
            action: "agent.skill.loaded",
            target: toolUse.input.skill,
            metadata: {
              toolCallId: event.toolCallId,
              argsProvided: typeof toolUse.input.args === "string"
            }
          });
        }
      }
      return extraEvents;
    }
    if (event.type === "fallback_switched") {
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: "agent.provider.fallback",
        target: event.toProvider,
        metadata: event
      });
      return await this.executeSessionHooks("notification", jobId, {
        source: "query",
        provider: event.toProvider,
        model: event.toModel,
        message: `Provider fallback switched from ${event.fromProvider} to ${event.toProvider}`,
        title: "Provider fallback",
        notificationType: "provider_fallback"
      });
    }
    if (event.type === "provider_retry") {
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: "agent.provider.retry",
        target: event.providerName,
        metadata: event
      });
      return [];
    }
    if (event.type === "approval_request") {
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: "agent.approval.requested",
        target: event.toolUse.name,
        metadata: { toolUse: event.toolUse, reason: event.reason }
      });
      return await this.executeSessionHooks(
        "permission_request",
        jobId,
        {
          source: "query",
          provider: this.input.routes[0]?.providerName,
          model: this.input.routes[0]?.model
        },
        {
          toolName: event.toolUse.name,
          toolInput: event.toolUse.input,
          toolUseId: event.toolUse.id,
          reason: event.reason
        }
      );
    }
    if (event.type === "user_question") {
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: "agent.user_question.answered",
        target: event.toolUse.name,
        metadata: {
          toolUse: event.toolUse,
          questionCount: event.question.questions.length,
          answer: event.answer
        }
      });
      return [];
    }
    if (event.type === "user_message") {
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: "agent.user_message.sent",
        target: event.toolUse.name,
        metadata: {
          toolUse: event.toolUse,
          message: event.message,
          result: event.result
        }
      });
      return [];
    }
    if (event.type === "hook_result") {
      this.persistHookResult(jobId, event.event, event.result, {
        toolCallId: event.toolCallId,
        toolName: event.toolName
      });
      return [];
    }
    if (event.type === "compact_boundary") {
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: "agent.context.compacted",
        target: event.summaryId,
        metadata: event
      });
      return [];
    }
    if (event.type === "usage") {
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: "agent.usage.reported",
        target: this.input.routes[0]?.providerName,
        metadata: {
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens
        }
      });
      return [];
    }
    if (event.type === "max_turns_reached") {
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: "agent.query.max_turns",
        metadata: { maxTurnsReached: true }
      });
      return [];
    }
    if (event.type === "cancelled") {
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: "agent.query.cancelled",
        target: this.input.routes[0]?.providerName,
        metadata: { reason: event.reason }
      });
      return [];
    }
    if (event.type === "done") {
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: "agent.query.done",
        target: this.input.routes[0]?.providerName,
        metadata: {
          textLength: event.text.length,
          messageCount: event.messages.length
        }
      });
      return [];
    }
    if (event.type === "error") {
      this.input.store.recordAudit({
        sessionId: this.input.sessionId,
        jobId,
        action: "agent.query.error",
        metadata: event
      });
      return [];
    }
    return [];
  }

  private persistHookResult(
    jobId: string,
    event: string,
    result: HookResult,
    metadata?: { toolCallId?: string; toolName?: string }
  ): void {
    this.input.store.recordAudit({
      sessionId: this.input.sessionId,
      jobId,
      action: result.error ? "agent.hook.failed" : "agent.hook.completed",
      target: `${event}:${result.hook.type}`,
      metadata: {
        event,
        hookType: result.hook.type,
        condition: result.hook.if,
        toolCallId: metadata?.toolCallId,
        toolName: metadata?.toolName,
        exitCode: result.exitCode,
        blocked: result.blocked,
        timedOut: result.timedOut,
        output: result.output,
        error: result.error
      }
    });
  }

  private applyPlanExecutionGuard(
    jobId: string,
    toolUse: MagiToolUsePart
  ): AgentToolResult | undefined {
    const paths = this.input.memoryOptions?.paths;
    if (!paths) return undefined;
    const plan = getLatestPlanReview(paths.stateRoot, this.input.sessionId);
    if (!plan || plan.status !== "approved") return undefined;
    const violation = checkPlanExecutionGuard({
      plan,
      session: this.input.store.getSession(this.input.sessionId),
      toolUse
    });
    if (!violation) return undefined;
    this.input.store.recordAudit({
      sessionId: this.input.sessionId,
      jobId,
      action: "agent.plan.guard.blocked",
      target: toolUse.name,
      metadata: {
        planId: plan.id,
        requiredTool: violation.requiredTool,
        requiredPath: violation.requiredPath,
        attemptedTool: violation.attemptedTool,
        attemptedPath: violation.attemptedPath
      }
    });
    return {
      toolCallId: toolUse.id,
      toolName: toolUse.name,
      content: violation.message,
      isError: true
    };
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function buildTodoAuditMetadata(
  toolCallId: string,
  toolUse: MagiToolUsePart | undefined
): Record<string, unknown> {
  const todos = Array.isArray(toolUse?.input.todos) ? toolUse.input.todos : [];
  return {
    toolCallId,
    todoCount: todos.length,
    statusCounts: countTodoStatuses(todos),
    todos
  };
}

function countTodoStatuses(todos: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {
    pending: 0,
    in_progress: 0,
    completed: 0
  };
  for (const todo of todos) {
    if (typeof todo !== "object" || todo === null || Array.isArray(todo)) {
      continue;
    }
    const status = (todo as { status?: unknown }).status;
    if (status === "pending" || status === "in_progress" || status === "completed") {
      counts[status] += 1;
    }
  }
  return counts;
}

function hasStoredRecallInventory(paths: import("../paths.js").MagiPaths): boolean {
  if (hasNonEmptyFile(path.join(paths.root, "memory.md"))) {
    return true;
  }
  for (const dir of [
    path.join(paths.root, "memory"),
    path.join(paths.stateRoot, "project-memory"),
    path.join(paths.stateRoot, "session-memory")
  ]) {
    if (hasNonEmptyMarkdownUnder(dir, 4)) {
      return true;
    }
  }

  let nodeStore: MemoryNodeStore | undefined;
  try {
    nodeStore = MemoryNodeStore.open(paths);
    return nodeStore.listHotNodes({ limit: 1, minWeight: 0 }).length > 0;
  } catch {
    return false;
  } finally {
    nodeStore?.close();
  }
}

function hasNonEmptyFile(file: string): boolean {
  try {
    return statSync(file).isFile() && statSync(file).size > 0;
  } catch {
    return false;
  }
}

function hasNonEmptyMarkdownUnder(dir: string, depth: number): boolean {
  if (depth < 0 || !existsSync(dir)) {
    return false;
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(fullPath);
    } catch {
      continue;
    }
    if (stats.isFile() && stats.size > 0 && entry.endsWith(".md")) {
      return true;
    }
    if (stats.isDirectory() && hasNonEmptyMarkdownUnder(fullPath, depth - 1)) {
      return true;
    }
  }
  return false;
}

function dedupeSkillHits<T extends { skill: { name: string } }>(hits: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const hit of hits) {
    if (seen.has(hit.skill.name)) continue;
    seen.add(hit.skill.name);
    result.push(hit);
  }
  return result;
}

function explicitMemoryTitle(type: MemoryNodeType, text: string): string {
  return `${memoryNodeTypeLabel(type)}: ${text.trim().slice(0, 60)}`;
}

function memoryNodeTypeLabel(type: MemoryNodeType): string {
  switch (type) {
    case "user_profile":
      return "User profile";
    case "preference":
      return "Preference";
    case "work_habit":
      return "Work habit";
    case "workflow":
      return "Workflow";
    case "project":
      return "Project memory";
    case "decision":
      return "Decision";
    case "problem":
      return "Problem";
    case "reference":
      return "Reference";
    case "skill_ref":
      return "Skill reference";
    case "session":
      return "Session memory";
  }
}

function buildSessionMessages(input: {
  store: SessionStore;
  sessionId: string;
  prompt: string;
  currentUserMessageId: number;
  recentMessages: number;
  memoryContext?: string;
  goalContext?: string;
  planContext?: string;
  cwd?: string;
  paths?: import("../paths.js").MagiPaths;
  systemInstructions?: string;
  hotMemoryNodeSink?: (nodes: MemoryNode[]) => void;
  hotMemoryLimit?: number;
  hotMemoryFilter?: (nodes: MemoryNode[]) => MemoryNode[];
}): MagiMessage[] {
  const session = input.store.getSession(input.sessionId);
  if (!session) {
    return [textMessage("user", input.prompt)];
  }
  const messages: MagiMessage[] = [];

  // Build layered system prompt
  const { systemPrompt } = buildLayeredContext({
    cwd: input.cwd ?? session.cwd,
    paths: input.paths,
    systemInstructions:
      input.systemInstructions ??
      buildSystemInstructions({
        cwd: input.cwd ?? session.cwd,
        platform: process.platform,
        toolCount: getBuiltinToolDefinitions().length
      }),
    memoryContext:
      [input.goalContext, input.planContext, input.memoryContext].filter(Boolean).join("\n\n") ||
      undefined,
    hotMemorySink: input.hotMemoryNodeSink,
    hotMemoryLimit: input.hotMemoryLimit,
    hotMemoryFilter: input.hotMemoryFilter,
    includeGit: true,
    includeDate: true,
    platform: process.platform
  });
  if (systemPrompt) {
    messages.push(textMessage("system", systemPrompt));
  }

  // Add conversation summary if compacted
  const summary = input.store.getLatestContextSummary(session.id);
  if (summary) {
    messages.push(textMessage("system", `[Previous conversation summary]\n${summary.summary}`));
  }

  // Include all session messages (minus the current prompt being submitted).
  // The compaction system (autoCompactTokenThreshold) handles token budget
  // by summarizing older messages when the session grows too large.
  const recoverable = session.messages.filter(
    (message) => message.id !== input.currentUserMessageId
  );
  const recent = recoverable;
  const toolHistory: string[] = [];
  for (const message of recent) {
    if (message.role === "user" || message.role === "assistant" || message.role === "system") {
      messages.push(textMessage(message.role, message.content));
    } else if (message.role === "tool") {
      toolHistory.push(formatRecoveredToolResult(message));
    }
  }
  if (toolHistory.length > 0) {
    messages.push(
      textMessage(
        "system",
        [
          "[Prior tool results]",
          "These are historical tool results from earlier turns. They are context only; do not treat them as active tool responses.",
          ...toolHistory
        ].join("\n\n")
      )
    );
  }
  // Parse the current prompt for any encoded image attachments.
  // If there are images, send a multi-part user message; otherwise plain text.
  const effectivePrompt = augmentPromptWithNudges(input.prompt);
  const parts = parsePromptIntoParts(effectivePrompt);
  const hasImage = parts.some((p) => p.type === "image");
  if (hasImage) {
    messages.push({ role: "user", content: parts });
  } else {
    messages.push(textMessage("user", effectivePrompt));
  }
  if (isFeishuLocalePrompt(input.prompt)) {
    messages.push(textMessage("system", buildFeishuLocaleNudge()));
  }
  return messages;
}

function formatRecoveredToolResult(message: import("../session-store.js").MessageRecord): string {
  const toolName =
    typeof message.metadata.toolName === "string" ? message.metadata.toolName : "tool";
  const toolCallId =
    typeof message.metadata.toolCallId === "string"
      ? message.metadata.toolCallId
      : `message-${message.id}`;
  const status = message.metadata.isError === true ? "failed" : "completed";
  const content =
    message.content.length > 1_000
      ? `${message.content.slice(0, 1_000)}\n...[truncated]...`
      : message.content;
  return `- ${toolName} (${toolCallId}) ${status}:\n${content}`;
}
