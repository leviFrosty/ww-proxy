import { DurableObject } from 'cloudflare:workers'
import type { Environment } from '../types'
import { decideAcquire } from './cap'
import {
  decideCredit,
  computeCommit,
  computeKickoffCredits,
  refinementUsage,
  type CreditDecision,
  type CreditState,
  type CreditsSnapshot,
  type HashRecord,
  type RefinementUsage,
} from '../credits'

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

/** Pre-flight credit check (read-only). */
export interface CheckCreditArgs {
  hash: string
  isSupporter: boolean
  isRefinement: boolean
  freeCredits: number
  maxRefinements: number
}

/** Post-success credit commit. */
export interface RecordUsageArgs {
  hash: string
  isSupporter: boolean
  decision: CreditDecision
  freeCredits: number
  maxRefinements: number
}

/** What a commit returns for the client's usage meter. */
export interface RecordUsageResult {
  remaining: number | null
  refinements: RefinementUsage
}

/** Read-only kickoff snapshot inputs (mirrors {@link RecordUsageArgs} but no write). */
export interface KickoffCreditsArgs {
  hash: string
  decision: CreditDecision
  isSupporter: boolean
  unmetered: boolean
  freeCredits: number
  maxRefinements: number
}

/**
 * `NotesImportIndex` — one instance per user (keyed by their install uuid). It
 * is the authority for two per-user invariants:
 *
 *  1. "how many imports may run at once" — the kickoff/legacy paths call
 *     {@link acquire} before running the model and {@link release} when it
 *     settles (also backs the app's "active imports" list/badge); and
 *  2. the FREE-CREDIT METER — {@link checkCredit} (pre-flight) / {@link recordUsage}
 *     (post-success commit) / {@link kickoffCredits} (read-only snapshot).
 *
 * Both live here because this DO is a SINGLE instance per user and
 * single-threaded, so its SQLite storage is strongly consistent and its RPC
 * calls are serialized — the credit read-modify-write is therefore ATOMIC (it
 * previously raced over eventually-consistent KV, letting concurrent imports all
 * read the same stale count and bypass the cap). Holds NO notes content — only
 * import ids, coarse status, and usage counters (ADR 0008).
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
    // Per-user credit meter (was KV `credits:<uuid>` / `hash:<uuid>:<hash>`).
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS credit_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`
    )
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS hash_record (
         hash        TEXT PRIMARY KEY,
         charged     INTEGER NOT NULL,
         refinements INTEGER NOT NULL
       )`
    )
  }

  // --- Concurrency cap ----------------------------------------------------

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

  // --- Credit meter (atomic: single-threaded DO) --------------------------

  /**
   * Pre-flight gate for the model call — read-only, no charge. Returns the same
   * {@link CreditDecision} shape the route/run DO freeze and later commit.
   */
  checkCredit(args: CheckCreditArgs): CreditDecision {
    return decideCredit({
      state: this.#creditState(args.hash),
      isSupporter: args.isSupporter,
      isRefinement: args.isRefinement,
      freeCredits: args.freeCredits,
      maxRefinements: args.maxRefinements,
    })
  }

  /**
   * Commit usage after a successful model run. Reads the CURRENT state and writes
   * the next state in one serialized turn — no interleave, no lost increment.
   * Idempotent per hash (a `charged` hash isn't re-charged). Returns the credits
   * remaining plus the post-commit refinement allowance for the response body.
   */
  recordUsage(args: RecordUsageArgs): RecordUsageResult {
    const state = this.#creditState(args.hash)
    const { state: next, remaining } = computeCommit({
      decision: args.decision,
      state,
      isSupporter: args.isSupporter,
      freeCredits: args.freeCredits,
    })
    if (next.count !== state.count) this.#setCount(next.count)
    if (next.record) this.#writeRecord(args.hash, next.record)
    return {
      remaining,
      refinements: refinementUsage(next.record, args.maxRefinements),
    }
  }

  /**
   * Read-only usage snapshot for the kickoff response, so the client's meter
   * populates at run start. Equal to the eventual `done` snapshot (the pending
   * refinement is folded in) — see {@link computeKickoffCredits}.
   */
  kickoffCredits(args: KickoffCreditsArgs): CreditsSnapshot {
    return computeKickoffCredits({
      decision: args.decision,
      record: this.#record(args.hash),
      isSupporter: args.isSupporter,
      unmetered: args.unmetered,
      freeCredits: args.freeCredits,
      maxRefinements: args.maxRefinements,
    })
  }

  // --- storage helpers ----------------------------------------------------

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

  #creditState(hash: string): CreditState {
    return { count: this.#creditCount(), record: this.#record(hash) }
  }

  #creditCount(): number {
    const rows = this.ctx.storage.sql
      .exec<{ v: number }>("SELECT v FROM credit_meta WHERE k = 'count'")
      .toArray()
    return rows.length ? rows[0].v : 0
  }

  #setCount(count: number): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO credit_meta (k, v) VALUES ('count', ?)",
      count
    )
  }

  #record(hash: string): HashRecord | null {
    const rows = this.ctx.storage.sql
      .exec<{ charged: number; refinements: number }>(
        'SELECT charged, refinements FROM hash_record WHERE hash = ?',
        hash
      )
      .toArray()
    if (!rows.length) return null
    return { charged: rows[0].charged !== 0, refinements: rows[0].refinements }
  }

  #writeRecord(hash: string, record: HashRecord): void {
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO hash_record (hash, charged, refinements) VALUES (?, ?, ?)',
      hash,
      record.charged ? 1 : 0,
      record.refinements
    )
  }
}
