/**
 * Orca Browser Bridge - Background Service Worker (v4)
 *
 * v1/v2: WebSocket bridge to Orca desktop (ws://127.0.0.1:19840)
 * v3: + contextual intelligence overlay (was: direct Supabase; now: over WS)
 * v4: removed all Supabase credentials; all queries route to desktop over WS
 */

const WS_URL = 'ws://127.0.0.1:19840'
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000

let ws = null
let reconnectTimer = null
let reconnectAttempts = 0
let connectionState = 'disconnected'

// Pending query promises keyed by query_id, for WS-routed Supabase lookups.
const pendingQueries = {}

// ============================================================
// WebSocket lifecycle
// ============================================================

function connect() {
  if (ws && ws.readyState <= WebSocket.OPEN) return
  setConnectionState('connecting')

  try {
    ws = new WebSocket(WS_URL)
  } catch (e) {
    console.warn('[Orca Bridge] WebSocket creation failed:', e.message)
    scheduleReconnect()
    return
  }

  ws.onopen = () => {
    console.log('[Orca Bridge] Connected to Orca')
    setConnectionState('connected')
    reconnectAttempts = 0
  }

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data)

      // Reply from desktop to an overlay query we sent (has query_id, no command)
      if (msg.query_id && pendingQueries[msg.query_id]) {
        const { resolve, reject } = pendingQueries[msg.query_id]
        delete pendingQueries[msg.query_id]
        if (msg.success) {
          resolve(msg.data)
        } else {
          reject(new Error(msg.error || 'Query failed'))
        }
        return
      }

      // Desktop-initiated command request: { id, command, params }
      if (msg.id && msg.command) {
        const response = await handleCommand(msg)
        ws.send(JSON.stringify(response))
        return
      }
    } catch (err) {
      console.error('[Orca Bridge] Message handling error:', err)
    }
  }

  ws.onclose = () => {
    console.log('[Orca Bridge] Disconnected from Orca')
    setConnectionState('disconnected')
    ws = null
    scheduleReconnect()
  }

  ws.onerror = () => {
    // Connection refused is expected when Orca desktop is not running
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = true
  const delaySec = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS) / 1000
  reconnectAttempts++
  chrome.alarms.create('orca-reconnect', { delayInMinutes: delaySec / 60 })
}

function disconnect() {
  chrome.alarms.clear('orca-reconnect')
  reconnectTimer = null
  if (ws) {
    ws.close()
    ws = null
  }
  setConnectionState('disconnected')
}

function setConnectionState(state) {
  connectionState = state
  chrome.runtime.sendMessage({ type: 'status_changed', state, connected: state === 'connected', reconnectAttempts }).catch(() => {})
}

// ============================================================
// Send an overlay query to the desktop and wait for the reply
// ============================================================

function sendQueryToDesktop(type, payload, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('Not connected to Orca desktop'))
    }

    const query_id = crypto.randomUUID()
    const timer = setTimeout(() => {
      delete pendingQueries[query_id]
      reject(new Error('Desktop query timed out'))
    }, timeoutMs)

    pendingQueries[query_id] = {
      resolve: (data) => { clearTimeout(timer); resolve(data) },
      reject: (err) => { clearTimeout(timer); reject(err) },
    }

    ws.send(JSON.stringify({ query_id, type, ...payload }))
  })
}

// ============================================================
// Overlay query helpers (all go over WS to the desktop)
// ============================================================

const db = {
  searchContactByName: (name) => sendQueryToDesktop('orca_lookup_contact', { name }),
  searchContactsByDomain: (domain) => sendQueryToDesktop('orca_lookup_domain', { domain }),
  searchContactsByCompany: (company) => sendQueryToDesktop('orca_lookup_company', { company }),
  getContactFacts: (contactId) => sendQueryToDesktop('orca_get_facts', { contactId }),
  getRecentMeetingBriefs: (contactName, limit = 5) => sendQueryToDesktop('orca_get_briefs', { contactName, limit }),
  getRelationshipInsights: (contactId) => sendQueryToDesktop('orca_get_insights', { contactId }),
  quickCapture: (content, metadata) => sendQueryToDesktop('orca_quick_capture', { content, metadata }),
  addContact: (name, company, email, role, linkedinUrl) => sendQueryToDesktop('orca_add_contact', { name, company, email, role, linkedinUrl }),
  addContactFact: (contactId, factKey, factValue, category) => sendQueryToDesktop('orca_add_fact', { contactId, factKey, factValue, category }),
  getPendingDraftCount: () => sendQueryToDesktop('orca_get_pending_drafts', {}).then(r => r?.count ?? 0),
}

// ============================================================
// Command router (from Orca desktop via WebSocket)
// ============================================================

