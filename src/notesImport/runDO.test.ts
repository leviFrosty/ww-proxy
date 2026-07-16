import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreditsSnapshot } from '../credits'
import type { Environment } from '../types'
import type { StartImportInput } from './runDO'

const mocks = vi.hoisted(() => ({
  runModel: vi.fn(),
  resolveTerminalSupporter: vi.fn(),
}))

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: DurableObjectState
    env: unknown
    constructor(ctx: DurableObjectState, env: unknown) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

vi.mock('./llm', () => ({ runNotesImportModel: mocks.runModel }))
vi.mock('./settlement', () => ({
  resolveTerminalSupporter: mocks.resolveTerminalSupporter,
}))

const EMPTY_RESULT = {
  contacts: [],
  visits: [],
  timeEntries: [],
  categories: [],
  publisher: null,
  warnings: [],
  summary: 'No records',
  assistantMessage: '',
}

const CREDITS: CreditsSnapshot = {
  remaining: 4,
  limit: 5,
  resetsAt: '2026-07-31T00:00:00.000Z',
  isSupporter: false,
  refinements: { remaining: 5, limit: 5 },
}

const INPUT: StartImportInput = {
  importId: 'imp_test',
  uuid: 'meter-id',
  contentHash: 'a'.repeat(64),
  notesText: 'notes',
  context: {
    now: '2026-07-01T00:00:00Z',
    timeZone: 'UTC',
    existingContacts: [],
    existingCategories: [],
  },
  isSupporter: false,
  devBypass: false,
  decision: {
    allowed: true,
    isNewHash: true,
    isRefinement: false,
    remaining: 4,
  },
}

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const cursor = <T>(rows: T[]) => ({
  toArray: () => rows,
  one: () => rows[0],
})

interface FakeRunState {
  meta: Map<string, string>
  events: Array<{ seq: number; type: string; data: string }>
  alarms: number[]
}

const fakeContext = (state: FakeRunState): DurableObjectState =>
  ({
    id: { toString: () => 'opaque-run-id' },
    storage: {
      sql: {
        exec: (query: string, ...args: unknown[]) => {
          if (query.startsWith('CREATE TABLE')) return cursor([])
          if (query === 'DELETE FROM events') {
            state.events = []
            return cursor([])
          }
          if (query === 'SELECT v FROM meta WHERE k = ?') {
            const value = state.meta.get(String(args[0]))
            return cursor(value == null ? [] : [{ v: value }])
          }
          if (query.startsWith('INSERT OR REPLACE INTO meta')) {
            state.meta.set(String(args[0]), String(args[1]))
            return cursor([])
          }
          if (query === 'DELETE FROM meta WHERE k = ?') {
            state.meta.delete(String(args[0]))
            return cursor([])
          }
          if (query.startsWith('INSERT INTO events')) {
            const seq = state.events.length + 1
            state.events.push({
              seq,
              type: String(args[0]),
              data: String(args[1]),
            })
            return cursor([{ seq }])
          }
          throw new Error(`Unexpected SQL in test: ${query}`)
        },
      },
      setAlarm: vi.fn(async (at: number) => {
        state.alarms.push(at)
      }),
      deleteAll: vi.fn(async () => {
        state.meta.clear()
        state.events = []
      }),
    },
  }) as unknown as DurableObjectState

const makeRun = async (recordUsage: ReturnType<typeof vi.fn>) => {
  const state: FakeRunState = { meta: new Map(), events: [], alarms: [] }
  const index = {
    recordUsage,
    release: vi.fn(async () => undefined),
  }
  const env = {
    OPENROUTER_API_KEY: 'openrouter-key',
    REVENUECAT_API_KEY: 'revenuecat-key',
    NOTES_KV: { get: vi.fn(async () => null) },
    NOTES_IMPORT_INDEX: {
      idFromName: vi.fn(() => ({ toString: () => 'index-id' })),
      get: vi.fn(() => index),
    },
  } as unknown as Environment
  const { NotesImportRun } = await import('./runDO')
  return { run: new NotesImportRun(fakeContext(state), env), state, index }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.runModel.mockResolvedValue({
    result: EMPTY_RESULT,
    usage: { reasoningTokens: 0 },
    resolvedProvider: 'test-provider',
  })
})

