'use strict'

const fs = require('fs')
const path = require('path')
const got = require('got')
const {
  ENDPOINT,
  createEmptyState,
  monitorError,
  monitorOnce,
  normalizeState,
  normalizeProbeStates,
  resolveMonitorConfig
} = require('./wawapi_model_monitor_core')
const { readSafeTextResult, writeAtomic } = require('./xbk_storage')
const { runLoop } = require('./xbk_loop')

function fetchModels ({ apiKey, request = got }) {
  return request(ENDPOINT, {
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json'
    },
    responseType: 'text',
    throwHttpErrors: false,
    retry: { limit: 0 },
    timeout: { request: 10000 }
  })
}

// 并发请求多个 API Key，合并去重模型列表，返回合成响应对象
async function fetchModelsMulti ({ apiKeys, request = got }) {
  if (!Array.isArray(apiKeys) || apiKeys.length === 0) {
    throw monitorError('CONFIG_MISSING_API_KEY', '未配置任何 API Key')
  }
  if (apiKeys.length === 1) {
    return fetchModels({ apiKey: apiKeys[0], request })
  }
  const results = await Promise.allSettled(
    apiKeys.map(key => fetchModels({ apiKey: key, request }))
  )
  const mergedData = []
  const errors = []
  const seenIds = new Set() // N4: 按模型 ID 去重
  let validResponses = 0 // 有合法 HTTP 200 + data 数组的响应数（即使 data 为空）
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.status === 'fulfilled') {
      const statusCode = r.value && Number.isInteger(r.value.statusCode) ? r.value.statusCode : 0
      const body = parseResponseBodySafe(r.value && r.value.body)
      // HTTP 非 200 或响应体缺少 data 数组：视为该 Key 失败
      if (statusCode !== 200 || !body || !Array.isArray(body.data)) {
        const error = statusCode >= 100
          ? monitorError(`HTTP_${statusCode}`, `WawAPI 返回 HTTP ${statusCode}`)
          : monitorError('INVALID_MODEL_RESPONSE', 'WawAPI 响应缺少 data 数组')
        error.statusCode = statusCode || null
        errors.push({ index: i, error })
        continue
      }
      // N2: 校验每一个 data 项；存在非法项（缺 id / id 为空）则整个响应视为无效，
      // 避免“所有 Key 都返回畸形 data”时被合成成空列表误报为“模型全部下架”。
      let allValid = true
      for (const item of body.data) {
        if (!item || typeof item !== 'object' || typeof item.id !== 'string' || item.id.trim() === '') {
          allValid = false
          break
        }
      }
      if (!allValid) {
        const error = monitorError('INVALID_MODEL_RESPONSE', 'WawAPI 响应包含非法模型项')
        error.statusCode = statusCode || null
        errors.push({ index: i, error })
        continue
      }
      validResponses += 1
      for (const item of body.data) {
        const id = item.id.trim()
        if (!seenIds.has(id)) {
          seenIds.add(id)
          mergedData.push(item)
        }
      }
    } else {
      errors.push({ index: i, error: r.reason })
    }
  }
  // 仅当没有任何 Key 返回合法模型列表响应时才抛错：合法空列表（data:[]）应视为成功观测
  if (validResponses === 0 && errors.length > 0) {
    throw errors[0].error
  }
  return { statusCode: 200, body: JSON.stringify({ data: mergedData, object: 'list' }) }
}

function parseResponseBodySafe (body) {
  if (body && typeof body === 'object') return body
  if (typeof body !== 'string') return null
  try { return JSON.parse(body) } catch (e) { return null }
}

// 判断探测响应是否真的包含生成内容（空数组/空字符串/无内容项都不能算成功）。
function probeBodyHasContent (body) {
  if (!body || typeof body !== 'object') return false
  // choices：必须至少一项含非空内容字段（message.content / text / content / reasoning_content）
  if (Array.isArray(body.choices)) {
    for (const choice of body.choices) {
      if (!choice || typeof choice !== 'object') continue
      const msg = choice.message && typeof choice.message === 'object' ? choice.message : null
      if (msg && typeof msg.content === 'string' && msg.content.trim() !== '') return true
      if (typeof choice.text === 'string' && choice.text.trim() !== '') return true
      if (typeof choice.content === 'string' && choice.content.trim() !== '') return true
      if (msg && typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim() !== '') return true
    }
    return false
  }
  if (Array.isArray(body.data)) {
    for (const item of body.data) {
      if (!item || typeof item !== 'object') continue
      if (typeof item.text === 'string' && item.text.trim() !== '') return true
      if (typeof item.content === 'string' && item.content.trim() !== '') return true
    }
    return false
  }
  if (typeof body.output_text === 'string' && body.output_text.trim() !== '') return true
  if (typeof body.reasoning === 'string' && body.reasoning.trim() !== '') return true
  if (typeof body.reasoning_content === 'string' && body.reasoning_content.trim() !== '') return true
  return false
}

