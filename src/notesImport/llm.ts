import { generateObject, jsonSchema, type JSONSchema7 } from 'ai'
import { createGateway } from '@ai-sdk/gateway'
import { buildNotesImportSystemPrompt } from './prompt'
import {
  NOTES_IMPORT_SCHEMA,
  type NotesImportContext,
  type NotesImportResult,
} from './schema'
import type { NotesImportConfig } from './config'

export interface RefinementInput {
  /** The model's previous full result, as the JSON string the client cached. */
  previousResultJSON: string
  /** The user's natural-language correction (e.g. "Maria's visit was Tuesday"). */
  instruction: string
}

export interface RunModelArgs {
  apiKey: string
  config: NotesImportConfig
  /** The notes being parsed (original notes for a refinement). */
  notesText: string
  context: NotesImportContext
  refinement?: RefinementInput
  abortSignal?: AbortSignal
}

export interface RunModelOutput {
  result: NotesImportResult
  usage: Awaited<ReturnType<typeof generateObject>>['usage']
  /** Which underlying provider the gateway actually used (for ZDR audit logs). */
  resolvedProvider?: string
}

const buildRefinementPrompt = (
  notesText: string,
  refinement: RefinementInput
): string =>
  `Here are the user's ORIGINAL notes:

"""
${notesText}
"""

You previously produced this structured result:

${refinement.previousResultJSON}

The user has a correction. Apply it and return a FRESH, COMPLETE structured
result for the ORIGINAL notes above — not a diff, the whole object — with the
correction incorporated. Keep everything else the same unless the correction
implies otherwise.

User correction: ${refinement.instruction}`

/**
 * Runs the notes-import model through the Vercel AI Gateway. Routing is pinned
 * to the configured Western provider allowlist with `zeroDataRetention` and
 * `disallowPromptTraining` set, so the request only reaches a ZDR host (ADR
 * 0008). Output is structurally validated against NOTES_IMPORT_SCHEMA by
 * `generateObject` — a non-conforming response throws rather than returning
 * garbage.
 */
export const runNotesImportModel = async ({
  apiKey,
  config,
  notesText,
  context,
  refinement,
  abortSignal,
}: RunModelArgs): Promise<RunModelOutput> => {
  const gw = createGateway({ apiKey })

  const { object, usage, providerMetadata } = await generateObject({
    model: gw(config.model),
    schema: jsonSchema<NotesImportResult>(
      NOTES_IMPORT_SCHEMA as unknown as JSONSchema7
    ),
    schemaName: 'NotesImport',
    schemaDescription:
      'Structured WitnessWork records parsed from free-form ministry notes.',
    system: buildNotesImportSystemPrompt(context),
    prompt: refinement
      ? buildRefinementPrompt(notesText, refinement)
      : notesText,
    temperature: 0,
    maxOutputTokens: config.maxOutputTokens,
    maxRetries: 2,
    abortSignal,
    providerOptions: {
      gateway: {
        zeroDataRetention: true,
        disallowPromptTraining: true,
        only: config.providers,
      },
    },
  })

  const routing = (
    providerMetadata?.gateway as { routing?: { resolvedProvider?: string } } | undefined
  )?.routing

  return {
    result: object,
    usage,
    resolvedProvider: routing?.resolvedProvider,
  }
}
