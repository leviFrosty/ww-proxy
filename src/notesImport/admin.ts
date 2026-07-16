import { timingSafeEqual } from '../crypto'
import type { ResetUsageResult } from './indexDO'
import {
  emitNotesImportOperationalEvent,
  usageResetEvent,
} from './operations'

export const isValidMeterId = (value: string): boolean =>
  /^[A-Za-z0-9_-]{8,64}$/.test(value)

export interface AdminResetIndex {
  /** Opaque Durable Object id; safe for operational correlation. */
  objectId: string
  resetUsage(): Promise<ResetUsageResult> | ResetUsageResult
}

export interface AdminResetDependencies {
  adminToken: string | undefined
  indexFor(meterId: string): AdminResetIndex
}

const json = (body: unknown, status: number): Response =>
  Response.json(body, { status })

/**
 * Secret-protected admin request seam. Missing configuration and every auth
 * failure intentionally produce the same 404. Only the validated meter id is
 * used to select a DO; it is never logged or returned.
 */
export const handleAdminResetRequest = async (
  request: Request,
  dependencies: AdminResetDependencies
): Promise<Response> => {
  const expected = dependencies.adminToken
  const supplied = request.headers.get('x-ww-admin-token') ?? ''
  if (!expected || !timingSafeEqual(supplied, expected)) {
    return json({ error: 'Not found' }, 404)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }
  const meterId =
    body && typeof body === 'object' && 'meterId' in body
      ? (body as { meterId?: unknown }).meterId
      : null
  if (typeof meterId !== 'string' || !isValidMeterId(meterId)) {
    return json({ error: 'Invalid meterId' }, 400)
  }

  const index = dependencies.indexFor(meterId)
  const result = await index.resetUsage()
  emitNotesImportOperationalEvent(
    usageResetEvent({
      objectId: index.objectId,
      previousUsed: result.previousCount,
      hadActiveWindow: result.hadActiveWindow,
      deletedEmptyRuns: result.deletedEmptyRuns,
    })
  )
  return json({ ok: true }, 200)
}
