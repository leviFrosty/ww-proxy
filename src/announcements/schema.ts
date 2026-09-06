import MarkdownIt from 'markdown-it'
import { z } from 'zod'

export const MAX_JSON_BYTES = 256 * 1024
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const LOCALES = [
  'en-us',
  'de-de',
  'es-es',
  'fr-fr',
  'it-it',
  'ja-jp',
  'ko-kr',
  'nl-nl',
  'pt-br',
  'pt-pt',
  'ru-ru',
  'vi-vn',
  'zh-hant-tw',
  'zh-hans-cn',
  'sw-ke',
  'uk-ua',
  'bem-zm',
  'rw-rw',
] as const
export const IMAGE_PATH =
  /^\/announcements\/images\/[a-f0-9]{64}\.(png|jpg|webp)$/
export const REVISION =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const parser = new MarkdownIt({ html: true, linkify: false })
// Parse unsafe destinations too so validation can reject them rather than silently
// treating a blocked javascript: Markdown link as ordinary text.
parser.validateLink = () => true

export function markdownProblem(markdown: string): string | undefined {
  const walk = (
    tokens: ReturnType<typeof parser.parse>,
  ): string | undefined => {
    for (const token of tokens) {
      if (token.type === 'html_block' || token.type === 'html_inline')
        return 'Raw HTML is not supported'
      if (
        token.type === 'image' &&
        !IMAGE_PATH.test(token.attrGet('src') ?? '')
      )
        return 'Images must use uploaded announcement image paths'
      if (token.type === 'link_open') {
        const href = token.attrGet('href') ?? ''
        try {
          const url = new URL(href)
          if (
            !['https:', 'mailto:'].includes(url.protocol) ||
            url.username ||
            url.password
          )
            return 'Links must use https or mailto'
        } catch {
          return 'Links must use https or mailto'
        }
      }
      if (token.children) {
        const problem = walk(token.children)
        if (problem) return problem
      }
    }
  }
  return walk(parser.parse(markdown, {}))
}
const locale = z.enum(LOCALES)
// Preserve Markdown indentation and exact source-hash bytes from the editor.
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, 'Text cannot be blank')
const localized = z.strictObject({
  bannerText: text(180),
  title: text(160),
  markdown: text(12_000).superRefine((value, ctx) => {
    const problem = markdownProblem(value)
    if (problem) ctx.addIssue({ code: 'custom', message: problem })
  }),
})
const announcement = z
  .strictObject({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
    startsAt: z.iso.datetime().optional(),
    expiresAt: z.iso.datetime().optional(),
    dismissible: z.boolean(),
    signature: z.boolean(),
    locales: z
      .partialRecord(locale, localized)
      .refine(
        (value) => Boolean(value['en-us']),
        'English (en-us) is required',
      ),
  })
  .refine(
    (value) =>
      !value.startsAt ||
      !value.expiresAt ||
      Date.parse(value.startsAt) < Date.parse(value.expiresAt),
    'Expiration must follow the start',
  )
export const DraftSchema = z.strictObject({
  schemaVersion: z.literal(1),
  announcement,
  translationStatus: z
    .partialRecord(locale, z.enum(['machine', 'reviewed']))
    .optional(),
  translationSourceHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
})
export const FeedSchema = z.strictObject({
  schemaVersion: z.literal(1),
  announcement: announcement
    .safeExtend({
      revision: z.string().regex(REVISION),
      publishedAt: z.iso.datetime(),
    })
    .nullable(),
})
export type Draft = z.infer<typeof DraftSchema>
export type Feed = z.infer<typeof FeedSchema>

export function imageType(
  bytes: Uint8Array,
): { contentType: string; extension: string } | null {
  if (
    bytes.length >= 24 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) &&
    String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR'
  )
    return { contentType: 'image/png', extension: 'png' }
  if (
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes[bytes.length - 2] === 255 &&
    bytes[bytes.length - 1] === 217
  )
    return { contentType: 'image/jpeg', extension: 'jpg' }
  if (
    bytes.length >= 16 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP' &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(
      String.fromCharCode(...bytes.slice(12, 16)),
    )
  )
    return { contentType: 'image/webp', extension: 'webp' }
  return null
}
