/**
 * Orca Browser Bridge - Content Script
 *
 * Runs on all pages. Handles commands from the background service worker
 * for page content extraction, element interaction, and LinkedIn automation.
 *
 * Communication: Orca (Rust WS) -> background.js -> chrome.tabs.sendMessage -> this script
 */

;(function () {
  'use strict'

  if (window.__orcaBridgeLoaded) return
  window.__orcaBridgeLoaded = true

  // ============================================================
  // Message handler (from background.js via chrome.runtime.onMessage)
  // ============================================================

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const { action } = msg

    switch (action) {
      case 'get_page_content':
        sendResponse(getPageContent(msg.format))
        return true

      case 'extract_elements':
        sendResponse(extractElements(msg.selector, msg.attributes, msg.limit))
        return true

      case 'click_element':
        sendResponse(clickElement(msg.selector))
        return true

      case 'fill_input':
        sendResponse(fillInput(msg.selector, msg.value, msg.submit))
        return true

      // LinkedIn-specific actions
      case 'orca-post-comment':
        handleLinkedInComment(msg).then(sendResponse)
        return true

      case 'orca-create-post':
        handleLinkedInPost(msg).then(sendResponse)
        return true

      // LinkedIn faceted-search harvesting (eval-free; runs as real content
      // script functions, so not subject to the MV3 eval/CSP restriction).
      case 'orca-extract-metas':
        harvestExtractMetas().then(sendResponse)
        return true

      case 'orca-resolve-url':
        harvestResolveUrl(msg.menuLabel).then(sendResponse)
        return true

      // LinkedIn messaging (godmode inbox triage) — runs in a BACKGROUND tab,
      // nothing here may assume window focus.
      case 'orca-linkedin-list-conversations':
        linkedinListConversations(msg.limit, msg.unreadOnly).then(sendResponse)
        return true

      case 'orca-linkedin-read-thread':
        linkedinReadThread(msg.conversationUrn, msg.lastN).then(sendResponse)
        return true

      case 'orca-linkedin-send-dm':
        linkedinSendDm(msg.conversationUrn, msg.textBase64).then(sendResponse)
        return true

      // WhatsApp Web actions
      case 'orca-whatsapp-list-chats':
        sendResponse(whatsappListChats(msg.limit))
        return true

      case 'orca-whatsapp-open-chat':
        handleWhatsAppOpenChat(msg.recipient).then(sendResponse)
        return true

      case 'orca-whatsapp-send-message':
        handleWhatsAppSendMessage(msg.recipient, msg.messageBase64).then(sendResponse)
        return true

      case 'orca-whatsapp-read-messages':
        sendResponse(whatsappReadMessages(msg.limit))
        return true

      case 'orca-whatsapp-check-unread':
        sendResponse(whatsappCheckUnread())
        return true

      default:
        // Don't respond to overlay messages (handled by overlay.js)
        if (action?.startsWith('orca_')) return false
        sendResponse({ error: `Unknown action: ${action}` })
        return true
    }
  })

  // ============================================================
  // LinkedIn faceted-search harvesting
  // ============================================================

  function harvestSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  // Find the post BODY text within a post root, resilient to LinkedIn's
  // volatile class names. Prefers the dedicated text component; falls back to
  // the longest break-words block (the body is longer than the author
  // headline, which also uses break-words). Returns '' if nothing usable.
  function harvestExtractBody(root) {
    if (!root) return ''
    const specific = root.querySelector(
      '.update-components-text, .feed-shared-update-v2__description, .feed-shared-inline-show-more-text'
    )
    if (specific && specific.innerText && specific.innerText.trim()) {
      return specific.innerText.trim().substring(0, 1500)
    }
    let best = ''
    root.querySelectorAll('.break-words').forEach((el) => {
      const t = (el.innerText || '').trim()
      if (t.length > best.length) best = t
    })
    if (best.trim()) return best.substring(0, 1500)
    return harvestBodyFromLines(root.innerText || '')
  }

  // Last-resort body extraction, and the one that actually holds up.
  //
  // LinkedIn's search feed is now server-driven with per-build hashed class
  // names (`adfab463`, `_10fbd90b`), so every class selector above is one
  // deploy away from returning nothing — which is exactly what happened, and
  // an empty body means the app skips the post as too short. This derives the
  // body from the post's own visible text instead: drop the author header,
  // which ends at the timestamp or the Follow control, and stop at the
  // engagement footer.
  const HARVEST_HEADER_END = /^(Follow|Following|Connect|\+ Follow)$/i
  const HARVEST_TIMESTAMP = /^(now|\d+\s*(s|m|h|d|w|mo|y|yr))\s*(•|·)/i
  const HARVEST_FOOTER = /^(Like|Comment|Repost|Send|Reply|Share)$/i
  const HARVEST_NOISE = /^(…\s*)?(see\s+)?more$|^Feed post$/i

  function harvestBodyFromLines(text) {
    const lines = text.split(String.fromCharCode(10)).map((l) => l.trim())

    // Header ends at the LAST header marker in the opening block: the name,
    // headline and timestamp all precede the body.
    let start = 0
    const scan = Math.min(lines.length, 18)
    for (let i = 0; i < scan; i++) {
      if (HARVEST_HEADER_END.test(lines[i]) || HARVEST_TIMESTAMP.test(lines[i])) start = i + 1
    }

    let end = lines.length
    for (let i = start; i < lines.length; i++) {
      if (HARVEST_FOOTER.test(lines[i])) {
        end = i
        break
      }
    }

    const body = lines
      .slice(start, end)
      .filter((l) => l && !HARVEST_NOISE.test(l))
      .join(String.fromCharCode(10))
      .trim()

    // If the header/footer heuristic ate everything, the raw text beats
    // nothing: the app only needs enough to draft against.
    if (body.length < 30) return text.trim().substring(0, 1500)
    return body.substring(0, 1500)
  }

  // Scroll to load lazy posts, then extract per-post metadata from the
  // control-menu buttons. Returns
  // { posts: [{author_hint, context, body, menu_label, degree}] }.
  // `context` keeps the old author+header chrome (used for the degree badge and
  // back-compat); `body` is the actual post text the draft model should use.
  async function harvestExtractMetas() {
    try {
      window.scrollBy(0, 2000)
      await harvestSleep(3000)

      const menuBtns = Array.from(
        document.querySelectorAll('button[aria-label^="Open control menu for post by"]')
      )
      const posts = []
      for (const btn of menuBtns) {
        const label = btn.getAttribute('aria-label') || ''
        const m = label.match(/Open control menu for post by (.+)/)
        const authorName = m ? m[1].trim() : 'Unknown'

        // Prefer the actual post root so the body element can be targeted;
        // fall back to the legacy walk-up (first ancestor with enough text).
        // The walk-up alone stops at a long author-header block and misses the
        // body, which produced the "[Draft generation failed]" cards.
        // `[componentkey]` is the server-driven feed's post container; the two
        // legacy classes stopped matching entirely when LinkedIn moved the
        // search feed to SDUI, which dropped every post back to the walk-up.
        let root = btn.closest('.feed-shared-update-v2, [data-urn], [componentkey]')
        if (root && (root.innerText || '').length < 150) root = null
        if (!root) {
          root = btn.parentElement
          while (
            root &&
            root.tagName !== 'BODY' &&
            (!root.innerText || root.innerText.length < 150)
          ) {
            root = root.parentElement
          }
        }

        const context =
          root && root.tagName !== 'BODY' ? (root.innerText || '').substring(0, 1500) : ''
        const body = harvestExtractBody(root)

        let deg = 'none'
        if (/·\s*1st/.test(context) || (context.indexOf(' 1st') > -1 && context.indexOf('1st connections') === -1)) deg = '1st'
        else if (/·\s*2nd/.test(context) || context.indexOf(' 2nd') > -1) deg = '2nd'
        else if (/·\s*3rd/.test(context) || context.indexOf(' 3rd') > -1) deg = '3rd+'

        posts.push({ author_hint: authorName, context, body, menu_label: label, degree: deg })
        if (posts.length >= 8) break
      }
      return { posts }
    } catch (e) {
      return { error: e.message, posts: [] }
    }
  }

  function harvestToastLinks() {
    const out = []
    document
      .querySelectorAll('[class*="toast"], [role="alert"], [role="status"]')
      .forEach((t) => {
        t.querySelectorAll('a').forEach((a) => {
          if (a.href) out.push(a.href)
        })
      })
    return out
  }

  // The toast's "View post" link is now a /safety/go/ interstitial carrying the
  // real destination in ?url=. The old code did href.split('?')[0], which threw
  // that away and handed back the bare interstitial for every single post.
  function harvestUnwrapSafetyUrl(href) {
    try {
      const u = new URL(href)
      if (u.pathname.indexOf('/safety/go') === 0) {
        const inner = u.searchParams.get('url')
        if (inner) return inner
      }
      return href.split('?')[0]
    } catch (e) {
      return href.split('?')[0]
    }
  }

  // Resolve a post's canonical URL: open its control menu, click "Copy link",
  // read the toast's "View post" link. Returns { url } or { error }.
  async function harvestResolveUrl(menuLabel) {
    try {
      if (!menuLabel) return { error: 'menuLabel required' }

      const btn = Array.from(
        document.querySelectorAll('button[aria-label^="Open control menu for post by"]')
      ).find((b) => b.getAttribute('aria-label') === menuLabel)
      if (!btn) return { error: 'menu button not found' }

      // Toasts stack and persist between posts, so a link that is already on
      // screen belongs to a PREVIOUS post. Snapshot them and only accept a new
      // one, or posts silently get each other's URLs.
      const before = harvestToastLinks()

      btn.click()

      // Poll rather than sleep: the control menu takes longer than the old
      // fixed 1500ms to render, so the lookup ran against the page's global
      // nav and returned "copy link not found" every time.
      let copyLink = null
      for (let i = 0; i < 20 && !copyLink; i++) {
        await harvestSleep(250)
        copyLink = Array.from(
          document.querySelectorAll('[role="menuitem"], [role="option"], li')
        ).find((el) => el.innerText && el.innerText.toLowerCase().includes('copy link'))
      }
      if (!copyLink) {
        document.body.click()
        return { error: 'copy link not found' }
      }
      copyLink.click()

      let href = null
      for (let i = 0; i < 20 && !href; i++) {
        await harvestSleep(250)
        href = harvestToastLinks().find((h) => before.indexOf(h) === -1) || null
      }

      document.body.click()
      await harvestSleep(300)

      return href ? { url: harvestUnwrapSafetyUrl(href) } : { error: 'no toast link found' }
    } catch (e) {
      return { error: e.message }
    }
  }

  // ============================================================
  // Page content extraction
  // ============================================================

  function getPageContent(format) {
    const result = {
      url: window.location.href,
      title: document.title,
    }

    if (format === 'html') {
      result.content = document.documentElement.outerHTML
    } else if (format === 'metadata') {
      result.content = ''
      result.metadata = extractMetadata()
    } else {
      result.content = extractReadableText()
      result.metadata = extractMetadata()
    }

    return result
  }

  function extractReadableText() {
    const clone = document.body.cloneNode(true)
    const removeSelectors = [
      'script', 'style', 'noscript', 'iframe', 'svg',
      'nav', 'footer', 'header',
      '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
      '.cookie-banner', '.cookie-consent', '#cookie-notice',
      '.ad', '.ads', '.advertisement', '[class*="sidebar"]',
      '[aria-hidden="true"]',
    ]
    removeSelectors.forEach(sel => {
      clone.querySelectorAll(sel).forEach(el => el.remove())
    })

    const mainContent = clone.querySelector(
      'main, article, [role="main"], .post-content, .article-content, .entry-content, #content'
    )

    const source = mainContent || clone
    let text = source.innerText || source.textContent || ''

    text = text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n')

    if (text.length > 50000) {
      text = text.slice(0, 50000) + '\n\n[Content truncated at 50,000 characters]'
    }

    return text
  }

  function extractMetadata() {
    const meta = {}

    const metaTags = document.querySelectorAll('meta[name], meta[property]')
    metaTags.forEach(tag => {
      const key = tag.getAttribute('name') || tag.getAttribute('property')
      const value = tag.getAttribute('content')
      if (key && value) meta[key] = value
    })

    const canonical = document.querySelector('link[rel="canonical"]')
    if (canonical) meta.canonical = canonical.getAttribute('href')

    meta.lang = document.documentElement.lang || undefined

    const headings = []
    document.querySelectorAll('h1, h2, h3').forEach(h => {
      const text = h.textContent?.trim()
      if (text) headings.push({ level: parseInt(h.tagName[1]), text })
    })
    if (headings.length > 0) meta.headings = headings

    meta.linkCount = document.querySelectorAll('a[href]').length
    meta.imageCount = document.querySelectorAll('img').length

    return meta
  }

  // ============================================================
  // Element extraction
  // ============================================================

  function extractElements(selector, attributes, limit) {
    if (!selector) return { error: 'selector is required' }

    try {
      const elements = document.querySelectorAll(selector)
      const maxItems = Math.min(limit || 100, 500)
      const results = []

      for (let i = 0; i < Math.min(elements.length, maxItems); i++) {
        const el = elements[i]
        const item = {
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().slice(0, 500),
          index: i,
        }

        if (attributes && Array.isArray(attributes)) {
          item.attributes = {}
          attributes.forEach(attr => {
            const val = el.getAttribute(attr)
            if (val !== null) item.attributes[attr] = val
          })
        } else {
          item.attributes = {}
          ;['href', 'src', 'class', 'id', 'type', 'name', 'value', 'aria-label'].forEach(attr => {
            const val = el.getAttribute(attr)
            if (val !== null) item.attributes[attr] = val
          })
        }

        results.push(item)
      }

      return { count: elements.length, elements: results }
    } catch (e) {
      return { error: `Invalid selector: ${e.message}` }
    }
  }

  // ============================================================
  // Element interaction
  // ============================================================

  function clickElement(selector) {
    if (!selector) return { error: 'selector is required' }

    try {
      const el = document.querySelector(selector)
      if (!el) return { error: `Element not found: ${selector}` }

      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.click()
      return { clicked: true, tag: el.tagName.toLowerCase() }
    } catch (e) {
      return { error: e.message }
    }
  }

  function fillInput(selector, value, submit) {
    if (!selector) return { error: 'selector is required' }
    if (value === undefined || value === null) return { error: 'value is required' }

    try {
      const el = document.querySelector(selector)
      if (!el) return { error: `Element not found: ${selector}` }

      el.focus()

      if (el.contentEditable === 'true') {
        el.innerHTML = ''
        document.execCommand('insertText', false, String(value))
        el.dispatchEvent(new Event('input', { bubbles: true }))
      } else {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        )?.set || Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        )?.set

        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(el, String(value))
        } else {
          el.value = String(value)
        }

        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }

      if (submit) {
        const form = el.closest('form')
        if (form) {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        }
      }

      return { filled: true, tag: el.tagName.toLowerCase() }
    } catch (e) {
      return { error: e.message }
    }
  }

  // ============================================================
  // LinkedIn-specific handlers (backwards compat)
  // ============================================================

  async function handleLinkedInComment(data) {
    let comment = data.comment
    if (data.commentBase64) {
      comment = decodeURIComponent(escape(atob(data.commentBase64)))
    }
    if (!comment) return { error: 'No comment text provided' }

    const commentBtn = findBySelectors([
      'button.comment-button',
      'button[aria-label*="Comment"]',
      'button[aria-label*="comment"]',
    ]) || findButtonByText('comment')

    if (commentBtn) {
      commentBtn.click()
      await wait(1500)
    }

    const editor = await waitForElement([
      'div.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
    ], 10000)

    if (!editor) return { error: 'Could not find comment editor' }

    editor.focus()
    await wait(300)
    editor.innerHTML = ''
    await wait(100)
    insertTextWithLineBreaks(editor, comment)
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    editor.dispatchEvent(new Event('change', { bubbles: true }))
    await wait(500)

    const submitBtn = await waitForClickable([
      'button.comments-comment-box__submit-button',
      'button.comments-comment-box__submit-button--cr',
    ], 8000)

    if (submitBtn) {
      await wait(500)
      submitBtn.click()
      return { success: true, action: 'comment_posted' }
    }

    return { success: false, action: 'comment_typed', message: 'Comment typed but submit button not found' }
  }

  function base64ToFile(base64, filename) {
    const arr = base64.split(',')
    const mime = arr[0].match(/:(.*?);/)?.[1] || 'image/png'
    const bstr = atob(arr.length > 1 ? arr[1] : arr[0])
    const n = bstr.length
    const u8arr = new Uint8Array(n)
    for (let i = 0; i < n; i++) u8arr[i] = bstr.charCodeAt(i)
    return new File([u8arr], filename, { type: mime })
  }

  async function handleLinkedInPost(data) {
    let text = data.text || data.content
    if (data.textBase64 || data.contentBase64) {
      text = decodeURIComponent(escape(atob(data.textBase64 || data.contentBase64)))
    }
    if (!text) return { error: 'No post text provided' }

    const startBtn = document.querySelector(
      'button.share-box-feed-entry__trigger, button[aria-label*="Start a post"]'
    ) || findStartPostButton()
    if (startBtn) {
      startBtn.click()
      await wait(2000)
    }

    if (data.imageBase64) {
      try {
        const imageBtn = findBySelectors([
          'button[aria-label="Add a photo"]',
          'button[aria-label="Add media"]',
          'button[aria-label*="photo"]',
          'button[aria-label*="image"]',
        ])

        if (imageBtn) {
          imageBtn.click()
          await wait(1500)
        }

        const fileInput = await waitForElement([
          'input[type="file"][accept*="image"]',
          'input[type="file"]',
        ], 3000)

        if (fileInput) {
          const file = base64ToFile(data.imageBase64, 'linkedin-post-image.png')
          const dt = new DataTransfer()
          dt.items.add(file)
          fileInput.files = dt.files
          fileInput.dispatchEvent(new Event('change', { bubbles: true }))
          await wait(3000)
        }
      } catch (e) {
        console.warn('[Orca Bridge] Image upload failed:', e.message)
      }
    }

    const editor = await waitForElement([
      'div.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"][aria-label*="post"]',
      'div[contenteditable="true"][data-placeholder*="want to talk about"]',
    ], 10000)

    if (!editor) return { error: 'Could not find post editor' }

    editor.focus()
    await wait(300)
    editor.innerHTML = ''
    await wait(100)
    insertTextWithLineBreaks(editor, text)
    editor.dispatchEvent(new Event('input', { bubbles: true }))

    // Click the Post button automatically
    await wait(1000)
    const postBtn = deepQuery('button.share-actions__primary-action')
    if (postBtn && !postBtn.disabled) {
      postBtn.click()
      return { success: true, action: 'post_submitted' }
    }

    return {
      success: true,
      action: 'post_ready',
      message: data.imageBase64
        ? 'Post text and image entered. Ready for manual review.'
        : 'Post text entered. Ready for manual review.',
    }
  }

  // ============================================================
  // LinkedIn messaging handlers (inbox triage)
  //
  // These run in a BACKGROUND tab — nothing here may assume window focus.
  // Selectors are fallback arrays because LinkedIn's DOM rots without notice;
  // when all fallbacks miss, return a structured error so the scheduler's
  // health manager can back off and eventually alert.
  // ============================================================

  const LI_CONVO_ITEM_SELECTORS = [
    'li.msg-conversation-listitem',
    '.msg-conversations-container__convo-item',
    'li[class*="conversation-listitem"]',
  ]
  const LI_CONVO_LINK_SELECTORS = [
    'a.msg-conversation-listitem__link',
    'a[href*="/messaging/thread/"]',
  ]
  const LI_COMPOSE_SELECTORS = [
    'div.msg-form__contenteditable[contenteditable="true"]',
    'form.msg-form div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][aria-label*="message"]',
  ]
  const LI_SEND_BTN_SELECTORS = [
    'button.msg-form__send-button',
    'form.msg-form button[type="submit"]',
    'button[class*="msg-form__send"]',
  ]

  function extractThreadUrn(href) {
    // hrefs look like /messaging/thread/2-MTIzNDU2Nzg5…==/ — the segment IS the id
    const m = (href || '').match(/\/messaging\/thread\/([^/?#]+)/)
    return m ? decodeURIComponent(m[1]) : null
  }

  // The signed-in account's display name, for message direction attribution.
  function linkedinOwnName() {
    const img = document.querySelector('img.global-nav__me-photo, .global-nav__me img')
    return img?.getAttribute('alt')?.trim() || null
  }

  // Structural report used when the conversation list can't be found, so the
  // desktop surfaces the REAL DOM shape instead of us guessing selectors.
  function linkedinMessagingDiagnostics() {
    const sel = (s) => document.querySelectorAll(s).length
    const diag = {
      url: location.href,
      threadLinks: sel('a[href*="/messaging/thread/"]'),
      liItems: sel('li.msg-conversation-listitem'),
      convItemsAlt: sel('[class*="conversation-listitem"]'),
      convCards: sel('[class*="conversation-card"]'),
      listContainers: sel('[class*="conversations-container"]'),
      ariaListboxes: sel('[role="listbox"], [role="list"]'),
      msgOverlay: sel('[class*="msg-overlay"]'),
    }
    // Sample the class names of the first few list-ish <li>/<a> so we can see
    // the current markup vocabulary.
    const sample = []
    document.querySelectorAll('a[href*="/messaging/thread/"]').forEach((a, i) => {
      if (i >= 3) return
      const li = a.closest('li') || a.parentElement
      sample.push({
        aClass: a.className.slice(0, 200),
        liTag: li ? li.tagName : null,
        liClass: li ? li.className.slice(0, 200) : null,
      })
    })
    diag.sample = sample
    return diag
  }

  const LI_ITEM_SELECTOR = 'li.msg-conversation-listitem, [class*="conversation-listitem"]'

  // This LinkedIn build exposes NO thread id on the list items (only Ember view
  // ids) — the real 2-<base64>== id only appears in the URL after a conversation
  // is opened. So conversations are identified by participant name; the real
  // thread id is captured from the URL at read time and kept in source_data.
  function itemDisplayName(item) {
    const h3 = findWithin(item, [
      '.msg-conversation-listitem__participant-names',
      '.msg-conversation-card__participant-names',
      '[class*="participant-names"]',
      'h3',
    ])
    const fromH3 = h3?.textContent?.trim()
    if (fromH3) return fromH3
    const img = item.querySelector('img[alt]')
    return img?.getAttribute('alt')?.trim() || ''
  }

  function slugName(name) {
    return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  }

  function itemClickTarget(item) {
    return item.querySelector(
      '.msg-conversation-card__content--selectable, .msg-conversation-listitem__link, [role="link"], a'
    ) || item
  }

  async function linkedinListConversations(limit, unreadOnly) {
    if (!location.pathname.startsWith('/messaging')) {
      return { error: 'Not on the messaging page', url: location.href }
    }
    const maxItems = Math.min(limit || 25, 100)

    const first = await waitForElement([LI_ITEM_SELECTOR], 12000)
    if (!first) {
      return {
        error: 'LinkedIn conversation list not found (no list items rendered)',
        diagnostics: linkedinMessagingDiagnostics(),
      }
    }

    const ownFirst = (linkedinOwnName() || '').trim().split(/\s+/)[0].toLowerCase()
    const items = Array.from(document.querySelectorAll(LI_ITEM_SELECTOR))
    const conversations = []
    const seenSlugs = new Set()

    for (const item of items) {
      if (conversations.length >= maxItems) break
      const name = itemDisplayName(item)
      const slug = slugName(name)
      if (!slug || seenSlugs.has(slug)) continue

      const snippet = findWithin(item, [
        '.msg-conversation-card__message-snippet',
        '[class*="message-snippet"]',
        'p',
      ])?.textContent?.trim() || ''

      // The snippet is prefixed with the last sender ("You: ..." / "Jay: ...").
      // If the last message is Chris's, the conversation is already handled.
      const lastFromMe = /^\s*you\s*:/i.test(snippet) ||
        (!!ownFirst && new RegExp('^\\s*' + ownFirst + '\\s*:', 'i').test(snippet))

      const timeEl = findWithin(item, ['time'])
      const unread =
        /unread/i.test(item.className) ||
        !!item.querySelector('.notification-badge, [class*="unread"]')

      if (unreadOnly && !unread) continue

      seenSlugs.add(slug)
      conversations.push({
        conversation_urn: slug,
        sender_name: name,
        snippet: snippet.slice(0, 300),
        last_from_me: lastFromMe,
        time_text: timeEl?.textContent?.trim() || '',
        time_attr: timeEl?.getAttribute('datetime') || null,
        unread,
      })
    }

    if (conversations.length === 0 && items.length > 0) {
      return {
        error: `${items.length} list items found but no participant names extracted`,
        diagnostics: { itemCount: items.length, firstItemHtml: items[0].outerHTML.slice(0, 2500) },
      }
    }

    return { count: conversations.length, total_items: items.length, conversations }
  }

  async function linkedinOpenThread(conversationUrn) {
    // SPA-open by clicking the list item whose participant name matches the
    // slug (no thread id exists on the items). Never navigate the tab.
    const items = document.querySelectorAll(LI_ITEM_SELECTOR)
    for (const item of items) {
      if (slugName(itemDisplayName(item)) === conversationUrn) {
        itemClickTarget(item).click()
        await jitter(1200, 2200)
        return true
      }
    }
    return false
  }

  async function linkedinReadThread(conversationUrn, lastN) {
    if (!conversationUrn) return { error: 'conversationUrn is required' }
    const maxItems = Math.min(lastN || 10, 50)

    const opened = await linkedinOpenThread(conversationUrn)
    if (!opened) return { error: `Conversation not found in list: ${conversationUrn}` }

    const firstEvent = await waitForElement([
      'li.msg-s-message-list__event',
      '.msg-s-event-listitem',
      '[class*="event-listitem"]',
    ], 8000)
    if (!firstEvent) return { error: 'Thread messages not found (DOM change or thread failed to load)' }

    const ownName = linkedinOwnName()
    const events = document.querySelectorAll('li.msg-s-message-list__event, .msg-s-event-listitem')
    const messages = []
    // Sender names come from message-group headers; consecutive messages from the
    // same sender omit the header, so carry the last seen name forward.
    let currentSender = null

    for (const ev of events) {
      const nameEl = ev.querySelector('.msg-s-message-group__name, [class*="message-group__name"]')
      if (nameEl) currentSender = nameEl.textContent?.trim() || currentSender

      const bodyEl = ev.querySelector('.msg-s-event-listitem__body, [class*="event-listitem__body"]')
      // innerText preserves line breaks between paragraphs/sentences; textContent
      // runs them together ("for it.Good to be connected").
      const text = (bodyEl?.innerText || bodyEl?.textContent || '').trim()
      if (!text) continue

      const timeEl = ev.querySelector('time')
      messages.push({
        sender_name: currentSender || '',
        direction: ownName && currentSender === ownName ? 'me' : 'them',
        text: text.slice(0, 2000),
        time_text: timeEl?.textContent?.trim() || '',
        time_attr: timeEl?.getAttribute('datetime') || null,
      })
    }

    // Sender profile URL from the thread header, when present
    const profileLink = document.querySelector(
      '.msg-thread a[href*="/in/"], .msg-title-bar a[href*="/in/"], .msg-entity-lockup a[href*="/in/"]'
    )

    // Now that the thread is open, the URL carries LinkedIn's real thread id —
    // capture it for the record (kept in source_data; the send path opens by
    // participant name, so this is reference only).
    const capturedThreadId = extractThreadUrn(location.pathname)

    return {
      conversation_urn: conversationUrn,
      captured_thread_id: capturedThreadId,
      own_name: ownName,
      sender_profile_url: profileLink?.href || null,
      messageCount: messages.length,
      messages: messages.slice(-maxItems),
    }
  }

  // Structural report for the compose area, used when send fails, so the real
  // DOM shape is surfaced instead of guessing selectors.
  function linkedinComposeDiagnostics() {
    const form = document.querySelector('form.msg-form, .msg-form')
    const btns = []
    if (form) {
      form.querySelectorAll('button').forEach((b) => {
        if (btns.length < 8) btns.push({ text: (b.textContent || '').trim().slice(0, 30), class: b.className.slice(0, 120), disabled: b.disabled })
      })
    }
    return {
      contentEditableCount: document.querySelectorAll('[contenteditable="true"]').length,
      msgFormPresent: !!form,
      buttons: btns,
      formHtml: form ? form.outerHTML.slice(0, 2000) : null,
    }
  }

  async function linkedinSendDm(conversationUrn, textBase64) {
    if (!conversationUrn) return { error: 'conversationUrn is required' }
    let text = ''
    if (textBase64) text = decodeURIComponent(escape(atob(textBase64)))
    if (!text) return { error: 'No message text provided' }

    const opened = await linkedinOpenThread(conversationUrn)
    if (!opened) return { error: `Conversation not found in list: ${conversationUrn}` }

    const compose = await waitForElement(LI_COMPOSE_SELECTORS, 8000)
    if (!compose) {
      return { success: false, error: 'Could not find message compose box', diagnostics: linkedinComposeDiagnostics() }
    }

    // Human-shaped step jitter. The LARGE pre-send delay (5-45s) lives in the
    // desktop job before this command is issued — the bridge's 30s command
    // timeout means everything in here must stay well under that.
    compose.focus()
    await jitter(400, 1200)
    // Clear any existing content the way the editor expects.
    document.execCommand('selectAll', false, null)
    document.execCommand('delete', false, null)
    await jitter(150, 400)
    document.execCommand('insertText', false, text)
    compose.dispatchEvent(new Event('input', { bubbles: true }))
    compose.dispatchEvent(new Event('change', { bubbles: true }))
    await jitter(600, 1800)

    const typed = (compose.innerText || compose.textContent || '').trim()
    if (!typed) {
      return { success: false, error: 'Text did not register in the compose box', diagnostics: linkedinComposeDiagnostics() }
    }

    const sendBtn = await waitForClickable(LI_SEND_BTN_SELECTORS, 4000)
    if (!sendBtn) {
      return { success: false, action: 'message_typed', error: 'Message typed but send button not found', diagnostics: linkedinComposeDiagnostics() }
    }
    if (sendBtn.disabled) {
      return { success: false, action: 'message_typed', error: 'Send button is disabled (text may not have registered with the editor)', diagnostics: linkedinComposeDiagnostics() }
    }
    await jitter(300, 900)
    sendBtn.click()
    await jitter(900, 1500)

    // Verify: LinkedIn clears the compose box after a successful send. If our
    // text is still there, the click did not send.
    const still = (compose.innerText || compose.textContent || '').trim()
    if (still && still.includes(text.slice(0, 20))) {
      return { success: false, action: 'send_clicked_but_not_sent', error: 'Clicked send but the message is still in the box', diagnostics: linkedinComposeDiagnostics() }
    }

    return { success: true, action: 'message_sent', conversation_urn: conversationUrn }
  }

  // ============================================================
  // DOM helpers
  // ============================================================

  function findBySelectors(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel)
      if (el) return el
    }
    return null
  }

  function findWithin(root, selectors) {
    for (const sel of selectors) {
      const el = root.querySelector(sel)
      if (el) return el
    }
    return null
  }

  // Randomised wait — automation steps must not tick like a metronome.
  function jitter(minMs, maxMs) {
    return wait(minMs + Math.floor(Math.random() * (maxMs - minMs)))
  }

  function findStartPostButton() {
    const all = document.querySelectorAll('div[role="button"]')
    for (const el of all) {
      if (el.textContent.trim() === 'Start a post') return el
    }
    return null
  }

  function findButtonByText(text) {
    const buttons = document.querySelectorAll('button')
    const lower = text.toLowerCase()
    for (const btn of buttons) {
      const span = btn.querySelector('span')
      if (span && span.textContent.trim().toLowerCase() === lower) return btn
      if (btn.textContent.trim().toLowerCase() === lower) return btn
    }
    return null
  }

  // Insert text with proper line breaks into a Quill/contenteditable editor.
  // document.execCommand('insertText') treats \n as whitespace in Quill,
  // so we insert each line separately with explicit <br> between them.
  function insertTextWithLineBreaks(editor, text) {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        document.execCommand('insertLineBreak', false, null)
      }
      if (lines[i].length > 0) {
        document.execCommand('insertText', false, lines[i])
      }
    }
  }

  // Traverse shadow DOM to find elements LinkedIn hides in web components
  function deepQuery(selector) {
    const el = document.querySelector(selector)
    if (el) return el
    const walk = (root) => {
      for (const node of root.querySelectorAll('*')) {
        if (node.shadowRoot) {
          const found = node.shadowRoot.querySelector(selector)
          if (found) return found
          const deeper = walk(node.shadowRoot)
          if (deeper) return deeper
        }
      }
      return null
    }
    return walk(document)
  }

  async function waitForElement(selectors, timeoutMs) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      for (const sel of selectors) {
        const el = deepQuery(sel)
        if (el) return el
      }
      await wait(300)
    }
    return null
  }

  async function waitForClickable(selectors, timeoutMs) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      for (const sel of selectors) {
        const el = deepQuery(sel)
        if (el && !el.disabled) return el
      }
      await wait(300)
    }
    return findBySelectors(selectors)
  }

  function wait(ms) {
    return new Promise(r => setTimeout(r, ms))
  }

  // ============================================================
  // Page-world bridge (allows chrome-control / osascript to
  // trigger extension actions via window.postMessage)
  // ============================================================
  // WhatsApp Web handlers
  // ============================================================

  function whatsappListChats(limit) {
    const maxItems = Math.min(limit || 30, 100)
    const chatGrid = document.querySelector('div[aria-label="Chat list"]')
    if (!chatGrid) return { error: 'WhatsApp chat list not found. Is WhatsApp Web open?' }

    const rows = chatGrid.querySelectorAll('[role="row"]')
    const chats = []

    for (let i = 0; i < Math.min(rows.length, maxItems); i++) {
      const row = rows[i]
      const nameSpan = row.querySelector('span[title]')
      if (!nameSpan) continue

      const name = nameSpan.getAttribute('title')

      // Last message preview: second span[title] or the last text snippet
      const allTitled = row.querySelectorAll('span[title]')
      let lastMessage = ''
      if (allTitled.length > 1) {
        lastMessage = allTitled[allTitled.length - 1].getAttribute('title') || ''
      }

      // Timestamp
      const timeEl = row.querySelector('div[class*="chat"] > div > div:last-child') ||
                     row.querySelector('[data-pre-plain-text]')
      let timestamp = ''
      // Look for small text that's typically the time
      const smallTexts = row.querySelectorAll('div')
      for (const div of smallTexts) {
        const t = div.textContent?.trim()
        if (t && /^\d{1,2}:\d{2}/.test(t) || /^Yesterday/.test(t) || /^\d{1,2}\/\d{1,2}\/\d{4}/.test(t) || /^Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/.test(t)) {
          timestamp = t
          break
        }
      }

      // Unread badge
      const badge = row.querySelector('span[aria-label*="unread"]')
      const unread = badge ? parseInt(badge.textContent) || 1 : 0

      // Muted indicator
      const muted = !!row.querySelector('div[aria-label="Muted chat"]')

      chats.push({ name, lastMessage: lastMessage.slice(0, 200), timestamp, unread, muted })
    }

    return { count: chats.length, chats }
  }

  async function handleWhatsAppOpenChat(recipient) {
    if (!recipient) return { error: 'recipient is required' }

    // Find and clear the search box
    const searchInput = document.querySelector('input[aria-label="Search or start a new chat"]')
    if (!searchInput) return { error: 'WhatsApp search box not found' }

    searchInput.focus()
    await wait(300)

    // Clear existing search
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    if (nativeSetter) {
      nativeSetter.call(searchInput, '')
    } else {
      searchInput.value = ''
    }
    searchInput.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(300)

    // Type the recipient name
    if (nativeSetter) {
      nativeSetter.call(searchInput, recipient)
    } else {
      searchInput.value = recipient
    }
    searchInput.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(1500) // Wait for search results

    // Find matching result in the chat list
    const rows = document.querySelectorAll('[role="listitem"], [role="row"]')
    let matched = null
    const recipientLower = recipient.toLowerCase()

    for (const row of rows) {
      const nameSpan = row.querySelector('span[title]')
      if (nameSpan) {
        const name = nameSpan.getAttribute('title')?.toLowerCase() || ''
        if (name.includes(recipientLower) || recipientLower.includes(name)) {
          matched = row
          break
        }
      }
    }

    if (!matched) {
      // Clear search
      const clearBtn = document.querySelector('button[aria-label="Cancel search"]') ||
                       document.querySelector('button[aria-label="Back"]')
      if (clearBtn) clearBtn.click()
      return { error: `No chat found for "${recipient}"` }
    }

    matched.click()
    await wait(1000)

    // Verify conversation opened by checking for compose box
    const compose = await waitForElement([
      'div[contenteditable="true"][role="textbox"]',
      'footer div[contenteditable="true"]',
      'div[title="Type a message"]',
    ], 3000)

    // Clear search after opening
    const clearBtn = document.querySelector('button[aria-label="Cancel search"]') ||
                     document.querySelector('button[aria-label="Back"]')
    if (clearBtn) clearBtn.click()

    return {
      success: true,
      opened: !!compose,
      recipient: matched.querySelector('span[title]')?.getAttribute('title') || recipient,
    }
  }

  async function handleWhatsAppSendMessage(recipient, messageBase64) {
    let message = ''
    if (messageBase64) {
      message = decodeURIComponent(escape(atob(messageBase64)))
    }
    if (!message) return { error: 'No message text provided' }

    // If recipient specified, open that chat first
    if (recipient) {
      const openResult = await handleWhatsAppOpenChat(recipient)
      if (openResult.error) return openResult
      await wait(500)
    }

    // Find the compose box
    const compose = await waitForElement([
      'div[contenteditable="true"][role="textbox"]',
      'footer div[contenteditable="true"]',
      'div[title="Type a message"]',
    ], 5000)

    if (!compose) return { error: 'Cannot find WhatsApp message input. Is a conversation open?' }

    compose.focus()
    await wait(300)

    // Clear and type the message
    compose.innerHTML = ''
    await wait(100)

    // Use insertText for React/WhatsApp compatibility
    document.execCommand('insertText', false, message)
    compose.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(500)

    // Find and click send button
    const sendBtn = await waitForClickable([
      'button[aria-label="Send"]',
      'span[data-icon="send"]',
    ], 3000)

    if (sendBtn) {
      // If we matched the icon rather than the button, click parent button
      const btn = sendBtn.closest('button') || sendBtn
      btn.click()
      await wait(500)
      return { success: true, action: 'message_sent', recipient: recipient || 'current chat' }
    }

    return { success: false, action: 'message_typed', message: 'Message typed but send button not found. It may need manual send.' }
  }

  function whatsappReadMessages(limit) {
    const maxItems = Math.min(limit || 50, 200)

    // Check we're in a conversation
    const header = document.querySelector('header')
    let conversationName = ''
    if (header) {
      const nameSpan = header.querySelector('span[title]')
      if (nameSpan) conversationName = nameSpan.getAttribute('title') || ''
    }

    // Find message containers
    const msgIn = document.querySelectorAll('.message-in, [class*="message-in"]')
    const msgOut = document.querySelectorAll('.message-out, [class*="message-out"]')

    // If no class-based messages found, try role-based
    let allMessages = []

    if (msgIn.length > 0 || msgOut.length > 0) {
      // Collect all messages with direction
      const all = document.querySelectorAll('.message-in, .message-out, [class*="message-in"], [class*="message-out"]')
      for (let i = Math.max(0, all.length - maxItems); i < all.length; i++) {
        const el = all[i]
        const isIncoming = el.classList.contains('message-in') || el.className.includes('message-in')
        const textEl = el.querySelector('[class*="selectable-text"]') || el.querySelector('span[dir="ltr"]')
        const text = textEl?.textContent?.trim() || ''
        if (!text) continue

        // Timestamp
        const timeEl = el.querySelector('[data-pre-plain-text]')
        const timestamp = timeEl?.getAttribute('data-pre-plain-text')?.trim() || ''

        allMessages.push({
          direction: isIncoming ? 'incoming' : 'outgoing',
          text: text.slice(0, 1000),
          timestamp,
        })
      }
    } else {
      // Fallback: try to get messages from rows
      const rows = document.querySelectorAll('[role="row"]')
      for (let i = Math.max(0, rows.length - maxItems); i < rows.length; i++) {
        const row = rows[i]
        const textSpan = row.querySelector('span[dir="ltr"]')
        if (textSpan) {
          allMessages.push({
            direction: 'unknown',
            text: textSpan.textContent?.trim().slice(0, 1000) || '',
            timestamp: '',
          })
        }
      }
    }

    return {
      conversation: conversationName,
      messageCount: allMessages.length,
      messages: allMessages,
    }
  }

  function whatsappCheckUnread() {
    const chatGrid = document.querySelector('div[aria-label="Chat list"]')
    if (!chatGrid) return { error: 'WhatsApp chat list not found' }

    const badges = chatGrid.querySelectorAll('span[aria-label*="unread"]')
    const unreadChats = []

    badges.forEach(badge => {
      const count = parseInt(badge.textContent) || 1
      // Walk up to find the chat name
      const row = badge.closest('[role="row"]')
      if (row) {
        const nameSpan = row.querySelector('span[title]')
        const name = nameSpan?.getAttribute('title') || 'Unknown'
        unreadChats.push({ name, unread: count })
      }
    })

    const totalUnread = unreadChats.reduce((sum, c) => sum + c.unread, 0)

    return {
      totalUnread,
      chatCount: unreadChats.length,
      chats: unreadChats,
    }
  }

  // ============================================================

  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    if (!event.data || event.data.source !== 'orca-bridge-page') return

    const { action, ...params } = event.data

    const respond = (result) => {
      window.postMessage({ source: 'orca-bridge-content', action, ...result }, '*')
    }

    switch (action) {
      case 'orca-create-post':
        handleLinkedInPost(params).then(respond)
        break
      case 'orca-post-comment':
        handleLinkedInComment(params).then(respond)
        break
      default:
        respond({ error: `Unknown bridge action: ${action}` })
    }
  })
})()
