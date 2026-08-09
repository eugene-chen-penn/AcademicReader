// Generic Server-Sent-Events line parser, shared by every streaming
// provider adapter (OpenAI/DeepSeek, Gemini, and Anthropic all use SSE, but
// Anthropic is the only one that uses the `event:` field — the others only
// ever send `data:` lines). Yields one {event, data} pair per blank-line-
// terminated SSE message, feeding it raw text chunks as they arrive rather
// than waiting for the whole response.
export interface SSEEvent {
  event: string | null;
  data: string;
}

export async function* parseSSEStream(response: Response): AsyncGenerator<SSEEvent> {
  if (!response.body) {
    throw new Error("response has no readable body to stream");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent: string | null = null;
  let currentDataLines: string[] = [];

  function* flush(): Generator<SSEEvent> {
    if (currentDataLines.length > 0) {
      yield { event: currentEvent, data: currentDataLines.join("\n") };
    }
    currentEvent = null;
    currentDataLines = [];
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

      if (line === "") {
        yield* flush();
      } else if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        currentDataLines.push(line.slice(5).trim());
      }
      // Other fields (id:, retry:, `:`-prefixed comments) are ignored.
    }
  }
  yield* flush();
}
