import { HookDefinition, HookEvent } from "../config.js";
import { AuditRecord, SessionStore } from "../session-store.js";
import { executeHooks, HookContext, HookResult } from "./runner.js";

export interface HookEventInput {
  event: HookEvent;
  hooks: HookDefinition[];
  store: SessionStore;
  sessionId: string;
  jobId?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  context?: Partial<HookContext>;
}

export async function triggerHooks(input: HookEventInput): Promise<HookResult[]> {
  const results = await executeHooks({
    event: input.event,
    hooks: input.hooks,
    env: input.env,
    context: {
      sessionId: input.sessionId,
      cwd: input.cwd,
      ...input.context
    }
  });
  for (const result of results) {
    recordHookAudit(input.store, {
      sessionId: input.sessionId,
      jobId: input.jobId,
      action: result.error ? "agent.hook.failed" : "agent.hook.completed",
      target: `${input.event}:${result.hook.type}`,
      metadata: {
        event: input.event,
        hookType: result.hook.type,
        condition: result.hook.if,
        exitCode: result.exitCode,
        blocked: result.blocked,
        timedOut: result.timedOut,
        status: result.status,
        output: result.output,
        error: result.error
      }
    });
  }
  return results;
}

function recordHookAudit(store: SessionStore, input: AuditRecord): void {
  store.recordAudit(input);
}
