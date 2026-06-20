import { describe, expect, it } from 'vitest'
import { getNotesImportConfig } from './config'
import type { Environment } from '../types'

const baseEnv = {} as Environment

describe('getNotesImportConfig', () => {
  it('falls back to generous defaults', () => {
    const cfg = getNotesImportConfig(baseEnv)
    expect(cfg.model).toBe('deepseek/deepseek-v4-flash')
    expect(cfg.providers).toEqual(['fireworks', 'deepinfra', 'baseten', 'azure'])
    expect(cfg.maxChars).toBe(100_000)
    expect(cfg.maxOutputTokens).toBe(16_000)
    expect(cfg.freeCredits).toBe(5)
    expect(cfg.maxRefinements).toBe(5)
    expect(cfg.entitlementId).toBe('Supporter')
    expect(cfg.devBypassToken).toBeNull()
  })

  it('honors env overrides and parses the provider list', () => {
    const cfg = getNotesImportConfig({
      ...baseEnv,
      NOTES_IMPORT_MODEL: 'fireworks/some-model',
      NOTES_IMPORT_PROVIDERS: 'fireworks, deepinfra ,, baseten',
      NOTES_IMPORT_MAX_CHARS: '250000',
      NOTES_IMPORT_FREE_CREDITS: '3',
      NOTES_IMPORT_DEV_BYPASS_TOKEN: 'tok',
    } as Environment)
    expect(cfg.model).toBe('fireworks/some-model')
    expect(cfg.providers).toEqual(['fireworks', 'deepinfra', 'baseten'])
    expect(cfg.maxChars).toBe(250_000)
    expect(cfg.freeCredits).toBe(3)
    expect(cfg.devBypassToken).toBe('tok')
  })

  it('ignores non-positive / garbage numeric overrides', () => {
    const cfg = getNotesImportConfig({
      ...baseEnv,
      NOTES_IMPORT_MAX_CHARS: '-5',
      NOTES_IMPORT_FREE_CREDITS: 'abc',
    } as Environment)
    expect(cfg.maxChars).toBe(100_000)
    expect(cfg.freeCredits).toBe(5)
  })
})
