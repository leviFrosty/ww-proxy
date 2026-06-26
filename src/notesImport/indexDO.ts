import { DurableObject } from 'cloudflare:workers'
import type { Environment } from '../types'
import { decideAcquire } from './cap'

/** One active-import row tracked for a user. */
export interface ActiveImport {
  importId: string
  status: string
  startedAt: number
}

export interface AcquireResult {
  ok: boolean
  /** Active count AFTER this call (so the client can render "N of cap"). */
  active: number
}

/**
 * `NotesImportIndex` — one instance per user (keyed by their install uuid). It
 * is the authority for "how many imports may run at once": the kickoff path
 * calls {@link acquire} before spawning a run DO, and each run DO calls
 * {@link release} when it reaches a terminal state. It also backs the app's
 * "active imports" list/badge. Holds NO notes content — only import ids + coarse
 * status (ADR 0008).
 */
export class NotesImportIndex extends DurableObject<Environment> {
  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env)
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS active (
         importId  TEXT PRIMARY KEY,
         status    TEXT NOT NULL,
         startedAt INTEGER NOT NULL
       )`
    )
  }

  /** Reserve a slot for importId when under cap. Idempotent for a held id. */
  acquire(importId: string, cap: number): AcquireResult {
    const held = this.#has(importId)
    const active = this.#count()
    if (!decideAcquire(active, held, cap)) return { ok: false, active }
    if (!held) {
      this.ctx.storage.sql.exec(
        'INSERT INTO active (importId, status, startedAt) VALUES (?, ?, ?)',
        importId,
        'running',
        Date.now()
      )
    }
    return { ok: true, active: held ? active : active + 1 }
  }

  /** Drop a slot once its run has settled. Safe to call for an unknown id. */
  release(importId: string): void {
    this.ctx.storage.sql.exec('DELETE FROM active WHERE importId = ?', importId)
  }

  /** The user's currently-active imports, newest first. */
  list(): ActiveImport[] {
    // Inline row literal (not the named interface) so it satisfies the SqlStorage
    // `Record<string, SqlStorageValue>` constraint; shape matches ActiveImport.
    return this.ctx.storage.sql
      .exec<{ importId: string; status: string; startedAt: number }>(
        'SELECT importId, status, startedAt FROM active ORDER BY startedAt DESC'
      )
      .toArray()
  }

  #has(importId: string): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ n: number }>(
          'SELECT COUNT(*) AS n FROM active WHERE importId = ?',
          importId
        )
        .one().n > 0
    )
  }

  #count(): number {
    return this.ctx.storage.sql
      .exec<{ n: number }>('SELECT COUNT(*) AS n FROM active')
      .one().n
  }
}
