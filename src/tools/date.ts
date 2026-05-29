export interface DateResult {
  iso: string;
  unix: number;
  utc: string;
  local: string;
  timezone: string;
  weekday: string;
}
export const DateInputSchema = {
  type: "object",
  properties: { format: { type: "string", enum: ["iso", "unix", "utc", "local", "all"] } },
  required: [],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseDateInput(input: Record<string, unknown>): { format: string } {
  return { format: typeof input.format === "string" ? input.format : "all" };
}

export function executeDate(): DateResult {
  const now = new Date();
  return {
    iso: now.toISOString(),
    unix: Math.floor(now.getTime() / 1000),
    utc: now.toUTCString(),
    local: now.toString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    weekday: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
      now.getDay()
    ]
  };
}

export function formatDateResult(result: DateResult): string {
  return [
    `ISO:     ${result.iso}`,
    `Unix:    ${result.unix}`,
    `UTC:     ${result.utc}`,
    `Local:   ${result.local}`,
    `TZ:      ${result.timezone}`,
    `Weekday: ${result.weekday}`
  ].join("\n");
}
