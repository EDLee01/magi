import { ToolError } from "./errors.js";

// --- Types ---

export interface BrowserNavigateInput {
  url: string;
}
export interface BrowserClickInput {
  selector?: string;
  x?: number;
  y?: number;
}
export interface BrowserTypeInput {
  selector: string;
  text: string;
}
export interface BrowserScrollInput {
  direction: "up" | "down" | "left" | "right";
  amount?: number;
}
export interface BrowserScreenshotInput {
  fullPage?: boolean;
}
export interface BrowserExtractTextInput {
  selector?: string;
}
export interface BrowserWaitInput {
  ms: number;
}
export interface BrowserEvaluateInput {
  script: string;
}

export type BrowserAction =
  | { action: "navigate"; url: string }
  | { action: "click"; selector?: string; x?: number; y?: number }
  | { action: "type"; selector: string; text: string }
  | { action: "scroll"; direction: "up" | "down" | "left" | "right"; amount?: number }
  | { action: "screenshot"; fullPage?: boolean }
  | { action: "extract_text"; selector?: string }
  | { action: "wait"; ms: number }
  | { action: "evaluate"; script: string }
  | { action: "close" };

// --- Singleton browser ---

interface PlaywrightModule {
  chromium: {
    launch(options: Record<string, unknown>): Promise<BrowserLike>;
  };
}

interface BrowserLike {
  isConnected(): boolean;
  close(): Promise<void>;
  newContext(options: Record<string, unknown>): Promise<BrowserContextLike>;
}

interface BrowserContextLike {
  newPage(): Promise<PageLike>;
}

interface PageLike {
  isClosed(): boolean;
  close(): Promise<void>;
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  title(): Promise<string>;
  url(): string;
  waitForSelector(
    selector: string,
    options?: Record<string, unknown>
  ): Promise<ElementHandleLike | null>;
  mouse: {
    click(x: number, y: number): Promise<void>;
    wheel(x: number, y: number): Promise<void>;
  };
  screenshot(options?: Record<string, unknown>): Promise<Buffer>;
  $(selector: string): Promise<ElementHandleLike | null>;
  innerText(selector: string): Promise<string>;
  evaluate(script: string): Promise<unknown>;
}

interface ElementHandleLike {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  type(value: string, options?: Record<string, unknown>): Promise<void>;
  innerText(): Promise<string>;
}

let browserInstance: BrowserLike | null = null;
let pageInstance: PageLike | null = null;
let playwrightModule: PlaywrightModule | undefined;

async function loadPlaywright(): Promise<PlaywrightModule> {
  if (playwrightModule) {
    return playwrightModule;
  }
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (
      specifier: string
    ) => Promise<unknown>;
    const loaded = await dynamicImport("playwright");
    if (!isPlaywrightModule(loaded)) {
      throw new Error("module did not export chromium.launch");
    }
    playwrightModule = loaded;
    return playwrightModule;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ToolError(
      `BrowserAction requires the optional dependency "playwright". Install it in this project to use browser automation. ${detail}`,
      "command-failed"
    );
  }
}

function isPlaywrightModule(value: unknown): value is PlaywrightModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "chromium" in value &&
    typeof (value as { chromium?: { launch?: unknown } }).chromium?.launch === "function"
  );
}

async function getBrowser(): Promise<BrowserLike> {
  if (!browserInstance || !browserInstance.isConnected()) {
    const { chromium } = await loadPlaywright();
    browserInstance = await chromium.launch({
      headless: false,
      args: ["--start-maximized", "--no-sandbox"]
    });
    process.on("exit", () => {
      browserInstance?.close().catch(() => {});
    });
  }
  return browserInstance;
}

async function getPage(): Promise<PageLike> {
  const browser = await getBrowser();
  if (!pageInstance || pageInstance.isClosed()) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: "zh-CN"
    });
    pageInstance = await context.newPage();
  }
  return pageInstance;
}

async function closeBrowser(): Promise<void> {
  if (pageInstance && !pageInstance.isClosed()) {
    await pageInstance.close();
    pageInstance = null;
  }
  if (browserInstance && browserInstance.isConnected()) {
    await browserInstance.close();
    browserInstance = null;
  }
}

// --- Input schemas (for the model to call) ---

export const BrowserNavigateInputSchema = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "Full URL to navigate to (including protocol, e.g. https://www.zhihu.com)"
    }
  },
  required: ["url"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export const BrowserActionInputSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [
        "navigate",
        "click",
        "type",
        "scroll",
        "screenshot",
        "extract_text",
        "wait",
        "evaluate",
        "close"
      ],
      description: "Browser action to perform"
    },
    url: { type: "string", description: "URL for the navigate action" },
    selector: { type: "string", description: "CSS selector (for click, type, extract_text)" },
    text: { type: "string", description: "Text to type (for the type action)" },
    direction: {
      type: "string",
      enum: ["up", "down", "left", "right"],
      description: "Scroll direction (for scroll action)"
    },
    amount: {
      type: "number",
      description: "Pixels to scroll (for scroll action, default: window height)"
    },
    x: { type: "number", description: "X coordinate to click (for click action without selector)" },
    y: { type: "number", description: "Y coordinate to click (for click action without selector)" },
    fullPage: {
      type: "boolean",
      description: "Capture full page (for screenshot action, default: false)"
    },
    ms: { type: "number", description: "Milliseconds to wait (for wait action)" },
    script: { type: "string", description: "JavaScript to execute (for evaluate action)" }
  },
  required: ["action"],
  additionalProperties: false
} satisfies Record<string, unknown>;

