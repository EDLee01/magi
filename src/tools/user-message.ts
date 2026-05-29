import { MagiToolUsePart } from "../providers/ir.js";

export type UserMessageStatus = "normal" | "proactive";

export interface SendUserMessageRequest {
  message: string;
  attachments: string[];
  status: UserMessageStatus;
}

export interface SendUserMessageResult {
  delivered: boolean;
  channel: string;
  deliveredAt: string;
}

export type UserMessageSink = (request: {
  toolUse: MagiToolUsePart;
  message: SendUserMessageRequest;
}) => Promise<SendUserMessageResult> | SendUserMessageResult;

export const SEND_USER_MESSAGE_SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string" },
    attachments: {
      type: "array",
      items: { type: "string" }
    },
    status: {
      type: "string",
      enum: ["normal", "proactive"]
    }
  },
  required: ["message"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseSendUserMessageInput(input: Record<string, unknown>): SendUserMessageRequest {
  const message = readNonEmptyString(input.message, "message");
  const attachments =
    input.attachments === undefined ? [] : readStringArray(input.attachments, "attachments");
  const status = readStatus(input.status);
  return { message, attachments, status };
}

export function formatSendUserMessageResult(
  request: SendUserMessageRequest,
  result: SendUserMessageResult
): string {
  return [
    "User message delivered",
    `status: ${request.status}`,
    `channel: ${result.channel}`,
    `delivered: ${result.delivered ? "true" : "false"}`,
    `deliveredAt: ${result.deliveredAt}`,
    request.attachments.length > 0
      ? `attachments:\n${request.attachments.map((item) => `- ${item}`).join("\n")}`
      : undefined,
    "",
    request.message
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function defaultUserMessageSink(): SendUserMessageResult {
  return {
    delivered: true,
    channel: "agent-event",
    deliveredAt: new Date().toISOString()
  };
}

function readNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`SendUserMessage ${name} must be a non-empty string`);
  }
  return value;
}

function readStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`SendUserMessage ${name} must be an array`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`SendUserMessage ${name}[${index}] must be a non-empty string`);
    }
    return item;
  });
}

function readStatus(value: unknown): UserMessageStatus {
  if (value === undefined) {
    return "normal";
  }
  if (value === "normal" || value === "proactive") {
    return value;
  }
  throw new Error("SendUserMessage status must be normal or proactive");
}