async function handleCommand(request) {
  const { id, command, params } = request

  try {
    switch (command) {
      case 'ping':
        return success(id, { status: 'ok', version: '4.0.0' })

      case 'list_tabs':
        return await cmdListTabs(id)

      case 'get_active_tab':
        return await cmdGetActiveTab(id)

      case 'open_url':
        return await cmdOpenUrl(id, params)

      case 'close_tab':
        return await cmdCloseTab(id, params)

      case 'get_page_content':
        return await cmdGetPageContent(id, params)

      case 'extract_elements':
        return await cmdExtractElements(id, params)

      case 'click_element':
        return await cmdClickElement(id, params)

      case 'fill_input':
        return await cmdFillInput(id, params)

      case 'execute_script':
        return await cmdExecuteScript(id, params)

      case 'take_screenshot':
        return await cmdTakeScreenshot(id, params)

      case 'linkedin_post_comment':
        return await cmdLinkedInAction(id, 'orca-post-comment', params)

      case 'linkedin_create_post':
        return await cmdLinkedInAction(id, 'orca-create-post', params)

      case 'linkedin_extract_metas':
        return await cmdLinkedinExtractMetas(id, params)

      case 'linkedin_resolve_url':
        return await cmdLinkedinResolveUrl(id, params)

      default:
        return error(id, `Unknown command: ${command}`)
    }
  } catch (err) {
    return error(id, err.message || String(err))
  }
}

// ============================================================
// Tab commands
// ============================================================

async function cmdListTabs(id) {
  const tabs = await chrome.tabs.query({})
  const result = tabs.map(t => ({
    id: t.id,
    url: t.url,
    title: t.title,
    active: t.active,
    windowId: t.windowId,
  }))
  return success(id, result)
}

async function cmdGetActiveTab(id) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab) return error(id, 'No active tab')
  return success(id, {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    windowId: tab.windowId,
  })
}

async function cmdOpenUrl(id, params) {
  const { url, new_tab } = params || {}
  if (!url) return error(id, 'url is required')

  if (new_tab === false) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab) {
      await chrome.tabs.update(tab.id, { url })
      return success(id, { tabId: tab.id, url })
    }
  }
  const tab = await chrome.tabs.create({ url, active: true })
  return success(id, { tabId: tab.id, url })
}

async function cmdCloseTab(id, params) {
  const { tab_id } = params || {}
  if (!tab_id) return error(id, 'tab_id is required')
  await chrome.tabs.remove(tab_id)
  return success(id, { closed: true })
}

async function cmdTakeScreenshot(id, params) {
  const { tab_id } = params || {}
  let windowId

  if (tab_id) {
    const tab = await chrome.tabs.get(tab_id)
    windowId = tab.windowId
    await chrome.tabs.update(tab_id, { active: true })
    await sleep(300)
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(windowId || undefined, { format: 'png' })
  return success(id, { screenshot: dataUrl })
}

// ============================================================
// Content script commands
// ============================================================

async function getTargetTabId(params) {
  if (params?.tab_id) return params.tab_id
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab) throw new Error('No active tab')
  return tab.id
}

async function sendToContentScript(tabId, action, params, timeoutMs = 15000) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!window.__orcaBridgeLoaded,
    })
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js'],
      })
      await sleep(500)
    } catch (e) {
      throw new Error(`Cannot inject content script: ${e.message}`)
    }
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Content script timeout')), timeoutMs)

    chrome.tabs.sendMessage(tabId, { action, ...params }, (response) => {
      clearTimeout(timer)
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
      } else {
        resolve(response)
      }
    })
  })
}

async function cmdGetPageContent(id, params) {
  const tabId = await getTargetTabId(params)
  const result = await sendToContentScript(tabId, 'get_page_content', {
    format: params?.format || 'text',
  })
  return success(id, result)
}

async function cmdExtractElements(id, params) {
  const tabId = await getTargetTabId(params)
  const result = await sendToContentScript(tabId, 'extract_elements', {
    selector: params?.selector,
    attributes: params?.attributes,
    limit: params?.limit,
  })
  return success(id, result)
}

async function cmdClickElement(id, params) {
  const tabId = await getTargetTabId(params)
  const result = await sendToContentScript(tabId, 'click_element', {
    selector: params?.selector,
  })
  return success(id, result)
}

async function cmdFillInput(id, params) {
  const tabId = await getTargetTabId(params)
  const result = await sendToContentScript(tabId, 'fill_input', {
    selector: params?.selector,
    value: params?.value,
    submit: params?.submit,
  })
  return success(id, result)
}

async function cmdLinkedinExtractMetas(id, params) {
  const tabId = await getTargetTabId(params)
  // Content script scrolls internally then reads the DOM; allow time for both.
  const result = await sendToContentScript(tabId, 'orca-extract-metas', {}, 20000)
  return success(id, result)
}

async function cmdLinkedinResolveUrl(id, params) {
  const tabId = await getTargetTabId(params)
  const result = await sendToContentScript(tabId, 'orca-resolve-url', { menuLabel: params?.menuLabel }, 15000)
  return success(id, result)
}

