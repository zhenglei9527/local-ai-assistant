import { makeUtf8Decoder, type StreamTransport } from './sse.ts'

/**
 * `fetch`-backed transport.
 *
 * WHY THE BODY IS READ MANUALLY
 * -----------------------------
 * `response.body` is not uniformly available across React Native versions and
 * the two platform implementations. Rather than depend on that, this reads the
 * body as a string when no stream is available and yields it in one piece —
 * degraded (the UI sees the whole reply at once instead of streaming) but
 * correct. When a real `ReadableStream` is exposed it is used, which is the
 * normal case on modern RN.
 *
 * The non-2xx path is where the value is: providers put the actual reason
 * ("model not found", "insufficient quota") in the body of a 4xx, and throwing
 * a bare status code makes the app's own error mapping useless.
 */
export function createFetchTransport(): StreamTransport {
  return {
    async *stream(url, headers, body, signal) {
      const method = body === undefined ? 'GET' : 'POST'

      const response = await fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      })

      if (!response.ok) {
        // Read the error body when we can. It is frequently JSON with a
        // `message`/`error` field, and it is the only thing that distinguishes
        // "wrong model name" from "no credit".
        let detail = ''
        try {
          detail = await response.text()
        } catch {
          detail = ''
        }
        const trimmed = detail.length > 500 ? `${detail.slice(0, 500)}…` : detail
        throw new Error(
          `HTTP ${response.status}${trimmed.length > 0 ? `: ${trimmed}` : ''}`,
        )
      }

      const stream = (response as { body?: unknown }).body

      // Preferred path: a real byte stream.
      if (stream && typeof (stream as { getReader?: unknown }).getReader === 'function') {
        const reader = (stream as ReadableStream<Uint8Array>).getReader()
        const decode = makeUtf8Decoder()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) yield decode(value)
          }
        } finally {
          // Release the lock even on abort, or the connection is not reusable
          // and a rapid stop→send sequence leaks sockets.
          try {
            reader.releaseLock()
          } catch {
            // Already released or errored; nothing to do.
          }
        }
        return
      }

      // Fallback: no streaming available. Yield the whole body once.
      const text = await response.text()
      if (text.length > 0) yield text
    },
  }
}
