/**
 * Database connection.
 *
 * Lazily opens the app's SQLite file and applies the schema.
 *
 * ── The API this targets, and why it is worth stating ───────────────────────
 * `@op-engineering/op-sqlite` 18.x exposes ONE query primitive:
 *
 *   db.execute(sql, params?) -> Promise<QueryResult>
 *   QueryResult = { rows: Array<Record<string, Scalar>>, rowsAffected, ... }
 *
 * There is no `getAll` and no `getFirst`. A previous revision of this file
 * assumed both existed (they do in `expo-sqlite` and in older op-sqlite
 * releases) and every read in the app would have thrown
 * "db.getAll is not a function" — caught only because the persistence layer was
 * re-checked against the installed type definitions before shipping.
 *
 * The adapter below keeps a narrow `query<T>` helper so callers never touch
 * `QueryResult` directly and a future API change is a one-line edit here.
 *
 * ── Why lazy ────────────────────────────────────────────────────────────────
 * `open()` is a synchronous JSI call into native code. Doing it at module scope
 * would run during the first import — including under Node, where op-sqlite has
 * no native side — so every test that transitively imports the store would fail.
 *
 * ── Why a singleton ─────────────────────────────────────────────────────────
 * op-sqlite throws if the same database name is opened twice, and several
 * modules need it. One connection, shared.
 */

import { migrate } from './schema.ts'

/** A row as SQLite returns it. */
export type SqlRow = Record<string, unknown>

/** The subset of op-sqlite's `QueryResult` this codebase reads. */
interface QueryResult {
  rows?: SqlRow[]
  rowsAffected?: number
}

/** Minimal surface this module needs from the native database handle. */
export interface NativeDb {
  execute: (query: string, params?: unknown[]) => Promise<QueryResult>
  /** Batch DDL. Takes `[sql]` or `[sql, params]` tuples, NOT bare strings. */
  executeBatch?: (commands: Array<[string] | [string, unknown[]]>) => Promise<unknown>
  transaction?: (fn: (tx: NativeDb) => Promise<void>) => Promise<void>
  close?: () => void
}

/**
 * Query interface exposed to the rest of the app.
 *
 * Deliberately small: two reads and two writes cover everything the app does,
 * and keeping `QueryResult` out of the repository layer means a change in the
 * binding's return shape is contained to this file.
 */
export interface SqliteDb {
  /** All rows. Empty array when the query matches nothing. */
  all: <T = SqlRow>(sql: string, params?: unknown[]) => Promise<T[]>
  /** First row, or null. Used for existence and single-row reads. */
  one: <T = SqlRow>(sql: string, params?: unknown[]) => Promise<T | null>
  /** Run a statement that returns nothing useful (INSERT/UPDATE/DELETE/DDL). */
  run: (sql: string, params?: unknown[]) => Promise<void>
  /** Run several statements atomically, rolling back on any failure. */
  tx: (fn: (db: SqliteDb) => Promise<void>) => Promise<void>
  /** The raw handle, for `migrate()` which needs `executeBatch`. */
  raw: NativeDb
}

const DB_NAME = 'phone-llm-app.sqlite'

/**
 * Serializes transactions. SQLite has no nested transactions, and the store
 * fires writes without awaiting them, so overlapping `tx()` calls would leave
 * the first BEGIN uncommitted and silently drop that write.
 */
let txQueue: Promise<unknown> = Promise.resolve()

let db: SqliteDb | null = null
let opening: Promise<SqliteDb | null> | null = null

