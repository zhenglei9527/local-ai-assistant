/**
 * Conversation switching must not destroy history.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * On device the user reported: send a message, leave the 对话 tab, come back —
 * the message was gone. Two causes, both here:
 *
 *   1. `setActiveConversation` unconditionally did `messages: []`. The store
 *      holds ONE transcript, so entering a conversation wiped whatever was on
 *      screen, and returning showed an empty chat.
 *   2. Nothing parked the outgoing transcript, so even correct navigation lost
 *      the previous conversation's turns.
 *
 * These tests pin the parking behaviour: leave, come back, still there.
 *
 * Run with:
 *   node --import ./scripts/register-alias.mjs --test src/store/transcripts.test.ts
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { useChatStore } from '@/store/index.ts'

function reset(): void {
  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    messages: [],
    transcripts: {},
  } as never)
}

describe('conversation transcripts', () => {
  beforeEach(reset)

  test('a new conversation starts empty', () => {
    const id = useChatStore.getState().createConversation(null)
    assert.equal(useChatStore.getState().messages.length, 0)
    assert.equal(useChatStore.getState().activeConversationId, id)
  })

  test('leaving and returning preserves the transcript', () => {
    const a = useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('第一条消息')
    assert.equal(useChatStore.getState().messages.length, 1)

    // Navigate away — back to the conversation list.
    useChatStore.getState().setActiveConversation(null)
    assert.equal(useChatStore.getState().messages.length, 0)

    // …and back in. This is what used to lose the message.
    useChatStore.getState().setActiveConversation(a)
    const restored = useChatStore.getState().messages
    assert.equal(restored.length, 1)
    assert.equal(restored[0]!.content, '第一条消息')
  })

  test('switching between two conversations keeps each one separate', () => {
    const a = useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('给 A 的消息')

    const b = useChatStore.getState().createConversation(null)
    assert.equal(useChatStore.getState().messages.length, 0, 'B must start clean')
    useChatStore.getState().appendUser('给 B 的消息')

    useChatStore.getState().setActiveConversation(a)
    assert.deepEqual(
      useChatStore.getState().messages.map((m) => m.content),
      ['给 A 的消息'],
    )

    useChatStore.getState().setActiveConversation(b)
    assert.deepEqual(
      useChatStore.getState().messages.map((m) => m.content),
      ['给 B 的消息'],
    )
  })

  test('an assistant reply is parked too, not just user turns', () => {
    const id = useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('问题')
    // `generate()` commits the reply through `appendMessage`.
    useChatStore.getState().appendMessage({
      id: 'a-1',
      conversationId: id,
      role: 'assistant',
      content: '回答',
      reasoning: null,
      createdAt: Date.now(),
      modelId: null,
      swipeIndex: 0,
      swipes: [],
    } as never)

    useChatStore.getState().setActiveConversation(null)
    useChatStore.getState().setActiveConversation(id)

    assert.deepEqual(
      useChatStore.getState().messages.map((m) => m.content),
      ['问题', '回答'],
    )
  })

  test('sending a message advances the fields the list sorts on', () => {
    // The LIST sorts by `lastMessageAt` (see ConversationListScreen) rather
    // than trusting array order, so the contract is that those fields advance.
    const a = useChatStore.getState().createConversation(null)
    const before = useChatStore.getState().conversations.find((c) => c.id === a)!
    useChatStore.getState().setActiveConversation(a)
    useChatStore.getState().appendUser('让 A 回到顶部')
    const after = useChatStore.getState().conversations.find((c) => c.id === a)!

    assert.equal(after.messageCount, before.messageCount + 1)
    assert.ok(
      after.lastMessageAt >= before.lastMessageAt,
      'lastMessageAt must not go backwards or the list will not re-sort',
    )
  })

  test('the list ordering is deterministic when timestamps tie', () => {
    // Two conversations touched in the same millisecond compare equal on
    // `lastMessageAt`. Without a tie-break the sort is free to reorder them
    // arbitrarily, which shows up as rows swapping places between renders.
    // The id is monotonic, so it breaks the tie meaningfully.
    const older = useChatStore.getState().createConversation(null)
    const newer = useChatStore.getState().createConversation(null)

    const stamp = Date.now()
    useChatStore.setState((s) => ({
      conversations: s.conversations.map((c) => ({ ...c, lastMessageAt: stamp })),
    }) as never)

    const sortFn = (x: { lastMessageAt: number; id: string }, y: { lastMessageAt: number; id: string }) =>
      y.lastMessageAt - x.lastMessageAt || y.id.localeCompare(x.id)

    const first = [...useChatStore.getState().conversations].sort(sortFn).map((c) => c.id)
    const second = [...useChatStore.getState().conversations].reverse().sort(sortFn).map((c) => c.id)

    assert.deepEqual(first, second, 'ordering must not depend on input order')
    assert.equal(first[0], newer, 'the more recently created chat wins a tie')
    assert.equal(first[1], older)
  })

  test('deleting a conversation leaves the others intact', () => {
    const a = useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('保留这条')
    const b = useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('删掉这条')

    useChatStore.getState().deleteConversation(b)

    assert.equal(useChatStore.getState().conversations.length, 1)
    useChatStore.getState().setActiveConversation(a)
    assert.deepEqual(
      useChatStore.getState().messages.map((m) => m.content),
      ['保留这条'],
    )
  })

  test('deleting a conversation also drops its parked transcript', () => {
    // Parked transcripts are keyed by conversation id. Leaving one behind means
    // a deleted conversation's history could reappear the moment an id is
    // reused — ghost data the user cannot explain or remove.
    const a = useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('要删掉的对话')
    const b = useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('保留的对话')

    // Parking happens on switch-away, so navigate once to populate the map.
    useChatStore.getState().setActiveConversation(a)
    useChatStore.getState().setActiveConversation(b)
    assert.ok(useChatStore.getState().transcripts[a], 'a should be parked')

    useChatStore.getState().deleteConversation(a)

    assert.equal(
      useChatStore.getState().transcripts[a],
      undefined,
      'the deleted transcript must not linger',
    )
    assert.ok(useChatStore.getState().transcripts[b], 'the other transcript must survive')
  })

  test('deleting the open conversation clears the screen', () => {
    const a = useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('正在看的对话')

    useChatStore.getState().deleteConversation(a)

    // The navigator shows the list when `activeConversationId` is null; leaving
    // it set would strand the user on the transcript of a conversation that no
    // longer exists.
    assert.equal(useChatStore.getState().activeConversationId, null)
    assert.equal(useChatStore.getState().messages.length, 0)
  })
})