// 对单个模型发一次极短请求验证是否可响应。
// 成功：HTTP 200 且解析出真实内容；否则视为失败。
// max_tokens 用 16 而非 1：部分 OpenAI 兼容接口拒绝 max_tokens=1（最小限制/字段名差异），
// 16 足够验证可用性且成本极低，同时提高兼容性。
async function fetchModelProbe ({ apiKey, model, request = got }) {
  const res = await request('https://wawapii.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
      'content-type': 'application/json'
    },
    json: {
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 16,
      stream: false
    },
    responseType: 'text',
    throwHttpErrors: false,
    retry: { limit: 0 },
    timeout: { request: 20000 }
  })
  if (res.statusCode !== 200) {
    return { ok: false, detail: `HTTP ${res.statusCode}` }
  }
  const body = parseResponseBodySafe(res.body)
  if (probeBodyHasContent(body)) return { ok: true, detail: '' }
  return { ok: false, detail: '响应缺少内容' }
}

// 并发用多个 Key 探测同一模型，任一 Key 成功即视为可用（返回其成功结果）。
// 全部失败时返回第一个失败结果（带成功尝试次数的摘要）。
// 跳过可能在 HTTP 头中非法的 Key（如含非 ASCII 字符的截断 Key），避免整组探测被污染。
async function probeModelWithKeys ({ model, apiKeys, request, fetchProbe = fetchModelProbe }) {
  const validKeys = (apiKeys || []).filter(k => typeof k === 'string' && /^[\x21-\x7E]+$/.test(k) && k.trim())
  if (validKeys.length === 0) return { ok: false, detail: '无可用 API Key' }
  const results = await Promise.allSettled(
    validKeys.map(key => fetchProbe({ apiKey: key, model, request }))
  )
  let firstFailure = null
  let okCount = 0
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value && r.value.ok) { okCount += 1; return r.value }
    if (r.status === 'fulfilled' && r.value && !firstFailure) firstFailure = r.value
    else if (r.status === 'rejected' && !firstFailure) firstFailure = { ok: false, detail: (r.reason && r.reason.message ? r.reason.message : '请求失败').slice(0, 60) }
  }
  const detail = firstFailure && firstFailure.detail ? firstFailure.detail : '无响应'
  return { ok: false, detail: `${detail}（${validKeys.length - okCount}个Key不可用）` }
}

// 判断某个模型本轮是否该探测：
// - 无记录/无时间戳 → 到期（首次或状态损坏）
// - 失败态 → 固定 5 分钟重试（S6：不受外层 daemon 间隔影响）
// - 成功态 → 按 probeIntervalMs 间隔；0/负值视为每次到期（C3）
// - 无效日期 → 到期（S3：避免 NaN 比较导致永不探测）
function isProbeDue (prev, probeIntervalMs, nowMs) {
  if (!prev || !prev.lastProbedAt) return true
  const lastMs = new Date(prev.lastProbedAt).getTime()
  if (!Number.isFinite(lastMs)) return true
  if (prev.state !== 'ok') {
    return nowMs - lastMs >= 300000 // 失败/未知：5 分钟重试
  }
  if (probeIntervalMs <= 0) return true
  return nowMs - lastMs >= probeIntervalMs
}

