/** Hash the exact English copy bytes used by the Worker publication check. */
export async function hashEnglishCopy(english) {
  const source = JSON.stringify({
    bannerText: english.bannerText,
    title: english.title,
    markdown: english.markdown,
  })
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(source),
  )
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/** Only use for validated published feeds, whose translations matched at publication. */
export async function draftFromFeed(feed) {
  const announcement = structuredClone(feed.announcement)
  delete announcement.revision
  delete announcement.publishedAt
  return {
    schemaVersion: 1,
    announcement,
    translationSourceHash: await hashEnglishCopy(announcement.locales['en-us']),
  }
}