/** Wrap a native handle in the narrow query interface. */
function adapt(native: NativeDb): SqliteDb {
  const all = async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
    const result = await native.execute(sql, params)
    return (result?.rows ?? []) as T[]
  }

  const one = async <T>(sql: string, params?: unknown[]): Promise<T | null> => {
    const rows = await all<T>(sql, params)
    return rows.length > 0 ? rows[0]! : null
  }

  const run = async (sql: string, params?: unknown[]): Promise<void> => {
    await native.execute(sql, params)
  }

  /**
   * Serialized transaction.
   *
   * ── The bug this fixes ───────────────────────────────────────────────────
   * SQLite has no nested transactions: a `BEGIN` issued while one is already
   * open fails, or — as observed against a real database — silently leaves the
   * OUTER one uncommitted.
   *
   * The store does not await its writes (`appendUser` and `appendMessage` are
   * called back-to-back during a chat turn), so two `tx()` calls overlap. The
   * result was that the user's message committed and the ASSISTANT'S REPLY
   * silently vanished, because its BEGIN interleaved with the still-open one. A
   * missing reply is exactly what a user notices, and it is invisible without a
   * real engine: the fake-based tests accepted the nested BEGIN without
   * complaint.
   *
   * Chaining the transactions onto one promise makes them strictly sequential.
   * The chain advances even after a failure, so one bad write cannot wedge
   * every later one.
   */
  const tx = async (fn: (d: SqliteDb) => Promise<void>): Promise<void> => {
    const execute = async (): Promise<void> => {
      if (!native.transaction) {
        // No transaction support: run the statements anyway. Losing atomicity
        // beats losing the writes entirely.
        await fn(self)
        return
      }
      await native.transaction((txNative) => fn(adapt(txNative)))
    }

    // `.then(execute, execute)` so the queue advances even when the previous
    // transaction rejected.
    const chained = txQueue.then(execute, execute)
    txQueue = chained.catch(() => undefined)
    await chained
  }

  const self: SqliteDb = { all, one, run, tx, raw: native }
  return self
}

/**
 * Get the database, opening and migrating on first call.
 *
 * Returns null when SQLite is unavailable — a Node test process, or a native
 * module that failed to link. Callers must treat null as "persistence is off"
 * and continue with in-memory state rather than crashing: losing history is bad,
 * an unusable chat screen is worse.
 */
export async function getDb(): Promise<SqliteDb | null> {
  if (db) return db
  if (opening) return opening

  opening = (async () => {
    try {
      // Dynamic so the native module is not resolved during a Node import.
      const mod = (await import('@op-engineering/op-sqlite')) as unknown as {
        open?: (p: { name: string }) => NativeDb
      }
      if (typeof mod.open !== 'function') return null

      const native = mod.open({ name: DB_NAME })
      /**
       * `migrate` is handed the RAW handle, not the adapter.
       *
       * It needs `executeBatch` with tuple arguments, which the narrow adapter
       * deliberately does not expose — and passing the adapter would silently
       * skip batching, falling back to statement-by-statement DDL. The extra
       * `executeRows` shim bridges op-sqlite's `QueryResult.rows` to the plain
       * array `migrate` expects.
       */
      await migrate({
        execute: (sql, params) => native.execute(sql, params),
        ...(native.executeBatch
          ? { executeBatch: (cmds) => native.executeBatch!(cmds) }
          : {}),
        executeRows: async (sql, params) => (await native.execute(sql, params))?.rows ?? [],
      })
      db = adapt(native)
      return db
    } catch {
      // Native module missing, disk full, corrupt file — all mean the same
      // thing here: run without persistence.
      return null
    } finally {
      opening = null
    }
  })()

  return opening
}

/** Has persistence been opened successfully? Synchronous, side-effect free. */
export function isPersistenceAvailable(): boolean {
  return db !== null
}

/** Close the connection. Used by tests; the app never calls this. */
export function closeDb(): void {
  try {
    db?.raw.close?.()
  } catch {
    /* closing a broken handle must not throw */
  }
  db = null
}

/** Test-only: inject a fake database. */
export function __setDbForTests(fake: SqliteDb | null): void {
  db = fake
}

/**
 * Test-only: wrap a real handle in the production adapter.
 *
 * Why this exists: a test that hand-rolls its own adapter silently disables
 * whatever the real one does. That happened here — `txQueue` serialization lives
 * inside `adapt()`, so a test-provided adapter reimplemented `tx` WITHOUT the
 * queue and reproduced a bug the production code had already fixed. The test
 * then "proved" the fix ineffective.
 *
 * Exposing the adapter means tests exercise the same code the device does; only
 * the underlying engine differs (a real SQLite in-process instead of op-sqlite).
 */
export function __adaptForTests(native: NativeDb): SqliteDb {
  return adapt(native)
}