async function cmdExecuteScript(id, params) {
  const tabId = await getTargetTabId(params)
  const { javascript } = params || {}
  if (!javascript) return error(id, 'javascript is required')

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (code) => {
        try {
          return { success: true, result: String(eval(code)) }
        } catch (e) {
          return { success: false, error: e.message }
        }
      },
      args: [javascript],
    })

    const result = results?.[0]?.result
    if (result && !result.success) {
      return error(id, result.error)
    }
    return success(id, { result: result?.result ?? null })
  } catch (e) {
    return error(id, e.message)
  }
}

// ============================================================
// LinkedIn-specific (backwards compat)
// ============================================================

async function cmdLinkedInAction(id, action, params) {
  let tabId
  if (params?.tab_id) {
    tabId = params.tab_id
  } else {
    const tabs = await chrome.tabs.query({ url: '*://*.linkedin.com/*' })
    if (tabs.length > 0) {
      tabId = tabs[0].id
      await chrome.tabs.update(tabId, { active: true })
    } else {
      return error(id, 'No LinkedIn tab found')
    }
  }

  const contentParams = { ...params }
  if (params?.imageBase64) {
    contentParams.imageBase64 = params.imageBase64
  }

  const result = await sendToContentScript(tabId, action, contentParams, 25000)
  return success(id, result)
}

// ============================================================
// v3/v4: Overlay query handler (now routes over WS to desktop)
// ============================================================

async function handleOverlayMessage(msg) {
  try {
    switch (msg.type) {
      case 'orca_lookup_contact':
        return await db.searchContactByName(msg.name)

      case 'orca_lookup_domain':
        return await db.searchContactsByDomain(msg.domain)

      case 'orca_lookup_company':
        return await db.searchContactsByCompany(msg.company)

      case 'orca_get_facts':
        return await db.getContactFacts(msg.contactId)

      case 'orca_get_briefs':
        return await db.getRecentMeetingBriefs(msg.contactName, msg.limit)

      case 'orca_get_insights':
        return await db.getRelationshipInsights(msg.contactId)

      case 'orca_quick_capture':
        return await db.quickCapture(msg.content, msg.metadata)

      case 'orca_add_contact':
        return await db.addContact(msg.name, msg.company, msg.email, msg.role, msg.linkedinUrl)

      case 'orca_add_fact':
        return await db.addContactFact(msg.contactId, msg.factKey, msg.factValue, msg.category)

      default:
        return { error: `Unknown overlay message: ${msg.type}` }
    }
  } catch (err) {
    console.error('[Orca Bridge] Overlay query error:', err)
    return { error: err.message }
  }
}

// ============================================================
// Badge management
// ============================================================

async function updateBadge(state, tabId) {
  const target = tabId ? { tabId } : {}

  switch (state) {
    case 'known':
      await chrome.action.setBadgeBackgroundColor({ color: '#4ade80', ...target })
      await chrome.action.setBadgeText({ text: ' ', ...target })
      break
    case 'new':
      await chrome.action.setBadgeBackgroundColor({ color: '#fb923c', ...target })
      await chrome.action.setBadgeText({ text: ' ', ...target })
      break
    default:
      await chrome.action.setBadgeText({ text: '', ...target })
  }
}

async function checkDraftBadge() {
  try {
    const count = await db.getPendingDraftCount()
    if (count > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: '#fb923c' })
      await chrome.action.setBadgeText({ text: String(count) })
    }
  } catch {
    // Desktop unreachable, ignore
  }
}

// ============================================================
// Helpers
// ============================================================

function success(id, data) {
  return { id, success: true, data: data ?? {} }
}

function error(id, message) {
  return { id, success: false, data: {}, error: message }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// ============================================================
// Extension lifecycle
// ============================================================

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Orca Bridge] Extension installed (v4)')
  connect()
})

chrome.runtime.onStartup.addListener(() => {
  console.log('[Orca Bridge] Chrome started')
  connect()
})

connect()

chrome.alarms.create('orca-keepalive', { periodInMinutes: 0.4 })
chrome.alarms.create('orca-draft-badge', { periodInMinutes: 5 })

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'orca-keepalive') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'keepalive' }))
    }
  }
  if (alarm.name === 'orca-draft-badge') {
    checkDraftBadge()
  }
  if (alarm.name === 'orca-reconnect') {
    reconnectTimer = null
    connect()
  }
})

checkDraftBadge()

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get_status') {
    sendResponse({
      connected: connectionState === 'connected',
      state: connectionState,
      reconnectAttempts,
    })
    return true
  }

  if (msg.type === 'reconnect') {
    disconnect()
    reconnectAttempts = 0
    connect()
    sendResponse({ ok: true })
    return true
  }

  if (msg.type === 'orca_update_badge') {
    updateBadge(msg.state, sender.tab?.id).then(() => sendResponse({ ok: true }))
    return true
  }

  if (msg.type?.startsWith('orca_')) {
    handleOverlayMessage(msg).then(sendResponse)
    return true
  }
})

chrome.commands.onCommand.addListener((command) => {
  if (command === 'quick-capture') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'orca_show_capture' })
      }
    })
  }
})
