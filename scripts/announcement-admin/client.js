import { CrepeBuilder } from '@milkdown/crepe/builder'
import { topBar } from '@milkdown/crepe/feature/top-bar'
import { toolbar } from '@milkdown/crepe/feature/toolbar'
import { imageBlock } from '@milkdown/crepe/feature/image-block'
import { linkTooltip } from '@milkdown/crepe/feature/link-tooltip'
import { listItem } from '@milkdown/crepe/feature/list-item'
import { placeholder } from '@milkdown/crepe/feature/placeholder'
import { replaceAll, insert } from '@milkdown/kit/utils'
import { draftFromFeed, hashEnglishCopy } from './draft.mjs'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/classic.css'
import './style.css'

const $ = (id) => document.getElementById(id)
const names = {
  'en-us': 'English (US)',
  'de-de': 'Deutsch',
  'es-es': 'Español',
  'fr-fr': 'Français',
  'it-it': 'Italiano',
  'ja-jp': '日本語',
  'ko-kr': '한국어',
  'nl-nl': 'Nederlands',
  'pt-br': 'Português (Brasil)',
  'pt-pt': 'Português (Portugal)',
  'ru-ru': 'Русский',
  'vi-vn': 'Tiếng Việt',
  'zh-hant-tw': '繁體中文',
  'zh-hans-cn': '简体中文',
  'sw-ke': 'Kiswahili',
  'uk-ua': 'Українська',
  'bem-zm': 'Bemba',
  'rw-rw': 'Kinyarwanda',
}
let session,
  draft,
  draftEtag = null,
  currentEtag,
  current,
  selected = 'en-us',
  editor,
  rich = true,
  loading = false,
  busy = false,
  dirty = false,
  englishChanged = false
let renderedMarkdown = '',
  bodyEdited = false
const emptyCopy = () => ({ bannerText: '', title: '', markdown: '' })
const newDraft = () => ({
  schemaVersion: 1,
  announcement: {
    id: `announcement-${crypto.randomUUID()}`,
    dismissible: true,
    signature: true,
    locales: { 'en-us': emptyCopy() },
  },
})
function message(text, error = false) {
  $('message').textContent = text
  $('message').className = error ? 'error' : ''
}

