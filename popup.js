const dot = document.getElementById('dot')
const statusText = document.getElementById('statusText')
const statusSub = document.getElementById('statusSub')
const tabInfo = document.getElementById('tabInfo')
const tabTitle = document.getElementById('tabTitle')
const tabUrl = document.getElementById('tabUrl')
const reconnectBtn = document.getElementById('reconnectBtn')
const testBtn = document.getElementById('testBtn')
const captureBtn = document.getElementById('captureBtn')
const captureNotes = document.getElementById('captureNotes')
const toast = document.getElementById('toast')
const crmContainer = document.getElementById('crmContainer')

// ============================================================
// Name cleaning (mirrors overlay.js cleanName)
// ============================================================

function cleanName(raw) {
  const POST_NOMINALS = /[,;]\s*(FRSA|OBE|MBE|CBE|DBE|KBE|FCA|FCCA|FCMA|ACMA|CIPD|FCIPD|PhD|DPhil|MBA|MSc|BSc|BA|MA|LLB|LLM|FRS|FRICS|MRICS|CEng|MICE|MIET|CMgr|FCMI|FBCS|CITP|JP|DL|QC|KC)\b.*/gi
  let name = raw.replace(POST_NOMINALS, '')
  name = name.replace(/\s*\([^)]*\)\s*$/, '')
  name = name.replace(/[,;.\s]+$/, '').trim()
  if (name.includes(',')) {
    const parts = name.split(',')
    const coreName = parts[0].trim()
    const suffix = parts.slice(1).join(',').trim()
    if (/^[A-Z\s,.]+$/.test(suffix) && suffix.length < 30) name = coreName
  }
  return name
}

function esc(str) {
  if (!str) return ''
  const div = document.createElement('span')
  div.textContent = str
  return div.innerHTML
}

// ============================================================
// Fact key humanisation
// ============================================================

function humaniseFactKey(key) {
  // Known mappings
  const MAP = {
    'role': 'Role',
    'company': 'Company',
    'which_business': 'Business',
    'relationship_context': 'Context',
    'communication_style': 'Comms style',
    'meeting_preference': 'Meetings',
    'interests': 'Interests',
    'location': 'Location',
    'phone': 'Phone',
    'notes': 'Notes',
    'note': 'Note',
  }
  const lower = key.toLowerCase()
  if (MAP[lower]) return MAP[lower]

  // Alt email keys like "alt_email_paddy@foo.com" -> skip (handled separately)
  if (lower.startsWith('alt_email_')) return null

  // Generic: replace underscores, title case
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

function extractAltEmails(facts) {
  return facts
    .filter(f => f.fact_key.toLowerCase().startsWith('alt_email_'))
    .map(f => f.fact_value)
}

function getNonEmailFacts(facts) {
  return facts.filter(f => !f.fact_key.toLowerCase().startsWith('alt_email_'))
}

// ============================================================
// Connection status (compact)
// ============================================================

function updateUI(status) {
  dot.className = 'status-dot ' + (status.connected ? 'connected' : status.state === 'connecting' ? 'connecting' : 'disconnected')
  statusText.textContent = status.connected ? 'Connected' : status.state === 'connecting' ? 'Connecting...' : 'Disconnected'
  statusSub.textContent = ''
}

function loadStatus() {
  chrome.runtime.sendMessage({ type: 'get_status' }, (response) => {
    if (response) updateUI(response)
  })
}

// Listen for status broadcasts from background (fires on every state change)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status_changed') {
    updateUI(msg)
  }
})

// ============================================================
// Send message to background (returns promise)
// ============================================================

function sendMsg(type, data = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...data }, (response) => {
      if (chrome.runtime.lastError) resolve(null)
      else resolve(response)
    })
  })
}

// ============================================================
// CRM data loading
// ============================================================

chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
  if (!tabs[0]) return

  tabInfo.style.display = 'block'
  tabTitle.textContent = tabs[0].title || 'Untitled'
  tabUrl.textContent = tabs[0].url || ''

  try {
    const url = new URL(tabs[0].url)
    const hostname = url.hostname
    const pathname = url.pathname

    // LinkedIn profile
    if (hostname === 'www.linkedin.com' && pathname.startsWith('/in/')) {
      const rawName = (tabs[0].title || '').replace(/\s*\|?\s*LinkedIn\s*$/, '').replace(/\s*[-\u2013\u2014].*$/, '').trim()
      const name = cleanName(rawName)
      if (name) {
        crmContainer.innerHTML = '<div class="crm-card"><div class="crm-loading">Looking up ' + esc(name) + '...</div></div>'
        await loadContactCRM(name)
      }
      return
    }

    // LinkedIn company
    if (hostname === 'www.linkedin.com' && pathname.startsWith('/company/')) {
      const companyName = (tabs[0].title || '').replace(/\s*\|?\s*LinkedIn\s*$/, '').replace(/\s*[-\u2013\u2014].*$/, '').trim()
      if (companyName) {
        crmContainer.innerHTML = '<div class="crm-card"><div class="crm-loading">Looking up ' + esc(companyName) + '...</div></div>'
        await loadCompanyCRM(companyName)
      }
      return
    }

    // Company website
    const skipDomains = ['google.com', 'linkedin.com', 'github.com', 'youtube.com', 'twitter.com',
      'x.com', 'facebook.com', 'reddit.com', 'wikipedia.org', 'amazon.com', 'stackoverflow.com']
    const domain = hostname.replace('www.', '')

    if (!skipDomains.some(d => domain.includes(d))) {
      crmContainer.innerHTML = '<div class="crm-card"><div class="crm-loading">Checking ' + esc(domain) + '...</div></div>'
      await loadDomainCRM(domain)
    }
  } catch {
    // Invalid URL
  }
})

