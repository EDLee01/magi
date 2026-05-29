export interface SseEvent {
  event?: string;
  id?: string;
  data: string;
}

const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB

export async function* readSseEvents(
  body: ReadableStream<Uint8Array> | null
): AsyncGenerator<SseEvent> {
  if (!body) {
    throw new Error("Provider returned no event stream body");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let offset = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const offsetRef = { offset };
      yield* drainSseBuffer(buffer, offsetRef);
      offset = offsetRef.offset;

      // Compact buffer: copy only the trailing unconsumed bytes to a fresh string.
      // This breaks V8's retained-string chain where slice() keeps reference to parent.
      if (offset > 0) {
        if (buffer.length === offset) {
          buffer = "";
        } else {
          // Round-trip via Buffer to force fresh allocation (slice returns a sliced
          // string in V8 that retains the entire parent string, causing OOM).
          buffer = Buffer.from(buffer.substring(offset), "utf8").toString("utf8");
        }
        offset = 0;
      }

      // Hard guard: if buffer grows past the cap (event larger than 1MB), drop it.
      if (buffer.length > MAX_BUFFER_SIZE) {
        buffer = "";
        offset = 0;
      }
    }
    buffer += decoder.decode();
    const finalRef = { offset };
    yield* drainSseBuffer(`${buffer.substring(offset)}\n\n`, finalRef);
  } finally {
    reader.releaseLock();
  }
}

function* drainSseBuffer(buffer: string, offsetRef: { offset: number }): Generator<SseEvent> {
  while (true) {
    const searchStart = offsetRef.offset;
    const separator = buffer.indexOf("\n\n", searchStart);
    const sepCR = buffer.indexOf("\r\n\r\n", searchStart);
    let sepIdx = -1;
    let sepLen = 0;
    if (separator >= 0 && (sepCR < 0 || separator < sepCR)) {
      sepIdx = separator;
      sepLen = 2;
    } else if (sepCR >= 0) {
      sepIdx = sepCR;
      sepLen = 4;
    }
    if (sepIdx < 0) {
      return;
    }
    const rawEvent = buffer.substring(offsetRef.offset, sepIdx);
    offsetRef.offset = sepIdx + sepLen;
    const event = parseSseEvent(rawEvent);
    if (event) {
      yield event;
    }
  }
}

function parseSseEvent(raw: string): SseEvent | undefined {
  const event: Partial<SseEvent> & { dataLines: string[] } = { dataLines: [] };
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon >= 0 ? line.slice(0, colon) : line;
    let value = colon >= 0 ? line.slice(colon + 1) : "";
    if (value.charCodeAt(0) === 32) {
      value = value.slice(1);
    }
    if (field === "event") {
      event.event = value;
    } else if (field === "id") {
      event.id = value;
    } else if (field === "data") {
      event.dataLines.push(value);
    }
  }
  if (event.dataLines.length === 0) {
    return undefined;
  }
  return {
    event: event.event,
    id: event.id,
    data: event.dataLines.join("\n")
  };
}
