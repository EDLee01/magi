import { MagiToolUsePart } from "../providers/ir.js";

export interface AskUserQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskUserQuestionItem {
  question: string;
  header?: string;
  preview?: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
}

export interface AskUserQuestionRequest {
  questions: AskUserQuestionItem[];
}

export interface AskUserQuestionSelection {
  question: string;
  selectedLabels: string[];
  selectedOptions: AskUserQuestionOption[];
}

export interface AskUserQuestionAnswer {
  answers: AskUserQuestionSelection[];
}

export type UserQuestionResolver = (request: {
  toolUse: MagiToolUsePart;
  question: AskUserQuestionRequest;
}) => Promise<AskUserQuestionAnswer> | AskUserQuestionAnswer;

export const ASK_USER_QUESTION_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          header: { type: "string" },
          question: { type: "string" },
          preview: { type: "string" },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                description: { type: "string" },
                preview: { type: "string" }
              },
              required: ["label", "description"],
              additionalProperties: false
            }
          },
          multiSelect: { type: "boolean" }
        },
        required: ["question", "options"],
        additionalProperties: false
      }
    }
  },
  required: ["questions"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseAskUserQuestionInput(input: Record<string, unknown>): AskUserQuestionRequest {
  const rawQuestions = input.questions;
  if (!Array.isArray(rawQuestions)) {
    throw new Error("AskUserQuestion input questions must be an array");
  }
  if (rawQuestions.length < 1 || rawQuestions.length > 4) {
    throw new Error("AskUserQuestion requires 1 to 4 questions");
  }

  const questions = rawQuestions.map((rawQuestion, questionIndex): AskUserQuestionItem => {
    if (!isRecord(rawQuestion)) {
      throw new Error(`AskUserQuestion question ${questionIndex + 1} must be an object`);
    }
    const question = readNonEmptyString(
      rawQuestion.question,
      `questions[${questionIndex}].question`
    );
    const header = readOptionalString(rawQuestion.header, `questions[${questionIndex}].header`);
    const preview = readOptionalString(rawQuestion.preview, `questions[${questionIndex}].preview`);
    const rawOptions = rawQuestion.options;
    if (!Array.isArray(rawOptions)) {
      throw new Error(`AskUserQuestion questions[${questionIndex}].options must be an array`);
    }
    if (rawOptions.length < 2 || rawOptions.length > 4) {
      throw new Error(
        `AskUserQuestion questions[${questionIndex}].options requires 2 to 4 options`
      );
    }
    const options = rawOptions.map((rawOption, optionIndex): AskUserQuestionOption => {
      if (!isRecord(rawOption)) {
        throw new Error(
          `AskUserQuestion questions[${questionIndex}].options[${optionIndex}] must be an object`
        );
      }
      return {
        label: readNonEmptyString(
          rawOption.label,
          `questions[${questionIndex}].options[${optionIndex}].label`
        ),
        description: readNonEmptyString(
          rawOption.description,
          `questions[${questionIndex}].options[${optionIndex}].description`
        ),
        preview: readOptionalString(
          rawOption.preview,
          `questions[${questionIndex}].options[${optionIndex}].preview`
        )
      };
    });
    const multiSelect = readOptionalBoolean(
      rawQuestion.multiSelect ?? rawQuestion.multi_select,
      `questions[${questionIndex}].multiSelect`
    );
    return {
      question,
      header,
      preview,
      options,
      multiSelect
    };
  });

  return { questions };
}

export function normalizeAskUserQuestionAnswer(
  request: AskUserQuestionRequest,
  answer: AskUserQuestionAnswer
): AskUserQuestionAnswer {
  if (!isRecord(answer) || !Array.isArray(answer.answers)) {
    throw new Error("AskUserQuestion resolver must return { answers: [...] }");
  }
  if (answer.answers.length !== request.questions.length) {
    throw new Error(
      `AskUserQuestion resolver returned ${answer.answers.length} answers for ${request.questions.length} questions`
    );
  }

  return {
    answers: answer.answers.map((selection, index): AskUserQuestionSelection => {
      if (!isRecord(selection)) {
        throw new Error(`AskUserQuestion answer ${index + 1} must be an object`);
      }
      const question = request.questions[index];
      const labels = Array.isArray(selection.selectedLabels)
        ? selection.selectedLabels.map((label, labelIndex) =>
            readNonEmptyString(label, `answers[${index}].selectedLabels[${labelIndex}]`)
          )
        : Array.isArray(selection.selectedOptions)
          ? selection.selectedOptions.map((option, optionIndex) => {
              if (!isRecord(option)) {
                throw new Error(
                  `AskUserQuestion answers[${index}].selectedOptions[${optionIndex}] must be an object`
                );
              }
              return readNonEmptyString(
                option.label,
                `answers[${index}].selectedOptions[${optionIndex}].label`
              );
            })
          : [];
      if (labels.length === 0) {
        throw new Error(`AskUserQuestion answer ${index + 1} must select at least one option`);
      }
      if (!question.multiSelect && labels.length !== 1) {
        throw new Error(`AskUserQuestion answer ${index + 1} must select exactly one option`);
      }
      const selectedOptions = labels.map((label) => {
        const option = question.options.find((candidate) => candidate.label === label);
        if (!option) {
          throw new Error(`AskUserQuestion answer ${index + 1} selected unknown option: ${label}`);
        }
        return option;
      });
      return {
        question: question.question,
        selectedLabels: labels,
        selectedOptions
      };
    })
  };
}

/** Pick default options for headless control jobs (Feishu/API) in bypassPermissions mode. */
export function buildHeadlessAutoAskUserQuestionAnswer(
  request: AskUserQuestionRequest
): AskUserQuestionAnswer {
  return normalizeAskUserQuestionAnswer(request, {
    answers: request.questions.map((question) => {
      const recommended = question.options.find((option) => /recommended/i.test(option.label));
      const nonOther = question.options.find((option) => !/^other$/i.test(option.label.trim()));
      const picked = recommended ?? nonOther ?? question.options[0];
      return {
        question: question.question,
        selectedLabels: [picked.label],
        selectedOptions: [picked]
      };
    })
  });
}

export function formatAskUserQuestionAnswer(answer: AskUserQuestionAnswer): string {
  const lines = ["User answered AskUserQuestion:"];
  answer.answers.forEach((selection, index) => {
    lines.push(`Question ${index + 1}: ${selection.question}`);
    for (const option of selection.selectedOptions) {
      lines.push(`- ${option.label}: ${option.description}`);
      if (option.preview) {
        lines.push(`  preview: ${option.preview}`);
      }
    }
  });
  lines.push(
    "",
    "JSON:",
    JSON.stringify(
      {
        answers: answer.answers.map((selection) => ({
          question: selection.question,
          selectedLabels: selection.selectedLabels,
          selectedOptions: selection.selectedOptions
        }))
      },
      null,
      2
    )
  );
  return lines.join("\n");
}

export function formatAskUserQuestionForTerminal(
  request: AskUserQuestionRequest,
  questionIndex: number
): string {
  const question = request.questions[questionIndex];
  if (!question) {
    throw new Error(`AskUserQuestion terminal question index out of range: ${questionIndex}`);
  }
  return [
    `Question ${questionIndex + 1}/${request.questions.length}`,
    question.header,
    question.preview,
    question.question,
    ...question.options.map((option, index) => {
      const description = option.description ? ` - ${option.description}` : "";
      const preview = option.preview ? `\n   ${option.preview}` : "";
      return `${index + 1}. ${option.label}${description}${preview}`;
    }),
    question.multiSelect ? "Choose one or more numbers separated by commas:" : "Choose one number:"
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function parseAskUserQuestionSelection(
  input: string,
  question: AskUserQuestionItem
): AskUserQuestionOption[] {
  const pieces = input
    .split(/[,\s]+/)
    .map((piece) => piece.trim())
    .filter(Boolean);
  if (pieces.length === 0) {
    throw new Error("Choose at least one option");
  }
  if (!question.multiSelect && pieces.length !== 1) {
    throw new Error("Choose exactly one option");
  }
  const selected = pieces.map((piece) => {
    const index = Number(piece);
    if (!Number.isInteger(index) || index < 1 || index > question.options.length) {
      throw new Error(`Option must be a number from 1 to ${question.options.length}`);
    }
    return question.options[index - 1];
  });
  const unique = new Map(selected.map((option) => [option.label, option]));
  if (!question.multiSelect && unique.size !== 1) {
    throw new Error("Choose exactly one option");
  }
  return [...unique.values()];
}

function readNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`AskUserQuestion ${name} must be a non-empty string`);
  }
  return value;
}

function readOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`AskUserQuestion ${name} must be a string`);
  }
  return value;
}

function readOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`AskUserQuestion ${name} must be a boolean`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function triggerElicitationHooks(input: {
  hooks?: import("../config.js").HookDefinition[];
  sessionId?: string;
  cwd?: string;
  question: AskUserQuestionRequest;
  answer?: AskUserQuestionAnswer;
}): Promise<void> {
  if (!input.hooks) return;

  const { triggerHook } = await import("../hooks/trigger.js");

  if (input.answer) {
    void triggerHook({
      event: "elicitation_result",
      hooks: input.hooks,
      context: {
        sessionId: input.sessionId,
        cwd: input.cwd ?? process.cwd(),
        elicitationId: `elicitation-${Date.now()}`,
        requestedSchema: input.question as unknown as Record<string, unknown>,
        content: input.answer
      }
    });
  } else {
    void triggerHook({
      event: "elicitation",
      hooks: input.hooks,
      context: {
        sessionId: input.sessionId,
        cwd: input.cwd ?? process.cwd(),
        elicitationId: `elicitation-${Date.now()}`,
        requestedSchema: input.question as unknown as Record<string, unknown>
      }
    });
  }
}