// 执行一次模型探测：对每个指定模型判断是否该测，
// 需要测的并发发出请求（多 Key 任一成功即可用），返回需要发送通知的翻转项。
// 返回 { notifications: [...], probeStates: [...] } 供调用方持久化。
async function runProbes ({ apiKeys, probeModels, probeIntervalMs, state, now, request, fetchProbe = fetchModelProbe }) {
  const nowIso = (typeof now === 'function' ? now() : new Date(now || Date.now())).toISOString?.() || new Date().toISOString()
  const nowMs = new Date(nowIso).getTime()
  const existing = new Map((state.probeStates || []).map(p => [p.model, p]))
  const due = probeModels.filter(model => isProbeDue(existing.get(model), probeIntervalMs, nowMs))
  const notifications = []
  const results = await Promise.allSettled(
    due.map(async model => ({ model, probe: await probeModelWithKeys({ model, apiKeys, request, fetchProbe }) }))
  )
  const nextStates = [...existing.values()]
  for (const r of results) {
    if (r.status !== 'fulfilled') continue
    const { model, probe } = r.value
    const prev = existing.get(model)
    const nextState = {
      model,
      state: probe.ok ? 'ok' : 'failing',
      lastProbedAt: nowIso
    }
    const idx = nextStates.findIndex(p => p.model === model)
    if (idx >= 0) nextStates[idx] = nextState
    else nextStates.push(nextState)
    // 通知策略（只在状态变化或首次发现异常时通知，避免持续不可用重复轰炸）：
    // - unknown -> ok：首次建立正常基线，不打扰。
    // - unknown -> failing：首次探测就发现模型挂了，立即告知。
    // - ok <-> failing：状态翻转（刚挂/刚恢复），通知。
    // - failing -> failing：持续不可用，不重复通知。
    // - ok -> ok：持续可用，不通知。
    const prevState = prev ? prev.state : 'unknown'
    // 首次探测发现模型挂了（unknown->failing）立即告知；否则只在状态翻转时通知。
    const firstDown = prevState === 'unknown' && nextState.state === 'failing'
    const flip = prevState !== 'unknown' && prevState !== nextState.state
    if (firstDown || flip) {
      notifications.push({ model, previous: prev, next: nextState, detail: probe.detail })
    }
  }
  return { notifications, probeStates: nextStates }
}