async function api(path, body, method = 'POST') {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : method,
    credentials: 'same-origin',
    headers: {
      ...(session ? { 'x-ww-csrf': session.csrf } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const result = await response.json()
  if (!response.ok)
    throw Object.assign(
      new Error(result.error || `Request failed (${response.status})`),
      { status: response.status },
    )
  return result
}

function toLocal(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16)
}
function collect() {
  const old = draft.announcement.locales[selected]
  const copy = {
    bannerText: $('banner-text').value,
    title: $('title').value,
    markdown: bodyEdited
      ? rich
        ? editor.getMarkdown()
        : $('markdown').value
      : old?.markdown || '',
  }
  if (
    selected !== 'en-us' &&
    !Object.values(copy).some((value) => value.trim())
  ) {
    delete draft.announcement.locales[selected]
    if (draft.translationStatus) delete draft.translationStatus[selected]
  } else if (JSON.stringify(old) !== JSON.stringify(copy)) {
    draft.announcement.locales[selected] = copy
    if (selected === 'en-us') {
      englishChanged = true
      delete draft.translationSourceHash
    } else
      draft.translationStatus = {
        ...draft.translationStatus,
        [selected]: 'reviewed',
      }
  }
  draft.announcement.id = $('announcement-id').value
  draft.announcement.dismissible = $('dismissible').checked
  draft.announcement.signature = $('signature').checked
  for (const [id, key] of [
    ['starts-at', 'startsAt'],
    ['expires-at', 'expiresAt'],
  ]) {
    if ($(id).value)
      draft.announcement[key] = new Date($(id).value).toISOString()
    else delete draft.announcement[key]
  }
  return draft
}
function markDirty() {
  if (loading || !draft) return
  dirty = true
  collect()
  renderCoverage()
  $('draft-status').textContent = 'Unsaved changes'
}
function renderCoverage() {
  if (!draft || !session) return
  const available = session.locales.filter(
    (locale) => draft.announcement.locales[locale],
  )
  const stale = englishChanged || !draft.translationSourceHash
  $('completeness').textContent =
    `${available.length} of ${session.locales.length} languages present${stale ? ' · translations need to be refreshed for this English source' : ' · translations match the saved English source'}.`
  $('languages').replaceChildren(
    ...session.locales.map((locale) => {
      const button = document.createElement('button')
      const status = !draft.announcement.locales[locale]
        ? 'missing'
        : locale === 'en-us'
          ? 'source'
          : stale
            ? 'stale'
            : draft.translationStatus?.[locale] || 'stored'
      button.textContent = `${names[locale] || locale} · ${status}`
      button.className = `language ${locale === selected ? 'selected' : ''}`
      button.disabled = busy
      button.addEventListener('click', () => {
        collect()
        selected = locale
        $('locale').value = locale
        renderCopy()
      })
      return button
    }),
  )
  $('locale-status').textContent =
    selected === 'en-us'
      ? 'Source language. Changing English makes translations stale.'
      : 'Machine translations can be reviewed and edited in either mode.'
}
function renderCopy() {
  loading = true
  const copy = draft.announcement.locales[selected] || emptyCopy()
  $('banner-text').value = copy.bannerText
  $('title').value = copy.title
  $('markdown').value = copy.markdown
  editor.editor.action(replaceAll(copy.markdown))
  renderedMarkdown = editor.getMarkdown()
  bodyEdited = false
  loading = false
  renderCoverage()
}
function renderDraft() {
  $('announcement-id').value = draft.announcement.id
  $('dismissible').checked = draft.announcement.dismissible
  $('signature').checked = draft.announcement.signature
  $('starts-at').value = toLocal(draft.announcement.startsAt)
  $('expires-at').value = toLocal(draft.announcement.expiresAt)
  $('locale').value = selected
  renderCopy()
  // Imported JSON and drafts saved by other clients can carry an older source hash.
  const renderedDraft = draft,
    english = draft.announcement.locales['en-us']
  if (draft.translationSourceHash)
    hashEnglishCopy(english).then((hash) => {
      if (draft !== renderedDraft) return
      if (draft.translationSourceHash !== hash) {
        englishChanged = true
        renderCoverage()
      }
    })
}
function renderCurrent() {
  $('current').textContent = current?.announcement
    ? `${current.announcement.locales['en-us'].title} · ${current.announcement.id} · published ${new Date(current.announcement.publishedAt).toLocaleString()}`
    : 'No published announcement'
  $('unpublish').disabled = !current?.announcement || busy
  $('edit-current').disabled = !current?.announcement || busy
}
async function refreshHistory() {
  const { data } = await api('/api/history')
  $('history').replaceChildren(
    ...data.items.map((item) => {
      const row = document.createElement('div')
      row.className = 'history-row'
      const label = document.createElement('span')
      label.textContent = `${item.id} · ${new Date(item.publishedAt).toLocaleString()} · ${item.revision.slice(0, 8)}`
      const restore = document.createElement('button')
      restore.textContent = 'Restore as draft'
      restore.addEventListener('click', () =>
        perform(async () => {
          if (!discardOkay()) return
          if (
            !/^\/announcements\/releases\/[a-f0-9-]{36}\.json$/.test(item.url)
          )
            throw new Error('Invalid history URL.')
          const { data: feed } = await api(item.url)
          draft = await draftFromFeed(feed)
          selected = 'en-us'
          englishChanged = false
          dirty = true
          renderDraft()
          const saved = await api('/api/draft', { draft, draftEtag }, 'PUT')
          draftEtag = saved.draftEtag
          dirty = false
          $('draft-status').textContent = 'Restored draft saved'
          message(
            'Revision restored to the draft. Review it before publishing.',
          )
        }),
      )
      row.append(label, restore)
      return row
    }),
  )
}
async function reload() {
  const { data: status } = await api('/api/status')
  current = status.current
  currentEtag = status.currentEtag
  draftEtag = status.draftEtag
  try {
    const saved = await api('/api/draft')
    draft = saved.data
    draftEtag = saved.etag
  } catch (error) {
    if (error.status !== 404) throw error
    draft = newDraft()
    draftEtag = null
  }
  dirty = false
  englishChanged = false
  selected = 'en-us'
  renderDraft()
  renderCurrent()
  $('draft-status').textContent = draftEtag
    ? 'Saved draft loaded'
    : 'No saved draft · start writing'
  await refreshHistory()
}
function discardOkay() {
  return (
    !dirty ||
    window.confirm(
      'Replace your unsaved edits? Export the draft first if you want to keep them.',
    )
  )
}
async function perform(action) {
  if (busy) return
  busy = true
  document.querySelectorAll('button, input, select, textarea').forEach((el) => {
    el.disabled = true
  })
  $('form').inert = true
  try {
    await action()
  } catch (error) {
    message(
      `${error.message}${error.status === 412 ? ' Reload saved state to reconcile another editor’s changes; export your edits first.' : ''}`,
      true,
    )
  } finally {
    busy = false
    document
      .querySelectorAll('button, input, select, textarea')
      .forEach((el) => {
        el.disabled = false
      })
    $('form').inert = false
    renderCurrent()
    renderCoverage()
  }
}
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function pickFile(accept, callback) {
  $('file-input').accept = accept
  $('file-input').value = ''
  $('file-input').onchange = () => {
    const file = $('file-input').files[0]
    if (file) perform(() => callback(file))
  }
  $('file-input').click()
}
async function upload(file) {
  if (
    !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
    file.size > 5 * 1024 * 1024
  )
    throw new Error('Choose a PNG, JPEG, or WebP image up to 5 MiB.')
  const response = await fetch('/api/images', {
    method: 'POST',
    headers: { 'x-ww-csrf': session.csrf, 'content-type': file.type },
    body: file,
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error)
  if (
    !/^\/announcements\/images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(result.url)
  )
    throw new Error('Invalid uploaded image URL.')
  return result.url
}
async function main() {
  session = await api('/api/session')
  $('environment').textContent = session.environment
  $('environment').className =
    session.environment === 'production' ? 'production' : ''
  $('worker').textContent = session.baseUrl
  $('locale').replaceChildren(
    ...session.locales.map(
      (locale) => new Option(names[locale] || locale, locale),
    ),
  )
  editor = new CrepeBuilder({ root: '#editor' })
    .addFeature(topBar)
    .addFeature(toolbar)
    .addFeature(linkTooltip)
    .addFeature(listItem)
    .addFeature(placeholder, { text: 'Write your announcement…' })
    .addFeature(imageBlock, {
      onUpload: async (file) => {
        try {
          return await upload(file)
        } catch (error) {
          message(error.message, true)
          throw error
        }
      },
      proxyDomURL: (url) =>
        /^\/announcements\/images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(url)
          ? url
          : '',
    })
  await editor.create()
  editor.on((listener) =>
    listener.markdownUpdated(() => {
      if (loading || !rich || editor.getMarkdown() === renderedMarkdown) return
      renderedMarkdown = editor.getMarkdown()
      bodyEdited = true
      markDirty()
    }),
  )
  $('form').addEventListener('input', (event) => {
    if (event.target.id === 'locale' || event.target.closest('.milkdown'))
      return
    if (event.target.id === 'markdown') bodyEdited = true
    markDirty()
  })
  $('locale').addEventListener('change', () => {
    collect()
    selected = $('locale').value
    renderCopy()
  })
  for (const [id, value] of [
    ['rich-mode', true],
    ['markdown-mode', false],
  ])
    $(id).addEventListener('click', () => {
      collect()
      rich = value
      $('editor').hidden = !rich
      $('markdown').hidden = rich
      $('rich-mode').setAttribute('aria-pressed', String(rich))
      $('markdown-mode').setAttribute('aria-pressed', String(!rich))
      renderCopy()
    })
  $('reload').addEventListener('click', () =>
    perform(async () => {
      if (discardOkay()) {
        await reload()
        message('Saved state reloaded.')
      }
    }),
  )
  $('new').addEventListener('click', () => {
    if (!discardOkay()) return
    draft = newDraft()
    selected = 'en-us'
    englishChanged = false
    dirty = true
    renderDraft()
    $('draft-status').textContent = 'New unsaved announcement'
  })
  $('edit-current').addEventListener('click', () =>
    perform(async () => {
      if (!discardOkay()) return
      draft = await draftFromFeed(current)
      selected = 'en-us'
      englishChanged = false
      dirty = true
      renderDraft()
      $('draft-status').textContent = 'Editing current publication · unsaved'
    }),
  )
  $('save').addEventListener('click', () =>
    perform(async () => {
      const result = await api(
        '/api/draft',
        { draft: collect(), draftEtag },
        'PUT',
      )
      draft = result.draft
      draftEtag = result.draftEtag
      dirty = false
      $('draft-status').textContent = 'Draft saved'
      message('Draft saved.')
    }),
  )
  $('translate').addEventListener('click', () =>
    perform(async () => {
      message(
        'Translating missing or stale languages. This may take several minutes…',
      )
      const result = await api('/api/translate', {
        draft: collect(),
        agent: $('agent').value,
      })
      draft = result.draft
      englishChanged = false
      dirty = true
      renderDraft()
      $('draft-status').textContent = 'Translations ready · unsaved'
      message(
        'Translations are ready to review. Save the draft or publish when ready.',
      )
    }),
  )
  $('publish').addEventListener('click', () =>
    perform(async () => {
      collect()
      if (
        !window.confirm(
          `Publish “${draft.announcement.locales['en-us'].title}” to ${session.environment}? The current draft will be published.`,
        )
      )
        return
      message('Publishing announcement…')
      const result = await api('/api/publish', {
        draft,
        draftEtag,
        currentEtag,
      })
      draft = result.draft
      draftEtag = result.draftEtag
      current = result.current
      currentEtag = result.currentEtag
      englishChanged = false
      dirty = false
      renderDraft()
      renderCurrent()
      $('draft-status').textContent = 'Published draft saved'
      await refreshHistory()
      message('Announcement published.')
    }),
  )
  $('unpublish').addEventListener('click', () =>
    perform(async () => {
      if (
        !window.confirm(
          `Unpublish the current announcement in ${session.environment}?`,
        )
      )
        return
      const result = await api('/api/unpublish', { currentEtag })
      current = result.current
      currentEtag = result.currentEtag
      renderCurrent()
      message('Announcement unpublished. The draft and history are retained.')
    }),
  )
  $('import-md').addEventListener('click', () =>
    pickFile('.md,text/markdown,text/plain', async (file) => {
      if (file.size > 48000) throw new Error('Markdown file is too large.')
      collect()
      draft.announcement.locales[selected] = {
        ...(draft.announcement.locales[selected] || emptyCopy()),
        markdown: await file.text(),
      }
      if (selected === 'en-us') {
        englishChanged = true
        delete draft.translationSourceHash
      }
      dirty = true
      renderCopy()
      $('draft-status').textContent = 'Imported Markdown · unsaved'
    }),
  )
  $('export-md').addEventListener('click', () => {
    collect()
    download(
      `${draft.announcement.id}.${selected}.md`,
      draft.announcement.locales[selected].markdown,
      'text/markdown',
    )
  })
  $('upload-image').addEventListener('click', () =>
    pickFile('image/png,image/jpeg,image/webp', async (file) => {
      const url = await upload(file)
      if (rich) editor.editor.action(insert(`![Image description](${url})`))
      else {
        $('markdown').value += `\n\n![Image description](${url})\n`
        bodyEdited = true
        markDirty()
      }
      message('Image uploaded. Add a descriptive alt text.')
    }),
  )
  $('export-json').addEventListener('click', () =>
    download(
      `${draft.announcement.id}.json`,
      JSON.stringify(collect(), null, 2),
      'application/json',
    ),
  )
  $('import-json').addEventListener('click', () =>
    pickFile('.json,application/json', async (file) => {
      if (!discardOkay()) return
      if (file.size > 256 * 1024) throw new Error('Draft file is too large.')
      const imported = JSON.parse(await file.text())
      if (
        imported.schemaVersion !== 1 ||
        !imported.announcement?.locales?.['en-us']
      )
        throw new Error('Choose a schemaVersion 1 announcement draft.')
      draft = imported
      selected = 'en-us'
      englishChanged = false
      dirty = true
      renderDraft()
      $('draft-status').textContent = 'Imported draft · unsaved'
    }),
  )
  window.addEventListener('beforeunload', (event) => {
    if (dirty || busy) {
      event.preventDefault()
      event.returnValue = ''
    }
  })
  await perform(reload)
}
main().catch((error) => message(error.message, true))