async function loadContactCRM(name) {
  const contacts = await sendMsg('orca_lookup_contact', { name })

  if (contacts && contacts.length > 0) {
    const contact = contacts[0]
    const [facts, briefs] = await Promise.all([
      sendMsg('orca_get_facts', { contactId: contact.id }),
      sendMsg('orca_get_briefs', { contactName: contact.name }),
    ])
    renderKnownContact(contact, facts || [], briefs || [])
  } else {
    renderNewContact(name)
  }
}

async function loadCompanyCRM(companyName) {
  const contacts = await sendMsg('orca_lookup_company', { company: companyName })
  renderCompanyContacts(companyName, contacts || [])
}

async function loadDomainCRM(domain) {
  const contacts = await sendMsg('orca_lookup_domain', { domain })
  if (contacts && contacts.length > 0) {
    renderCompanyContacts(domain, contacts)
  } else {
    crmContainer.innerHTML = ''
  }
}

// ============================================================
// CRM rendering
// ============================================================

function renderKnownContact(contact, facts, briefs) {
  const warmthClass = contact.warmth_score >= 80 ? 'fire' :
    contact.warmth_score >= 60 ? 'hot' :
    contact.warmth_score >= 40 ? 'warm' : 'cold'
  const warmthColor = warmthClass === 'fire' ? '#ef4444' : warmthClass === 'hot' ? '#f97316' : warmthClass === 'warm' ? '#facc15' : '#60a5fa'

  const altEmails = extractAltEmails(facts)
  const displayFacts = getNonEmailFacts(facts)

  // Build all emails list
  const allEmails = []
  if (contact.email) allEmails.push(contact.email)
  altEmails.forEach(e => { if (!allEmails.includes(e)) allEmails.push(e) })

  // Initials for avatar
  const initials = (contact.name || '??').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()

  let html = `<div class="crm-card">
    <div class="contact-header">
      <div class="contact-avatar" style="background: ${warmthClass === 'fire' ? '#7f1d1d' : warmthClass === 'hot' ? '#7c2d12' : '#1e3a5f'}; color: ${warmthColor}">${initials}</div>
      <div class="contact-header-info">
        <div class="contact-name">${esc(contact.name)}</div>
        <div class="contact-meta">${esc(contact.role || '')}${contact.role && contact.company ? ' at ' : ''}${esc(contact.company || '')}</div>
      </div>
    </div>
    <div class="contact-badges">
      <span class="stage-badge stage-${contact.relationship_stage || 'known'}">${esc(contact.relationship_stage || 'known')}</span>
    </div>
    <div class="warmth-row">
      <span class="warmth-label">Warmth</span>
      <div class="warmth-bar"><div class="warmth-fill ${warmthClass}" style="width: ${contact.warmth_score || 50}%"></div></div>
      <span class="warmth-score" style="color: ${warmthColor}">${contact.warmth_score || 50}</span>
    </div>`

  // Emails section
  if (allEmails.length > 0) {
    html += `<div class="email-list">`
    allEmails.forEach((email, i) => {
      const label = i === 0 ? 'Primary' : 'Alt'
      html += `<div class="email-item"><span class="email-label">${label}</span><span class="email-addr">${esc(email)}</span></div>`
    })
    html += `</div>`
  }

  html += `</div>`

  // Facts (non-email, humanised)
  const visibleFacts = displayFacts.filter(f => {
    const key = humaniseFactKey(f.fact_key)
    return key !== null
  })

  if (visibleFacts.length > 0) {
    html += `<div class="crm-card">
      <div class="section-title">About</div>`
    visibleFacts.slice(0, 8).forEach(f => {
      const key = humaniseFactKey(f.fact_key)
      html += `<div class="fact-row">
        <div class="fact-label">${esc(key)}</div>
        <div class="fact-text">${esc(f.fact_value)}</div>
      </div>`
    })
    html += `</div>`
  }

  // Briefs
  if (briefs.length > 0) {
    html += `<div class="crm-card">
      <div class="section-title">Recent Meetings</div>
      ${briefs.slice(0, 3).map(b => {
        const dateStr = formatDate(b.meeting_date)
        return `<div class="brief-item">
          <div class="brief-title">${esc(b.title)}</div>
          <div class="brief-date">${dateStr}</div>
        </div>`
      }).join('')}
    </div>`
  }

  crmContainer.innerHTML = html
}

