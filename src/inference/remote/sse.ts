/**
 * Server-Sent Events parsing and incremental stream decoding.
 *
 * WHY THIS IS HAND-ROLLED
 * -----------------------
 * React Native's `fetch` does not expose a streaming body reader reliably
 * across platforms and versions — `response.body` is a `ReadableStream` on
 * some combinations and `undefined` on others, and the `react-native-sse`
 * packages on npm each paper over that differently. Rather than take a
 * dependency whose behaviour we cannot test here, the chunk decoding is a pure
 * function over strings so it can be unit-tested without a network at all.
 *
 * The I/O layer is injected ({@link StreamTransport}), which is also what lets
 * the whole remote engine be tested against a scripted response with no device.
 *
 * WHAT SSE ACTUALLY REQUIRES
 * --------------------------
 * The format is line-oriented, but a network chunk boundary falls wherever the
 * TCP stack decides — routinely in the middle of a line, and in the middle of a
 * multi-byte UTF-8 sequence. So the decoder must:
 *
 *   1. buffer incomplete lines across chunks,
 *   2. ignore comment lines (`:` prefix — OpenAI sends `: keep-alive`),
 *   3. tolerate both `\n` and `\r\n`,
 *   4. treat `data: [DONE]` as terminal for OpenAI,
 *   5. keep decoding body bytes as UTF-8 across chunk boundaries rather than
 *      per-chunk, or CJK output gets mangled into replacement characters.
 *
 * Point 5 is the one that bites in practise: this app's primary audience writes
 * Chinese, and a naive `chunk.toString()` per network chunk corrupts it.
 */

/** One parsed SSE event. `data` is the raw payload with the field stripped. */
export interface SseEvent {
  readonly event: string | null
  readonly data: string
}

/**
 * Splits an accumulated buffer into complete events plus a remainder.
 *
 * Pure. The caller feeds network chunks in and keeps the returned `rest` for
 * the next call. Splitting on a blank line is what the SSE spec says delimits
 * an event; we accept `\n\n` and `\r\n\r\n`.
 */
export function parseSseBuffer(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = []

  // Normalise CRLF once, up front. Doing it per-line later would mean two
  // regexes and the chance of missing a split across a chunk boundary.
  const normalised = buffer.replace(/\r\n/g, '\n')
  const parts = normalised.split('\n\n')

  // The last element is either an incomplete event or an empty string when the
  // chunk ended exactly on a delimiter. Either way it is the remainder.
  const rest = parts.pop() ?? ''

  for (const block of parts) {
    if (block.trim().length === 0) continue

    let eventName: string | null = null
    const dataLines: string[] = []

    for (const line of block.split('\n')) {
      // Comments (`: keep-alive`) are valid SSE and MUST be ignored rather than
      // treated as data — OpenAI sends them on idle connections and a naive
      // parser will try to JSON.parse them and throw.
      if (line.startsWith(':')) continue

      const colon = line.indexOf(':')
      if (colon === -1) continue

      const field = line.slice(0, colon)
      // A single leading space after the colon is part of the framing, not the
      // payload, per the SSE spec.
      let value = line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)

      if (field === 'data') {
        dataLines.push(value)
      } else if (field === 'event') {
        eventName = value
      }
      // `id` and `retry` are not used by either provider's streaming API.
    }

    // A block that contained only comments (or only `id:`/`retry:` fields)
    // produces no data lines. Emitting an empty-data event here would make the
    // caller JSON.parse("") and log a spurious malformed frame — and, worse,
    // could be mistaken for a legal empty delta.
    if (dataLines.length === 0 && eventName === null) continue

    // Multiple `data:` lines in one event are joined with newlines per spec.
    events.push({ event: eventName, data: dataLines.join('\n') })
  }

  return { events, rest }
}

/**
 * Decodes a raw byte chunk to a string, preserving split multi-byte sequences.
 *
 * `TextDecoder` with `{ stream: true }` is required: a UTF-8 character may
 * straddle two network chunks, and decoding each chunk independently yields
 * U+FFFD. Chinese text is 3 bytes per character, so a 2-byte split is not a
 * rare edge case — it happens constantly at chunk boundaries.
 */