describe('NotesImportRun cancellation and destruction settlement', () => {
  it('lets cancellation during terminal refresh win without charging', async () => {
    const refresh = deferred<boolean>()
    mocks.resolveTerminalSupporter.mockReturnValue(refresh.promise)
    const recordUsage = vi.fn()
    const { run, state } = await makeRun(recordUsage)
    await run.start(INPUT)

    const alarm = run.alarm()
    await vi.waitFor(() =>
      expect(mocks.resolveTerminalSupporter).toHaveBeenCalledOnce()
    )

    await expect(run.cancel()).resolves.toEqual({ status: 'cancelled' })
    refresh.resolve(false)
    await alarm

    expect(recordUsage).not.toHaveBeenCalled()
    expect(run.getResult()).toEqual({ status: 'cancelled' })
    expect(state.events.map((event) => event.type)).toContain('cancelled')
    expect(state.events.map((event) => event.type)).not.toContain('done')
  })

  it('serializes cancellation behind an in-flight index settlement RPC', async () => {
    mocks.resolveTerminalSupporter.mockResolvedValue(false)
    const usage = deferred<{ credits: CreditsSnapshot; emptyCharged: boolean }>()
    const recordUsage = vi.fn(() => usage.promise)
    const { run, state } = await makeRun(recordUsage)
    await run.start(INPUT)

    const alarm = run.alarm()
    await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledOnce())

    let cancelSettled = false
    const cancellation = run.cancel().finally(() => {
      cancelSettled = true
    })
    await Promise.resolve()
    expect(cancelSettled).toBe(false)
    expect(run.getResult().status).not.toBe('cancelled')

    usage.resolve({ credits: CREDITS, emptyCharged: false })
    await alarm
    await expect(cancellation).resolves.toMatchObject({
      status: 'done',
      payload: { credits: CREDITS },
    })

    expect(recordUsage).toHaveBeenCalledOnce()
    expect(state.events.map((event) => event.type)).toContain('done')
    expect(state.events.map((event) => event.type)).not.toContain('cancelled')
  })

  it('lets destruction before settlement win without a usage or terminal write', async () => {
    const refresh = deferred<boolean>()
    mocks.resolveTerminalSupporter.mockReturnValue(refresh.promise)
    const recordUsage = vi.fn()
    const { run, state } = await makeRun(recordUsage)
    await run.start(INPUT)

    const alarm = run.alarm()
    await vi.waitFor(() =>
      expect(mocks.resolveTerminalSupporter).toHaveBeenCalledOnce()
    )

    await run.destroy()
    refresh.resolve(false)
    await alarm

    expect(recordUsage).not.toHaveBeenCalled()
    expect(run.getResult()).toEqual({ status: null })
    expect(state.meta.size).toBe(0)
    expect(state.events).toEqual([])
  })

  it('waits for deferred usage settlement before destroying terminal state', async () => {
    mocks.resolveTerminalSupporter.mockResolvedValue(false)
    const usage = deferred<{ credits: CreditsSnapshot; emptyCharged: boolean }>()
    const recordUsage = vi.fn(() => usage.promise)
    const { run, state } = await makeRun(recordUsage)
    await run.start(INPUT)

    const alarm = run.alarm()
    await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledOnce())

    let destroySettled = false
    const destruction = run.destroy().finally(() => {
      destroySettled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(destroySettled).toBe(false)

    usage.resolve({ credits: CREDITS, emptyCharged: false })
    await Promise.all([alarm, destruction])

    expect(recordUsage).toHaveBeenCalledOnce()
    expect(run.getResult()).toEqual({ status: null })
    expect(state.meta.size).toBe(0)
    expect(state.events).toEqual([])
  })
})
