/**
 * Pure helpers for multi-version assistant replies ("swipes").
 *
 * ── Why this is its own module ──────────────────────────────────────────────
 * The invariant below is the one thing in the swipe feature that, when broken,
 * corrupts a conversation silently rather than visibly. It is worth having
 * exactly one implementation of it that every call site goes through, and it is
 * worth being able to test that implementation without a store, an engine, or a
 * database.
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────────
 *
 *     message.content === message.swipes[message.swipeIndex]
 *
 * `content` is what the transcript renders AND what `generate()` sends back to
 * the model as history. `swipes` is what the user navigates. If the two
 * disagree, the user reads version 2 while the model is told version 1 — a
 * divergence that produces a reply answering a message no longer on screen, and
 * that looks like the model "went crazy" rather than like a bookkeeping bug.
 *
 * Every function here takes the whole message and returns a whole message, so
 * that a caller cannot update `swipeIndex` while forgetting `content`.
 */

import type { Message } from '@/types/domain.ts'

/**
 * The versions a message actually has.
 *
 * A message that predates the feature — or a user turn, which has no
 * alternatives — carries `[]`. For an ASSISTANT message an empty array is
 * treated as "one version, namely the text that is already showing", because
 * the alternative is a version counter reading `0/0` on every reply in every
 * conversation a user already has. That upgrade is done on read (see
 * `withVersions`) rather than stored, so nothing has to be migrated.
 */
export function swipesOf(message: Message): string[] {
  if (Array.isArray(message.swipes) && message.swipes.length > 0) return message.swipes
  // Only assistant turns have alternatives; seeding a user turn would let the
  // UI offer to swap the user's own message for another wording it never had.
  if (message.role !== 'assistant') return []
  return message.content.length > 0 ? [message.content] : []
}

/**
 * Clamp an index into range.
 *
 * `Math.trunc` first: a fractional index (`swipes[0.5]` → `undefined`) would
 * blank the bubble entirely, and `|| 0` folds NaN — which is what a missing
 * column or a corrupt JSON value produces — into a valid index rather than
 * propagating it into the render.
 */
export function clampSwipeIndex(index: number, length: number): number {
  if (length <= 0) return 0
  const whole = Math.trunc(index) || 0
  return Math.min(Math.max(whole, 0), length - 1)
}

/**
 * Return the message showing version `index`, with `content` re-derived.
 *
 * Out-of-range indexes wrap. Wrapping is the documented UI behaviour (the arrows
 * cycle rather than dead-ending), so it is enforced here too: a tap on "next"
 * from the last version and a programmatic index of `length` must not disagree.
 */
export function withSwipeIndex(message: Message, index: number): Message {
  const versions = swipesOf(message)
  if (versions.length === 0) {
    // Nothing to navigate. Returned unchanged rather than given a fabricated
    // version, so an assistant message that somehow arrived empty stays empty.
    return message
  }
  const wrapped = ((Math.trunc(index) % versions.length) + versions.length) % versions.length
  return {
    ...message,
    swipes: versions,
    swipeIndex: wrapped,
    // The invariant, enforced in the one place that writes both fields.
    content: versions[wrapped]!,
  }
}

/** Step forward / backward by one, wrapping at both ends. */
export function stepSwipe(message: Message, delta: 1 | -1): Message {
  const versions = swipesOf(message)
  if (versions.length <= 1) return withSwipeIndex(message, 0)
  // Normalise through `withSwipeIndex` first: `swipeIndex` may be stale or out
  // of range (a message loaded from a pre-feature row), and stepping from an
  // unclamped value would land somewhere the user did not ask for.
  const current = withSwipeIndex(message, message.swipeIndex).swipeIndex
  return withSwipeIndex(message, current + delta)
}

/**
 * Append `version` and show it.
 *
 * Appends rather than replaces, which is the entire point of the feature. An
 * empty `version` is refused by returning the message untouched: generation can
 * legitimately produce nothing (an immediate stop, a model that emitted only
 * whitespace), and appending that would leave a blank version in the cycle that
 * the user can select and then has to escape from.
 */
export function appendSwipe(message: Message, version: string): Message {
  if (version.length === 0) return withSwipeIndex(message, message.swipeIndex)

  const versions = swipesOf(message)
  // Guard against a retry that produced byte-identical output to a version
  // already stored: a duplicate adds a "new" version that looks like the button
  // did nothing, which is the exact complaint the feature exists to fix.
  const existing = versions.indexOf(version)
  if (existing >= 0) return withSwipeIndex(message, existing)

  const next = [...versions, version]
  return withSwipeIndex({ ...message, swipes: next }, next.length - 1)
}

/**
 * Rewrite `content` for a message the user edited by hand.
 *
 * Editing the visible text must edit the VERSION the user is looking at, not
 * merely overwrite `content`. Writing only `content` would break the invariant
 * immediately — the next arrow tap or reload would restore the pre-edit text
 * from `swipes` and the user's edit would appear to undo itself, which is worse
 * than not offering editing at all.
 */
export function editCurrentSwipe(message: Message, text: string): Message {
  const versions = swipesOf(message)
  if (versions.length === 0) return { ...message, content: text }

  const index = clampSwipeIndex(message.swipeIndex, versions.length)
  const next = versions.slice()
  next[index] = text
  return { ...message, swipes: next, swipeIndex: index, content: text }
}

/**
 * The version switcher's visible state: `‹ 2/3 ›` or nothing at all.
 *
 * Extracted from the component so the numbers the user actually reads are
 * decided by testable code rather than by JSX. The alternative — asserting on
 * the `.tsx` source text — would pass even if the fraction were inverted, and
 * this project has no renderer in its test environment to catch that.
 *
 * Returns `null` below two versions. One version is the normal case, and a
 * "1/1" on every reply in the transcript is noise that trains the user to
 * ignore the control; zero versions means a user turn, which has no
 * alternatives to offer.
 *
 * `index` is 1-based in the RETURNED fraction but the displayed position is
 * always clamped into range, so a stale index can never render "0/3" or "4/3".
 */
export function swipeLabel(message: Message): { position: number; total: number } | null {
  const versions = swipesOf(message)
  if (versions.length <= 1) return null
  const index = clampSwipeIndex(message.swipeIndex, versions.length)
  return { position: index + 1, total: versions.length }
}