function renderNewContact(name) {
  const initials = (name || '??').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
  crmContainer.innerHTML = `<div class="crm-card">
    <div class="contact-header">
      <div class="contact-avatar" style="background: #3b2f1a; color: #fb923c">${initials}</div>
      <div class="contact-header-info">
        <div class="contact-name">${esc(name)}</div>
        <div class="contact-meta">Not in your CRM yet</div>
      </div>
    </div>
    <button class="btn btn-add" id="addCrmBtn" style="width:100%; margin-top:10px">Add to CRM</button>
  </div>`

  document.getElementById('addCrmBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('addCrmBtn')
    btn.textContent = 'Adding...'
    btn.disabled = true
    try {
      await sendMsg('orca_add_contact', { name, linkedinUrl: tabUrl.textContent })
      btn.textContent = 'Added!'
      btn.className = 'btn btn-capture'
      setTimeout(() => loadContactCRM(name), 1000)
    } catch {
      btn.textContent = 'Failed'
    }
  })
}

function renderCompanyContacts(title, contacts) {
  if (contacts.length === 0) {
    crmContainer.innerHTML = `<div class="crm-card">
      <div class="section-title">Company</div>
      <div class="contact-name">${esc(title)}</div>
      <div class="contact-meta" style="margin-top:4px">No contacts found in CRM</div>
    </div>`
    return
  }

  let html = `<div class="crm-card">
    <span class="match-badge badge-known">${contacts.length} contact${contacts.length !== 1 ? 's' : ''} known</span>
    <div class="contact-name" style="margin-top:4px">${esc(title)}</div>
  </div>
  <div class="crm-card">
    <div class="section-title">People You Know</div>
    ${contacts.map(c => {
      const initials = (c.name || '??').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
      const warmthColor = c.warmth_score >= 70 ? '#f97316' : c.warmth_score >= 40 ? '#facc15' : '#64748b'
      const warmthBg = c.warmth_score >= 70 ? '#7c2d12' : c.warmth_score >= 40 ? '#3b2f1a' : '#1e293b'
      return `<div class="contact-mini">
        <div class="contact-mini-avatar" style="background:${warmthBg}; color:${warmthColor}">${initials}</div>
        <div class="contact-mini-info">
          <div class="contact-mini-name">${esc(c.name)}</div>
          <div class="contact-mini-role">${esc(c.role || c.email || '')}</div>
        </div>
        <span class="contact-mini-warmth" style="color: ${warmthColor}">${c.warmth_score || 50}</span>
      </div>`
    }).join('')}
  </div>`

  crmContainer.innerHTML = html
}

// ============================================================
// Helpers
// ============================================================

function formatDate(dateStr) {
  if (!dateStr) return ''
  try {
    const d = new Date(dateStr + 'T00:00:00')
    const now = new Date()
    const diffDays = Math.floor((now - d) / 86400000)
    if (diffDays === 0) return 'Today'
    if (diffDays === 1) return 'Yesterday'
    if (diffDays < 7) return `${diffDays} days ago`
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return dateStr
  }
}

// ============================================================
// Quick capture from popup
// ============================================================

captureBtn.addEventListener('click', async () => {
  const notes = captureNotes.value.trim()

  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    if (!tabs[0]) return

    captureBtn.textContent = 'Saving...'
    captureBtn.disabled = true

    const content = [
      `URL: ${tabs[0].url}`,
      `Title: ${tabs[0].title}`,
      notes ? `Notes: ${notes}` : '',
    ].filter(Boolean).join('\n')

    chrome.runtime.sendMessage({
      type: 'orca_quick_capture',
      content,
      metadata: {
        url: tabs[0].url,
        title: tabs[0].title,
        captured_at: new Date().toISOString(),
        source: 'chrome_extension_popup',
      },
    }, (response) => {
      if (response?.error) {
        showToast('Failed: ' + response.error, 'error')
        captureBtn.textContent = 'Save to Orca Memory'
        captureBtn.disabled = false
      } else {
        showToast('Saved to Orca memory', 'success')
        captureNotes.value = ''
        captureBtn.textContent = 'Saved!'
        setTimeout(() => {
          captureBtn.textContent = 'Save to Orca Memory'
          captureBtn.disabled = false
        }, 2000)
      }
    })
  })
})

function showToast(message, type) {
  toast.textContent = message
  toast.className = `toast ${type}`
  setTimeout(() => { toast.className = 'toast' }, 3000)
}

// ============================================================
// Buttons
// ============================================================

reconnectBtn.addEventListener('click', () => {
  statusText.textContent = 'Reconnecting...'
  dot.className = 'status-dot connecting'
  chrome.runtime.sendMessage({ type: 'reconnect' }, () => {
    setTimeout(loadStatus, 1500)
  })
})

testBtn.addEventListener('click', () => {
  statusSub.textContent = 'Testing...'
  chrome.runtime.sendMessage({ type: 'get_status' }, (response) => {
    statusSub.textContent = response?.connected ? 'OK' : 'Not connected'
    setTimeout(() => { statusSub.textContent = '' }, 2000)
  })
})

loadStatus()
