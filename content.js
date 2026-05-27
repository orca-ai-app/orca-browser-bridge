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

  // Scroll to load lazy posts, then extract per-post metadata from the
  // control-menu buttons. Returns { posts: [{author_hint, context, menu_label, degree}] }.
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

        let container = btn.parentElement
        while (
          container &&
          container.tagName !== 'BODY' &&
          (!container.innerText || container.innerText.length < 150)
        ) {
          container = container.parentElement
        }
        const context =
          container && container.tagName !== 'BODY' ? container.innerText.substring(0, 600) : ''

        let deg = 'none'
        if (/·\s*1st/.test(context) || (context.indexOf(' 1st') > -1 && context.indexOf('1st connections') === -1)) deg = '1st'
        else if (/·\s*2nd/.test(context) || context.indexOf(' 2nd') > -1) deg = '2nd'
        else if (/·\s*3rd/.test(context) || context.indexOf(' 3rd') > -1) deg = '3rd+'

        posts.push({ author_hint: authorName, context, menu_label: label, degree: deg })
        if (posts.length >= 8) break
      }
      return { posts }
    } catch (e) {
      return { error: e.message, posts: [] }
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

      btn.click()
      await harvestSleep(1500)

      const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], li'))
      const copyLink = items.find(
        (el) => el.innerText && el.innerText.toLowerCase().includes('copy link')
      )
      if (!copyLink) {
        document.body.click()
        return { error: 'copy link not found' }
      }
      copyLink.click()
      await harvestSleep(1500)

      let url = null
      const toasts = document.querySelectorAll('[class*="toast"], [role="alert"]')
      for (const toast of toasts) {
        for (const link of toast.querySelectorAll('a')) {
          if (link.innerText.includes('View post')) {
            url = link.href.split('?')[0]
            break
          }
        }
        if (url) break
      }

      document.body.click()
      await harvestSleep(300)

      return url ? { url } : { error: 'no toast link found' }
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
  // DOM helpers
  // ============================================================

  function findBySelectors(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel)
      if (el) return el
    }
    return null
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