export function makeUtf8Decoder(): (chunk: Uint8Array) => string {
  // `TextDecoder` exists in Hermes. The fallback is deliberately crude but
  // never silently wrong in the common ASCII case.
  const DecoderCtor: typeof TextDecoder | undefined = (globalThis as { TextDecoder?: typeof TextDecoder })
    .TextDecoder
  if (DecoderCtor) {
    const decoder = new DecoderCtor('utf-8')
    return (chunk: Uint8Array) => decoder.decode(chunk, { stream: true })
  }
  return (chunk: Uint8Array) => Array.from(chunk, (b) => String.fromCharCode(b)).join('')
}

/**
 * Extracts the incremental text from a provider's stream event.
 *
 * Both shapes are handled here rather than in two parsers because the
 * difference is three field paths, and keeping them side by side makes the
 * divergence auditable.
 *
 * Returns `null` when the event carries no text (role-only openers, usage
 * frames, ping events) — the caller distinguishes that from an empty delta,
 * which is legal.
 */
export interface DeltaResult {
  /** Newly generated assistant text. */
  readonly text: string
  /** Newly generated reasoning/thinking text, when the provider separates it. */
  readonly reasoning: string
  /** True when the provider signalled end-of-stream. */
  readonly done: boolean
}

const NO_DELTA: DeltaResult = { text: '', reasoning: '', done: false }

/** OpenAI `chat.completions` streaming chunk. */
export function readOpenAiDelta(event: SseEvent): DeltaResult {
  if (event.data === '[DONE]') {
    return { text: '', reasoning: '', done: true }
  }

  let payload: unknown
  try {
    payload = JSON.parse(event.data)
  } catch {
    // A gateway that emits a non-JSON keep-alive or an HTML error mid-stream.
    // Skipping is correct: the HTTP status check already handled hard errors,
    // and aborting the whole turn on one malformed frame loses real output.
    return NO_DELTA
  }

  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return NO_DELTA

  const first = choices[0] as {
    delta?: { content?: unknown; reasoning_content?: unknown }
    finish_reason?: unknown
  }

  const text = typeof first.delta?.content === 'string' ? first.delta.content : ''
  // `reasoning_content` is DeepSeek's thinking field. Other gateways use
  // `reasoning`; accept both since the cost is one extra lookup.
  const altReasoning = (first.delta as { reasoning?: unknown } | undefined)?.reasoning
  const reasoning =
    typeof first.delta?.reasoning_content === 'string'
      ? first.delta.reasoning_content
      : typeof altReasoning === 'string'
        ? altReasoning
        : ''

  return { text, reasoning, done: first.finish_reason != null }
}

/** Anthropic `messages` streaming event. */
export function readAnthropicDelta(event: SseEvent): DeltaResult {
  let payload: unknown
  try {
    payload = JSON.parse(event.data)
  } catch {
    return NO_DELTA
  }

  const type = (payload as { type?: unknown }).type

  switch (type) {
    case 'content_block_delta': {
      const delta = (payload as { delta?: { type?: string; text?: string; thinking?: string } }).delta
      if (delta?.type === 'text_delta') {
        return { text: delta.text ?? '', reasoning: '', done: false }
      }
      if (delta?.type === 'thinking_delta') {
        return { text: '', reasoning: delta.thinking ?? '', done: false }
      }
      // `input_json_delta` belongs to tool use, which this app does not do.
      return NO_DELTA
    }
    case 'message_stop':
      return { text: '', reasoning: '', done: true }
    case 'error': {
      const message = (payload as { error?: { message?: string } }).error?.message
      throw new Error(message ? `Anthropic error: ${message}` : 'Anthropic stream error')
    }
    default:
      // message_start / content_block_start / content_block_stop /
      // message_delta / ping all carry no incremental text we render.
      return NO_DELTA
  }
}

/**
 * Transport seam.
 *
 * The real implementation wraps `fetch`; tests supply a scripted one. Keeping
 * this an interface is what makes the remote engine testable on a machine with
 * no device and no network — which is the only kind of machine this project
 * has ever been built on.
 */
export interface StreamTransport {
  /**
   * POSTs JSON and yields decoded text chunks until the stream ends.
   *
   * Implementations MUST throw on a non-2xx status, with the response body
   * included in the message where available — a bare "400" is unactionable
   * when the cause is a wrong model name or an expired key.
   */
  stream(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    signal?: AbortSignal,
  ): AsyncIterable<string>
}