function parseArgs (argv = []) {
  let mode = 'once'
  let reportCurrent = false
  for (const arg of argv) {
    if (arg === '--once') {
      if (mode === 'daemon') throw new Error('--once 与 --daemon 不能同时使用')
      mode = 'once'
    } else if (arg === '--daemon') {
      if (mode === 'once' && argv.includes('--once')) throw new Error('--once 与 --daemon 不能同时使用')
      mode = 'daemon'
    } else if (arg === '--report-current') {
      reportCurrent = true
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }
  return { mode, reportCurrent }
}

function loadLocalConfig (modulePath) {
  if (!fs.existsSync(modulePath)) return {}
  let config
  try { config = require(modulePath) } catch (error) {
    const wrapped = monitorError('CONFIG_INVALID', `本地配置加载失败：${error.message}`)
    wrapped.cause = error
    throw wrapped
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw monitorError('CONFIG_INVALID', '本地配置必须导出对象')
  }
  return config
}

function createStateStore (statePath) {
  return {
    read: async () => {
      const result = readSafeTextResult(statePath)
      if (result.status === 'missing') return null
      if (result.status !== 'ok') throw monitorError('STATE_INVALID', `状态文件读取失败：${result.status}`)
      let parsed
      try { parsed = JSON.parse(result.text) } catch (error) {
        throw monitorError('STATE_INVALID', '状态文件不是合法 JSON')
      }
      return normalizeState(parsed)
    },
    write: async state => {
      const ok = writeAtomic(statePath, JSON.stringify(normalizeState(state), null, 2), 'WawAPI模型监测状态')
      if (!ok) throw monitorError('STATE_WRITE_FAILED', '状态文件写入失败')
    }
  }
}

// 模型探测状态存储：与主状态文件分离，使用独立文件，避免 core normalizeState 丢弃额外字段。
function createProbeStore (statePath) {
  return {
    read: async () => {
      const result = readSafeTextResult(statePath)
      if (result.status === 'missing') return []
      if (result.status !== 'ok') throw monitorError('PROBE_STATE_INVALID', `探测状态读取失败：${result.status}`)
      try {
        const parsed = JSON.parse(result.text)
        return normalizeProbeStates(Array.isArray(parsed) ? parsed : (parsed && parsed.probeStates))
      } catch (error) {
        throw monitorError('PROBE_STATE_INVALID', '探测状态不是合法 JSON')
      }
    },
    write: async probeStates => {
      const ok = writeAtomic(statePath, JSON.stringify({ probeStates: normalizeProbeStates(probeStates) }, null, 2), 'WawAPI模型探测状态')
      if (!ok) throw monitorError('PROBE_STATE_WRITE_FAILED', '探测状态写入失败')
    }
  }
}

// 组装单条探测通知正文。
function buildProbeNotice (n) {
  const labels = { ok: '✅ 可用', failing: '❌ 不可用', unknown: '未知' }
  const prev = n.previous ? labels[n.previous.state] || '未知' : '首次探测'
  const lines = [`模型：${n.model}`, `状态：${prev} → ${labels[n.next.state] || n.next.state}`]
  if (n.detail) lines.push(`说明：${n.detail}`)
  return lines.join('\n')
}

function processAlive (pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

function readLockInfo (lockPath) {
  try {
    const text = fs.readFileSync(lockPath, 'utf8')
    const info = JSON.parse(text)
    return info && Number.isInteger(info.pid) ? info : null
  } catch (error) {
    return null
  }
}

function withInstanceLock (lockPath, task) {
  const openOwnedLock = () => {
    const fd = fs.openSync(lockPath, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8')
      return fd
    } catch (error) {
      try { fs.closeSync(fd) } catch (closeError) { /* 原始写入错误优先 */ }
      throw error
    }
  }

  const acquire = () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    try {
      return openOwnedLock()
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
      const info = readLockInfo(lockPath)
      if (!info || processAlive(info.pid)) throw monitorError('LOCK_HELD', '已有 WawAPI 模型监测实例运行')
      try { fs.unlinkSync(lockPath) } catch (unlinkError) {
        throw monitorError('LOCK_HELD', '残留锁无法安全清理')
      }
      return openOwnedLock()
    }
  }

  let fd
  try { fd = acquire() } catch (error) { return Promise.reject(error) }
  return Promise.resolve()
    .then(() => task())
    .finally(() => {
      try { fs.closeSync(fd) } catch (error) { /* 锁释放继续执行 */ }
      try { fs.unlinkSync(lockPath) } catch (error) { /* 锁已经被外部清理时忽略 */ }
    })
}

function loadConfig ({ env = process.env, rootDir = __dirname } = {}) {
  const localPath = path.join(rootDir, 'wawapi_model_monitor.local.js')
  return resolveMonitorConfig({ env, localConfig: loadLocalConfig(localPath), rootDir })
}

function defaultNotify (title, body) {
  const notifyModule = require('./xbk_sendNotify_slim')
  return notifyModule.sendNotify(title, body)
}

function resolveApiKeys (config) {
  if (!config) return []
  if (Array.isArray(config.apiKeys)) {
    return config.apiKeys.map(k => String(k).trim()).filter(Boolean)
  }
  if (typeof config.apiKey === 'string' && config.apiKey.trim()) return [config.apiKey.trim()]
  return []
}

function runOnce ({
  config,
  reportCurrent = false,
  monitor = monitorOnce,
  request = got,
  notify = defaultNotify,
  stateStore,
  runProbes: runProbesImpl = runProbes,
  now
}) {
  const apiKeys = resolveApiKeys(config)
  if (!apiKeys.length) {
    return Promise.reject(monitorError('CONFIG_MISSING_API_KEY', '未配置 WAWAPI_API_KEY 或本地 API Key'))
  }
  const store = stateStore || createStateStore(config.stateFile)

  const probeModels = Array.isArray(config.probeModels) ? config.probeModels.filter(m => typeof m === 'string' && m.trim()) : []
  // 探测状态单独存文件，避免与模型列表状态（core normalizeState 会丢弃额外字段）耦合。
  const probeStore = createProbeStore(
    config.probeStateFile || path.join(path.dirname(config.stateFile), 'wawapi_probe_state.json')
  )

  const baseline = monitor({
    readState: store.read,
    writeState: store.write,
    fetchModels: () => fetchModelsMulti({ apiKeys, request }),
    notify,
    now,
    reportCurrent,
    watch: { watchExact: config.watchExact || [], watchPrefixes: config.watchPrefixes || [] }
  })

  // 模型列表监测与（可选的）指定模型可用性探测并行执行（S5）：
  // 同时启动两条流程，探测不再等待主监测完成，互不阻塞。
  if (!probeModels.length) return baseline

  const probeFlow = (async () => {
    try {
      const stored = await probeStore.read()
      const { notifications, probeStates } = await runProbesImpl({
        apiKeys,
        probeModels,
        probeIntervalMs: config.probeIntervalMs,
        state: { probeStates: stored },
        now,
        request,
        notify
      })
      // S4：先发通知，成功才提交对应模型的新状态；通知失败则回滚，
      // 下一轮会再次识别翻转并重试通知，避免翻转事件永久丢失。
      const committed = new Map(probeStates.map(p => [p.model, p]))
      for (const n of notifications) {
        let sent = false
        try {
          await notify('【WawAPI模型探测】', buildProbeNotice(n))
          sent = true
        } catch (error) { /* 单条探测通知失败：不提交该模型新状态，下轮重试 */ }
        if (!sent) {
          if (n.previous) {
            committed.set(n.model, { ...n.previous })
          } else {
            committed.delete(n.model) // 首次探测通知失败：回到 unknown，下轮重新探测
          }
        }
      }
      await probeStore.write([...committed.values()])
    } catch (error) {
      // 探测失败不应阻断主模型列表监测结果。
      if (typeof console !== 'undefined' && console.error) console.error('模型探测失败:', error && error.message ? error.message : error)
    }
  })()

  return Promise.all([baseline, probeFlow]).then(([result]) => result)
}

function runDaemon ({ runOnce: run, intervalMs, signal, loop = runLoop, onError = () => {} }) {
  if (typeof run !== 'function') return Promise.reject(new TypeError('runDaemon 需要 runOnce 函数'))
  return loop(run, { intervalMs, signal, onError })
}

function safeRuntimeError (error) {
  if (!error) return '未知错误'
  const code = error.code ? String(error.code) : 'RUNTIME_ERROR'
  const message = error.message ? String(error.message).slice(0, 200) : ''
  return message ? `${code}: ${message}` : code
}

function signalContext (dependencies) {
  if (dependencies.signal) return { signal: dependencies.signal, cleanup: () => {} }
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  return {
    signal: controller.signal,
    cleanup: () => {
      process.removeListener('SIGTERM', stop)
      process.removeListener('SIGINT', stop)
    }
  }
}

async function main (argv = [], dependencies = {}) {
  const logger = dependencies.logger || console
  let args
  try { args = parseArgs(argv) } catch (error) {
    logger.error(safeRuntimeError(error))
    return 1
  }

  let config
  try {
    config = dependencies.config || loadConfig({ env: dependencies.env || process.env, rootDir: __dirname })
  } catch (error) {
    logger.error(safeRuntimeError(error))
    return 1
  }
  if (!config.apiKey) {
    logger.error('CONFIG_MISSING_API_KEY: 未配置 WAWAPI_API_KEY 或本地 API Key')
    return 1
  }

  const lock = dependencies.withInstanceLock || withInstanceLock
  const lockPath = `${config.stateFile}.lock`
  const executeOnce = reportCurrent => {
    if (dependencies.runOnce) return dependencies.runOnce({ config, reportCurrent })
    return runOnce({
      config,
      reportCurrent,
      monitor: dependencies.monitorOnce || monitorOnce,
      request: dependencies.request || got,
      notify: dependencies.notify || defaultNotify,
      stateStore: dependencies.stateStore,
      now: dependencies.now
    })
  }

  try {
    return await lock(lockPath, async () => {
      if (args.mode === 'once') {
        const result = await executeOnce(args.reportCurrent)
        return result && result.outcome === 'notification_failed' ? 1 : 0
      }
      const context = signalContext(dependencies)
      let firstRun = true
      // N3: 启用探测时，daemon 唤醒间隔最多 5 分钟——失败态模型固定 5 分钟重试，
      // 不能受 config.intervalMs 影响（否则配 1 小时时失败模型 1 小时才探一次）。
      const probeEnabled = Array.isArray(config.probeModels) && config.probeModels.length > 0
      const effectiveInterval = probeEnabled
        ? Math.min(config.intervalMs, 300000)
        : config.intervalMs
      try {
        await runDaemon({
          runOnce: () => {
            const report = args.reportCurrent && firstRun
            firstRun = false
            return executeOnce(report)
          },
          intervalMs: effectiveInterval,
          signal: context.signal,
          loop: dependencies.loop || runLoop,
          onError: error => logger.error(safeRuntimeError(error))
        })
        return 0
      } finally {
        context.cleanup()
      }
    })
  } catch (error) {
    logger.error(safeRuntimeError(error))
    return 1
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code
  }).catch(error => {
    console.error(safeRuntimeError(error))
    process.exitCode = 1
  })
}

module.exports = {
  ENDPOINT,
  fetchModels,
  fetchModelsMulti,
  fetchModelProbe,
  probeBodyHasContent,
  probeModelWithKeys,
  runProbes,
  isProbeDue,
  createProbeStore,
  buildProbeNotice,
  parseArgs,
  loadLocalConfig,
  loadConfig,
  createStateStore,
  withInstanceLock,
  resolveMonitorConfig,
  createEmptyState,
  runOnce,
  runDaemon,
  main
}
