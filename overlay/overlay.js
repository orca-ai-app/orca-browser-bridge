/**
 * Orca Contextual Intelligence Overlay
 *
 * Detects page context (LinkedIn profiles, company websites) and surfaces
 * CRM data, relationship history, and Orca knowledge in a floating panel.
 * Quick capture (Cmd+Shift+O) indexes any page into semantic memory.
 */

;(function () {
  'use strict'

  if (window.__orcaOverlayLoaded) return
  window.__orcaOverlayLoaded = true

  // Skip chrome:// and extension pages
  if (window.location.protocol === 'chrome:' || window.location.protocol === 'chrome-extension:') return

  let panelOpen = false
  let currentContext = null
  let contactData = null
  let host, shadow, fab, panel

  // ============================================================
  // Initialisation
  // ============================================================

  async function init() {
    host = document.createElement('div')
    host.id = 'orca-overlay-host'
    // No 'all: initial' -- shadow DOM provides style isolation. The host just needs
    // to exist in the DOM; all visual elements are position:fixed inside the shadow.
    host.style.cssText = 'position: static; display: block; width: 0; height: 0; overflow: visible; pointer-events: none;'
    document.body.appendChild(host)

    shadow = host.attachShadow({ mode: 'closed' })

    // Load CSS into shadow DOM
    try {
      const cssText = await (await fetch(chrome.runtime.getURL('overlay/overlay.css'))).text()
      const style = document.createElement('style')
      style.textContent = cssText
      shadow.appendChild(style)
    } catch {
      // Extension context unavailable
      return
    }

    createFab()
    createPanel()

    // Detect context after a short delay for page rendering
    setTimeout(detectContext, 800)
    observeNavigation()

    // Listen for quick capture command from background
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.action === 'orca_show_capture') showCaptureModal()
    })

    // Keyboard shortcut fallback (in case chrome.commands doesn't fire)
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault()
        showCaptureModal()
      }
    })
  }

  // ============================================================
  // FAB (floating action button)
  // ============================================================

  function createFab() {
    fab = document.createElement('div')
    fab.className = 'orca-fab'
    fab.style.pointerEvents = 'auto'
    fab.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`
    fab.addEventListener('click', togglePanel)
    shadow.appendChild(fab)
  }

  // ============================================================
  // Panel
  // ============================================================

  function createPanel() {
    panel = document.createElement('div')
    panel.className = 'orca-panel'
    panel.style.display = 'none'
    panel.style.pointerEvents = 'auto'
    panel.innerHTML = `
      <div class="panel-header">
        <span class="panel-title">Orca Intelligence</span>
        <button class="panel-close">&times;</button>
      </div>
      <div class="panel-body">
        <div class="panel-loading">Detecting context...</div>
      </div>
    `
    panel.querySelector('.panel-close').addEventListener('click', togglePanel)
    shadow.appendChild(panel)
  }

  function togglePanel() {
    panelOpen = !panelOpen
    panel.style.display = panelOpen ? 'flex' : 'none'
    fab.classList.toggle('active', panelOpen)
    if (panelOpen) loadPanelContent()
  }

  // ============================================================
  // Context detection
  // ============================================================

  async function detectContext() {
    const hostname = window.location.hostname
    const pathname = window.location.pathname

    // LinkedIn profile
    if (hostname === 'www.linkedin.com' && pathname.startsWith('/in/')) {
      const name = extractLinkedInName()
      const headline = document.querySelector('.text-body-medium')?.textContent?.trim()
      if (name) {
        currentContext = { type: 'linkedin-profile', name, headline, url: window.location.href }
        updateFabState('detecting')
        const contacts = await sendMsg('orca_lookup_contact', { name })
        if (contacts?.length > 0) {
          contactData = contacts[0]
          updateFabState('known')
        } else {
          contactData = null
          updateFabState('new')
        }
        return
      }
    }

    // LinkedIn company page
    if (hostname === 'www.linkedin.com' && pathname.startsWith('/company/')) {
      const companyName = document.querySelector('h1')?.textContent?.trim()
      if (companyName) {
        currentContext = { type: 'company', name: companyName }
        updateFabState('detecting')
        const contacts = await sendMsg('orca_lookup_company', { company: companyName })
        if (contacts?.length > 0) {
          contactData = contacts
          updateFabState('known')
        } else {
          contactData = null
          updateFabState('none')
        }
        return
      }
    }

    // Company website (skip common non-company domains)
    const skipDomains = ['google.com', 'linkedin.com', 'github.com', 'youtube.com', 'twitter.com',
      'x.com', 'facebook.com', 'reddit.com', 'wikipedia.org', 'amazon.com', 'stackoverflow.com']
    const domain = hostname.replace('www.', '')

    if (!skipDomains.some(d => domain.includes(d))) {
      currentContext = { type: 'website', domain }
      const contacts = await sendMsg('orca_lookup_domain', { domain })
      if (contacts?.length > 0) {
        contactData = contacts
        updateFabState('known')
        return
      }
    }

    currentContext = { type: 'none' }
    contactData = null
    updateFabState('none')
  }

  function extractLinkedInName() {
    // LinkedIn uses various heading selectors across different layouts
    const selectors = [
      'h1.text-heading-xlarge',
      'h1.inline.t-24',
      '.pv-text-details__left-panel h1',
      'h1',
    ]
    for (const sel of selectors) {
      const el = document.querySelector(sel)
      const text = el?.textContent?.trim()
      if (text && text.length > 1 && text.length < 80) return cleanName(text)
    }
    return null
  }

  function cleanName(raw) {
    // Strip post-nominals: "Paddy Willis, FRSA" → "Paddy Willis"
    // Also handles: "Dr John Smith OBE", "Jane Doe (She/Her)", "Bob Jones MBA"
    const POST_NOMINALS = /[,;]\s*(FRSA|OBE|MBE|CBE|DBE|KBE|FCA|FCCA|FCMA|ACMA|CIPD|FCIPD|PhD|DPhil|MBA|MSc|BSc|BA|MA|LLB|LLM|FRS|FRICS|MRICS|CEng|MICE|MIET|CMgr|FCMI|FBCS|CITP|JP|DL|QC|KC)\b.*/gi
    let name = raw.replace(POST_NOMINALS, '')

    // Remove parenthetical suffixes: "(She/Her)", "(He/Him)", "(They/Them)"
    name = name.replace(/\s*\([^)]*\)\s*$/, '')

    // Remove trailing whitespace and commas
    name = name.replace(/[,;.\s]+$/, '').trim()

    // If the name still has a comma followed by short uppercase words, strip them
    // e.g. "Name, ACCA, FRSA" where we didn't catch all post-nominals
    if (name.includes(',')) {
      const parts = name.split(',')
      const coreName = parts[0].trim()
      // Only keep the first part if everything after the comma looks like post-nominals
      const suffix = parts.slice(1).join(',').trim()
      if (/^[A-Z\s,.]+$/.test(suffix) && suffix.length < 30) {
        name = coreName
      }
    }

    return name
  }

  function updateFabState(state) {
    fab.className = `orca-fab ${state}${panelOpen ? ' active' : ''}`
    sendMsg('orca_update_badge', { state }).catch(() => {})
  }

  // ============================================================
  // Panel content rendering
  // ============================================================

  async function loadPanelContent() {
    const body = panel.querySelector('.panel-body')

    if (!currentContext || currentContext.type === 'none') {
      body.innerHTML = renderNoContext()
      return
    }

    body.innerHTML = '<div class="panel-loading">Loading...</div>'

    if (currentContext.type === 'linkedin-profile') {
      if (contactData) {
        const [facts, briefs, insights] = await Promise.all([
          sendMsg('orca_get_facts', { contactId: contactData.id }),
          sendMsg('orca_get_briefs', { contactName: contactData.name }),
          sendMsg('orca_get_insights', { contactId: contactData.id }),
        ])
        body.innerHTML = renderContactProfile(contactData, facts || [], briefs || [], insights || [])
      } else {
        body.innerHTML = renderNewContact(currentContext.name, currentContext.headline)
      }
    } else if (currentContext.type === 'company' || currentContext.type === 'website') {
      const contacts = Array.isArray(contactData) ? contactData : []
      body.innerHTML = renderCompanyView(currentContext, contacts)
    }

    attachPanelActions(body)
  }

  function renderContactProfile(contact, facts, briefs, insights) {
    const warmthClass = contact.warmth_score >= 80 ? 'fire' :
      contact.warmth_score >= 60 ? 'hot' :
      contact.warmth_score >= 40 ? 'warm' : 'cold'

    return `
      <div class="contact-card">
        <span class="match-badge known">Known contact</span>
        <div class="contact-name">${esc(contact.name)}</div>
        <div class="contact-meta">${esc(contact.role || '')}${contact.role && contact.company ? ' at ' : ''}${esc(contact.company || '')}</div>
        <span class="stage-badge">${esc(contact.relationship_stage || 'known')}</span>
        <div class="warmth-row">
          <span class="warmth-label">Warmth</span>
          <div class="warmth-bar"><div class="warmth-fill ${warmthClass}" style="width: ${contact.warmth_score || 50}%"></div></div>
          <span class="warmth-score" style="color: ${warmthClass === 'fire' ? '#ef4444' : warmthClass === 'hot' ? '#f97316' : '#94a3b8'}">${contact.warmth_score || 50}</span>
        </div>
      </div>

      ${facts.length > 0 ? `
        <div class="section">
          <div class="section-title">Key Facts</div>
          ${facts.slice(0, 8).map(f => `
            <div class="fact-item">
              <span class="fact-key">${esc(f.fact_key)}:</span>
              <span class="fact-value">${esc(f.fact_value)}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}

      ${briefs.length > 0 ? `
        <div class="section">
          <div class="section-title">Recent Meetings</div>
          ${briefs.slice(0, 4).map(b => `
            <div class="brief-item">
              <span class="brief-title">${esc(b.title)}</span>
              <span class="brief-date">${b.meeting_date}</span>
              <span class="brief-status">${b.status}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}

      ${insights.length > 0 ? `
        <div class="section">
          <div class="section-title">Insights</div>
          ${insights.slice(0, 3).map(i => `
            <div class="insight-item">
              <div class="insight-title">${esc(i.title)}</div>
              <div class="insight-body">${esc(i.body)}</div>
            </div>
          `).join('')}
        </div>
      ` : ''}

      <div class="actions">
        <button class="action-btn" data-action="add-fact" data-contact-id="${contact.id}">Add fact</button>
        <button class="action-btn" data-action="capture">Save page</button>
      </div>
    `
  }

  function renderNewContact(name, headline) {
    return `
      <div class="contact-card">
        <span class="match-badge new-contact">New contact</span>
        <div class="contact-name">${esc(name)}</div>
        ${headline ? `<div class="contact-headline">${esc(headline)}</div>` : ''}
      </div>
      <div class="actions">
        <button class="action-btn primary" data-action="add-crm" data-name="${esc(name)}" data-headline="${esc(headline || '')}">Add to CRM</button>
        <button class="action-btn" data-action="capture">Save page</button>
      </div>
    `
  }

  function renderCompanyView(context, contacts) {
    const title = context.name || context.domain
    return `
      <div class="contact-card">
        ${contacts.length > 0
          ? `<span class="match-badge known">${contacts.length} contact${contacts.length !== 1 ? 's' : ''} known</span>`
          : `<span class="match-badge no-match">No contacts found</span>`
        }
        <div class="contact-name">${esc(title)}</div>
        ${context.domain ? `<div class="contact-meta">${esc(context.domain)}</div>` : ''}
      </div>

      ${contacts.length > 0 ? `
        <div class="section">
          <div class="section-title">People You Know</div>
          ${contacts.map(c => {
            const initials = (c.name || '??').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
            const warmthColor = c.warmth_score >= 70 ? '#f97316' : c.warmth_score >= 40 ? '#facc15' : '#64748b'
            return `
              <div class="contact-mini">
                <div class="contact-mini-avatar">${initials}</div>
                <div class="contact-mini-info">
                  <div class="contact-mini-name">${esc(c.name)}</div>
                  <div class="contact-mini-role">${esc(c.role || c.email || '')}</div>
                </div>
                <span class="contact-mini-warmth" style="color: ${warmthColor}">${c.warmth_score || 50}</span>
              </div>
            `
          }).join('')}
        </div>
      ` : ''}

      <div class="actions">
        <button class="action-btn" data-action="capture">Save page</button>
      </div>
    `
  }

  function renderNoContext() {
    return `
      <div class="no-context">
        <div class="no-context-icon">&#128269;</div>
        <div class="no-context-text">No CRM context for this page</div>
        <div class="shortcut-hint">Press <kbd>${navigator.platform.includes('Mac') ? 'Cmd' : 'Ctrl'}+Shift+O</kbd> to capture this page</div>
      </div>
      <div class="actions" style="justify-content: center;">
        <button class="action-btn" data-action="capture">Save page to Orca</button>
      </div>
    `
  }

  // ============================================================
  // Panel actions
  // ============================================================

  function attachPanelActions(container) {
    container.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const action = e.currentTarget.dataset.action

        if (action === 'capture') {
          showCaptureModal()
        }

        if (action === 'add-crm') {
          const name = e.currentTarget.dataset.name
          const headline = e.currentTarget.dataset.headline
          btn.textContent = 'Adding...'
          btn.disabled = true
          try {
            const result = await sendMsg('orca_add_contact', {
              name,
              linkedinUrl: window.location.href,
            })
            if (result?.error) throw new Error(result.error)
            contactData = Array.isArray(result) ? result[0] : result
            btn.textContent = 'Added!'
            btn.className = 'action-btn success'
            updateFabState('known')
            // Refresh panel after short delay
            setTimeout(() => loadPanelContent(), 1000)
          } catch (err) {
            btn.textContent = 'Failed'
            console.error('[Orca Overlay] Add contact failed:', err)
          }
        }

        if (action === 'add-fact') {
          const contactId = e.currentTarget.dataset.contactId
          showFactForm(container, contactId)
        }
      })
    })
  }

  function showFactForm(container, contactId) {
    // Remove existing form if any
    const existing = container.querySelector('.fact-form')
    if (existing) { existing.remove(); return }

    const form = document.createElement('div')
    form.className = 'fact-form'
    form.innerHTML = `
      <input type="text" placeholder="Fact (e.g. Prefers morning meetings)" id="orcaFactValue" />
      <div class="actions">
        <button class="action-btn primary" id="orcaSaveFact">Save</button>
        <button class="action-btn" id="orcaCancelFact">Cancel</button>
      </div>
    `

    container.appendChild(form)
    const input = form.querySelector('#orcaFactValue')
    input.focus()

    form.querySelector('#orcaCancelFact').addEventListener('click', () => form.remove())
    form.querySelector('#orcaSaveFact').addEventListener('click', async () => {
      const value = input.value.trim()
      if (!value) return
      try {
        await sendMsg('orca_add_fact', {
          contactId,
          factKey: 'note',
          factValue: value,
          category: 'general',
        })
        showToast('Fact saved')
        form.remove()
        loadPanelContent()
      } catch {
        showToast('Failed to save fact')
      }
    })

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') form.querySelector('#orcaSaveFact').click()
      if (e.key === 'Escape') form.remove()
    })
  }

  // ============================================================
  // Quick capture modal
  // ============================================================

  function showCaptureModal() {
    // Remove existing modal
    const existing = shadow.querySelector('.capture-overlay')
    if (existing) { existing.remove(); return }

    const selectedText = window.getSelection()?.toString()?.trim() || ''

    const overlay = document.createElement('div')
    overlay.className = 'capture-overlay'
    overlay.style.pointerEvents = 'auto'
    overlay.innerHTML = `
      <div class="capture-modal">
        <div class="capture-title">Save to Orca Memory</div>
        <div class="capture-url">${esc(window.location.href)}</div>
        ${selectedText ? `<div class="capture-selected">${esc(selectedText.slice(0, 300))}</div>` : ''}
        <textarea class="capture-textarea" placeholder="What's this about? (optional context)">${selectedText ? '' : ''}</textarea>
        <input class="capture-tags" type="text" placeholder="Tags (comma-separated, optional)" />
        <div class="capture-actions">
          <button class="action-btn" id="orcaCaptureCancel">Cancel</button>
          <button class="action-btn primary" id="orcaCaptureSave">Save</button>
        </div>
      </div>
    `

    shadow.appendChild(overlay)

    const textarea = overlay.querySelector('.capture-textarea')
    textarea.focus()

    overlay.querySelector('#orcaCaptureCancel').addEventListener('click', () => overlay.remove())

    // Close on background click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove()
    })

    overlay.querySelector('#orcaCaptureSave').addEventListener('click', async () => {
      const notes = textarea.value.trim()
      const tagsRaw = overlay.querySelector('.capture-tags').value.trim()
      const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : []

      const content = [
        `URL: ${window.location.href}`,
        `Title: ${document.title}`,
        selectedText ? `Selected text: ${selectedText.slice(0, 2000)}` : '',
        notes ? `Notes: ${notes}` : '',
      ].filter(Boolean).join('\n')

      const btn = overlay.querySelector('#orcaCaptureSave')
      btn.textContent = 'Saving...'
      btn.disabled = true

      try {
        await sendMsg('orca_quick_capture', {
          content,
          metadata: {
            url: window.location.href,
            title: document.title,
            tags,
            captured_at: new Date().toISOString(),
            source: 'chrome_extension',
          },
        })
        overlay.remove()
        showToast('Saved to Orca memory')
      } catch (err) {
        btn.textContent = 'Failed'
        console.error('[Orca Overlay] Capture failed:', err)
      }
    })

    // Enter to save, Escape to cancel
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') overlay.remove()
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        overlay.querySelector('#orcaCaptureSave').click()
      }
    })
  }

  // ============================================================
  // Toast notification
  // ============================================================

  function showToast(message) {
    const existing = shadow.querySelector('.orca-toast')
    if (existing) existing.remove()

    const toast = document.createElement('div')
    toast.className = 'orca-toast'
    toast.textContent = message
    toast.style.pointerEvents = 'none'
    shadow.appendChild(toast)

    setTimeout(() => toast.remove(), 2500)
  }

  // ============================================================
  // SPA navigation observer
  // ============================================================

  function observeNavigation() {
    let lastUrl = window.location.href

    // MutationObserver catches most SPA navigations
    new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href
        // Reset and re-detect
        currentContext = null
        contactData = null
        updateFabState('none')
        if (panelOpen) {
          panel.querySelector('.panel-body').innerHTML = '<div class="panel-loading">Detecting context...</div>'
        }
        setTimeout(detectContext, 1000)
      }
    }).observe(document.body, { childList: true, subtree: true })
  }

  // ============================================================
  // Helpers
  // ============================================================

  function sendMsg(type, data = {}) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, ...data }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null)
        } else {
          resolve(response)
        }
      })
    })
  }

  function esc(str) {
    if (!str) return ''
    const div = document.createElement('div')
    div.textContent = str
    return div.innerHTML
  }

  // ============================================================
  // Bootstrap
  // ============================================================

  if (document.body) {
    init()
  } else {
    document.addEventListener('DOMContentLoaded', init)
  }
})()