// --- Main tool executor ---

export async function executeBrowserAction(input: Record<string, unknown>): Promise<string> {
  const action = input.action as string | undefined;
  if (!action) throw new ToolError("Browser action is required", "bad-input");

  switch (action) {
    case "navigate":
      return navigate(typeof input.url === "string" ? input.url : "");
    case "click":
      return click(
        input.selector as string | undefined,
        input.x as number | undefined,
        input.y as number | undefined
      );
    case "type":
      return typeText(input.selector as string, input.text as string);
    case "scroll":
      return scroll(
        input.direction as "up" | "down" | "left" | "right",
        input.amount as number | undefined
      );
    case "screenshot":
      return screenshot(input.fullPage as boolean | undefined);
    case "extract_text":
      return extractText(input.selector as string | undefined);
    case "wait":
      return waitMs(input.ms as number | undefined);
    case "evaluate":
      return evaluate(input.script as string);
    case "close":
      return closeAction();
    default:
      throw new ToolError(`Unknown browser action: ${action}`, "bad-input");
  }
}

async function navigate(url: string): Promise<string> {
  if (!url) throw new ToolError("URL is required for navigate action", "bad-input");
  const page = await getPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    // Wait a bit for heavy pages (social media) to finish rendering
    await page.waitForTimeout(2000);
    const title = await page.title();
    return `Navigated to ${url}\nPage title: ${title}\nURL: ${page.url()}`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new ToolError(`Navigation failed: ${msg}`, "command-failed");
  }
}

async function click(selector?: string, x?: number, y?: number): Promise<string> {
  const page = await getPage();
  try {
    if (selector) {
      const el = await page.waitForSelector(selector, { timeout: 5_000 });
      if (!el) throw new ToolError(`Element not found: ${selector}`, "not-found");
      await el.click();
      await page.waitForTimeout(1000);
      return `Clicked element: ${selector}`;
    }
    if (x !== undefined && y !== undefined) {
      await page.mouse.click(x, y);
      await page.waitForTimeout(1000);
      return `Clicked at (${x}, ${y})`;
    }
    throw new ToolError("Provide either selector or (x, y) coordinates", "bad-input");
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(`Click failed: ${(error as Error).message}`, "command-failed");
  }
}

async function typeText(selector: string, text: string): Promise<string> {
  if (!selector) throw new ToolError("Selector is required for type action", "bad-input");
  const page = await getPage();
  try {
    const el = await page.waitForSelector(selector, { timeout: 5_000 });
    if (!el) throw new ToolError(`Element not found: ${selector}`, "not-found");
    await el.fill("");
    await el.type(text, { delay: 50 });
    return `Typed "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}" into ${selector}`;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(`Type failed: ${(error as Error).message}`, "command-failed");
  }
}

async function scroll(
  direction: "up" | "down" | "left" | "right",
  amount?: number
): Promise<string> {
  const page = await getPage();
  const delta = amount ?? 600;
  const deltas: Record<string, { x: number; y: number }> = {
    up: { x: 0, y: -delta },
    down: { x: 0, y: delta },
    left: { x: -delta, y: 0 },
    right: { x: delta, y: 0 }
  };
  const d = deltas[direction] ?? deltas.down;
  await page.mouse.wheel(d.x, d.y);
  await page.waitForTimeout(500);
  return `Scrolled ${direction}${amount ? ` ${amount}px` : ""}`;
}

async function screenshot(fullPage?: boolean): Promise<string> {
  const page = await getPage();
  const screenshotBuffer = await page.screenshot({ type: "png", fullPage: fullPage ?? false });
  const base64 = screenshotBuffer.toString("base64");
  return `[screenshot: data:image/png;base64,${base64}]`;
}

async function extractText(selector?: string): Promise<string> {
  const page = await getPage();
  try {
    if (selector) {
      const el = await page.$(selector);
      if (!el) throw new ToolError(`Element not found: ${selector}`, "not-found");
      const text = await el.innerText();
      return text.slice(0, 50_000);
    }
    const text = await page.innerText("body");
    return text.slice(0, 50_000);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(`Extract text failed: ${(error as Error).message}`, "command-failed");
  }
}

async function waitMs(ms?: number): Promise<string> {
  const timeout = ms ?? 2000;
  await new Promise((resolve) => setTimeout(resolve, timeout));
  return `Waited ${timeout}ms`;
}

async function evaluate(script: string): Promise<string> {
  const page = await getPage();
  try {
    const result = await page.evaluate(script);
    return `Result: ${JSON.stringify(result, null, 2)}`;
  } catch (error) {
    throw new ToolError(`Evaluate failed: ${(error as Error).message}`, "command-failed");
  }
}

async function closeAction(): Promise<string> {
  await closeBrowser();
  return "Browser closed";
}

export function formatBrowserActionResult(result: string): string {
  return result;
}
