export interface SseEvent {
  event?: string;
  id?: string;
  data: string;
}

export async function* readSseEvents(body: ReadableStream<Uint8Array> | null): AsyncGenerator<SseEvent> {
  if (!body) {
    throw new Error("Provider returned no event stream body");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      yield* drainSseBuffer(buffer, (remaining) => {
        buffer = remaining;
      });
    }
    buffer += decoder.decode();
    yield* drainSseBuffer(`${buffer}\n\n`, (remaining) => {
      buffer = remaining;
    });
  } finally {
    reader.releaseLock();
  }
}

function* drainSseBuffer(buffer: string, update: (remaining: string) => void): Generator<SseEvent> {
  let current = buffer;
  while (true) {
    const separator = current.search(/\r?\n\r?\n/);
    if (separator < 0) {
      update(current);
      return;
    }
    const rawEvent = current.slice(0, separator);
    const separatorLength = current[separator] === "\r" ? 4 : 2;
    current = current.slice(separator + separatorLength);
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
    const value = colon >= 0 ? line.slice(colon + 1).replace(/^ /, "") : "";
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
