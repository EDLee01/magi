import { randomUUID } from "node:crypto";

import {
  MagiMessage,
  MagiToolUsePart,
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
import { AskUserQuestionAnswer, UserQuestionResolver } from "../tools/user-question.js";
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
import { getBuiltinToolDefinitions, SubAgentRequest, SubAgentResult } from "../tools/registry.js";
import { formatGoalContext, getGoal } from "../goal.js";
import { formatPlanContext, getLatestPlanReview } from "../plan-state.js";
import { checkPlanExecutionGuard } from "../plan-execution-guard.js";
import { findSkill, listSkills, SkillRecord } from "../skills/loader.js";
import { formatSessionRecallContext, searchSessions } from "../session-search.js";
import { maybeProposePostTaskLearningDraft } from "../learning-draft.js";
import { correctMemory } from "../memory-correction.js";

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
    const preparedContext = await this.prepareContext(prompt, jobId, currentUserMessageId);
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
    currentUserMessageId: number
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

    const hotMemoryNodes: MemoryNode[] = [];
    const messages = buildSessionMessages({
      store: this.input.store,
      sessionId: session.id,
      prompt,
      currentUserMessageId,
      recentMessages: this.input.contextOptions?.recentMessages ?? 20,
      memoryContext: await this.buildMemoryContext(prompt, jobId),
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
      hotMemoryNodeSink: (nodes) => hotMemoryNodes.push(...nodes)
    });
    this.recordHotMemoryInjection(jobId, hotMemoryNodes);

    return { messages, events };
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

  private recordHotMemoryInjection(jobId: string, nodes: MemoryNode[]): void {
    if (nodes.length === 0) {
      return;
    }
    this.input.store.recordAudit({
      sessionId: this.input.sessionId,
      jobId,
      action: "agent.memory.hot.injected",
      target: this.input.sessionId,
      metadata: {
        resultCount: nodes.length,
        nodeIds: nodes.map((node) => node.id),
        types: nodes.map((node) => node.type),
        titles: nodes.map((node) => node.title),
        weights: nodes.map((node) => node.weight)
      }
    });
  }

  private async buildMemoryContext(prompt: string, jobId: string): Promise<string | undefined> {
    const memory = this.input.memoryOptions;
    if (!memory?.paths) {
      return undefined;
    }
    const sections: string[] = [];

    if (memory.enabled !== false) {
      const memoryHits = retrieveRelevantMemory({
        appRoot: memory.paths.root,
        root: memory.root,
        query: prompt,
        maxResults: memory.maxResults ?? 5,
        legacy: {
          paths: memory.paths,
          cwd: this.input.cwd,
          sessionId: this.input.sessionId,
          scopes: memory.scopes
        },
        sessionId: this.input.sessionId
      });
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
          method: "wiki-search",
          sources: Array.from(new Set(memoryHits.map((hit) => hit.source))),
          sourceKinds: Array.from(new Set(memoryHits.map((hit) => hit.sourceKind).filter(Boolean))),
          graphResultCount: memoryHits.filter((hit) => hit.source === "graph").length,
          nodeIds: memoryHits.map((hit) => hit.nodeId).filter(Boolean),
          chunkIds: memoryHits.map((hit) => hit.chunkId).filter(Boolean),
          files: memoryHits.map((hit) => hit.file)
        }
      });
    }

    const skillContext = this.buildSkillRecallContext(prompt, jobId);
    if (skillContext) {
      sections.push(skillContext);
    }

    const sessionHits = searchSessions(this.input.store, {
      query: prompt,
      limit: 3,
      window: 2,
      currentSessionId: this.input.sessionId
    });
    const sessionContext = formatSessionRecallContext(sessionHits);
    if (sessionContext) {
      sections.push(sessionContext);
    }
    this.input.store.recordAudit({
      sessionId: this.input.sessionId,
      jobId,
      action: "agent.session.recalled",
      target: this.input.sessionId,
      metadata: {
        query: prompt.slice(0, 500),
        resultCount: sessionHits.length,
        sessions: sessionHits.map((hit) => hit.session.id)
      }
    });
    if (sections.length === 0) return undefined;
    return sections.join("\n\n");
  }

  private buildSkillRecallContext(prompt: string, jobId: string): string | undefined {
    const paths = this.input.memoryOptions?.paths;
    if (!paths) return undefined;
    const terms = tokenizeRecall(prompt);
    if (terms.length === 0) return undefined;
    const hits = listSkills(paths)
      .map((skill) => {
        const full = findSkill(paths, skill.name) ?? skill;
        return { skill: full, score: scoreSkill(full, terms) };
      })
      .filter((item) => item.score > 0)
      .sort(
        (left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name)
      )
      .slice(0, 3);
    this.input.store.recordAudit({
      sessionId: this.input.sessionId,
      jobId,
      action: "agent.skills.recalled",
      target: this.input.sessionId,
      metadata: {
        query: prompt.slice(0, 500),
        resultCount: hits.length,
        skills: hits.map((hit) => hit.skill.name)
      }
    });
    if (hits.length === 0) return undefined;
    const lines = [
      "[Relevant Skills]",
      "These skill snippets are background operating guidance. Treat them as context only unless the user asks to invoke a skill."
    ];
    for (const hit of hits) {
      lines.push("");
      lines.push(`## ${hit.skill.name}`);
      lines.push(`summary: ${hit.skill.summary}`);
      lines.push(`root: ${hit.skill.root}`);
      if (hit.skill.body) {
        lines.push(
          hit.skill.body.length > 900 ? `${hit.skill.body.slice(0, 900)}...` : hit.skill.body
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
        metadata: { toolCallId: event.toolCallId }
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

function scoreSkill(skill: SkillRecord, terms: string[]): number {
  const text = `${skill.name}\n${skill.summary}\n${skill.body ?? ""}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (skill.name.toLowerCase().includes(term)) score += 8;
    if (skill.summary.toLowerCase().includes(term)) score += 5;
    if (text.includes(term)) score += 2;
  }
  return score;
}

function tokenizeRecall(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_-]+/gu, " ")
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 3 || (/[\u4e00-\u9fff]/.test(term) && term.length >= 2))
    )
  );
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
  const parts = parsePromptIntoParts(input.prompt);
  const hasImage = parts.some((p) => p.type === "image");
  if (hasImage) {
    messages.push({ role: "user", content: parts });
  } else {
    messages.push(textMessage("user", input.prompt));
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
