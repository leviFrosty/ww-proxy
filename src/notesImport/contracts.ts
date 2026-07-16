import type { CreditDenyReason, CreditsSnapshot } from '../credits'

export interface NotesImportKickoffResponse {
  importId: string
  subscribeToken: string
  refinement: boolean
  credits: CreditsSnapshot
}

export interface AllowanceDenialResponse {
  status: 402 | 429
  body: {
    error: string
    code: CreditDenyReason
    credits: CreditsSnapshot
  }
}

/** Required structured error body for both usage-denial branches. */
export const buildAllowanceDenial = (
  reason: CreditDenyReason,
  credits: CreditsSnapshot
): AllowanceDenialResponse =>
  reason === 'limit_reached'
    ? {
        status: 402,
        body: {
          error: 'Import allowance reached',
          code: reason,
          credits,
        },
      }
    : {
        status: 429,
        body: {
          error: 'Refinement limit reached for this import',
          code: reason,
          credits,
        },
      }
