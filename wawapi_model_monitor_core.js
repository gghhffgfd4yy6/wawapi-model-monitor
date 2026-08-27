'use strict'

const path = require('path')

const ENDPOINT = 'https://wawapii.com/v1/models'
const DEFAULT_INTERVAL_MS = 300000
const MIN_INTERVAL_MS = 1000

const STATUS = Object.freeze({
  HEALTHY: 'healthy',
  EMPTY: 'empty_models',
  API_ERROR: 'api_error'
})

const TITLES = Object.freeze({
  CHANGE: '【WawAPI模型变更】',
  EMPTY: '【WawAPI模型列表为空】',
  ERROR: '【WawAPI API异常】',
  RECOVERY: '【WawAPI监测恢复】',
  REPORT: '【WawAPI当前模型列表】'
})

const VALID_STATUSES = new Set(Object.values(STATUS))

function monitorError (code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function normalizeModelIds (payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data)) {
    throw monitorError('INVALID_MODEL_RESPONSE', '模型列表响应缺少 data 数组')
  }
  const ids = payload.data.map((item, index) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || item.id.trim() === '') {
      throw monitorError('INVALID_MODEL_RESPONSE', `模型列表第 ${index} 项缺少合法 id`)
    }
    return item.id.trim()
  })
  return [...new Set(ids)].sort()
}

function diffModelIds (previousModels, currentModels) {
  const previous = new Set(Array.isArray(previousModels) ? previousModels : [])
  const current = new Set(Array.isArray(currentModels) ? currentModels : [])
  return {
    added: [...current].filter(id => !previous.has(id)).sort(),
    removed: [...previous].filter(id => !current.has(id)).sort()
  }
}

function createEmptyState () {
  return {
    schemaVersion: 1,
    lastNonEmptyModels: null,
    lastObservationAt: null,
    lastStatus: STATUS.HEALTHY,
    activeIncident: null
  }
}

function listValue (value) {
  if (Array.isArray(value)) {
    return value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean)
  }
  if (typeof value !== 'string') return []
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function firstConfigured (...values) {
  return values.find(value => {
    if (typeof value === 'string') return value.trim() !== ''
    if (typeof value === 'number') return Number.isFinite(value)
    if (Array.isArray(value)) return value.length > 0
    return false
  })
}

function resolvePath (rootDir, filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') return ''
  return path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath)
}

function resolveMonitorConfig ({ env = process.env, localConfig = {}, rootDir = __dirname } = {}) {
  // 支持单个 apiKey 或 apiKeys 数组
  const apiKeysRaw = Array.isArray(localConfig.apiKeys) ? localConfig.apiKeys : []
  const envApiKey = typeof env.WAWAPI_API_KEY === 'string' && env.WAWAPI_API_KEY.trim() ? env.WAWAPI_API_KEY.trim() : ''
  const localApiKey = typeof localConfig.apiKey === 'string' && localConfig.apiKey.trim() ? localConfig.apiKey.trim() : ''
  // 环境变量用于运行时临时覆盖，必须成为首选 Key；其余 Key 仍可用于冗余查询。
  const apiKeys = [...new Set([envApiKey, ...apiKeysRaw.map(k => String(k).trim()).filter(Boolean), localApiKey].filter(Boolean))]
  const intervalRaw = firstConfigured(env.WAWAPI_MODEL_INTERVAL_MS, localConfig.intervalMs)
  const parsedInterval = Number(intervalRaw)
  const intervalMs = Number.isFinite(parsedInterval) && parsedInterval >= MIN_INTERVAL_MS
    ? parsedInterval
    : DEFAULT_INTERVAL_MS
  const stateFile = resolvePath(
    rootDir,
    firstConfigured(
      env.WAWAPI_MODEL_STATE_FILE,
      localConfig.stateFile,
      path.join('xianbaoku_cache', 'wawapi_model_monitor_state.json')
    )
  )
  // 模型探测：默认关闭；配置 probeModels 后才启用。probeIntervalMs 控制两次探测的最小间隔。
  // N1: 配置去重，避免同一模型被探测两次/发两条通知。
  const probeModels = [...new Set(listValue(firstConfigured(env.WAWAPI_PROBE_MODELS, localConfig.probeModels)))]
  const probeIntervalRaw = firstConfigured(env.WAWAPI_PROBE_INTERVAL_MS, localConfig.probeIntervalMs)
  const parsedProbeInterval = Number(probeIntervalRaw)
  const probeIntervalMs = probeModels.length > 0 && Number.isFinite(parsedProbeInterval) && parsedProbeInterval >= 0
    ? parsedProbeInterval
    : 3600000 // 默认 1 小时
  return {
    endpoint: ENDPOINT,
    apiKey: apiKeys[0] || '',
    apiKeys,
    intervalMs,
    stateFile,
    watchExact: listValue(firstConfigured(env.WAWAPI_MODEL_WATCH_EXACT, localConfig.watchExact)),
    watchPrefixes: listValue(firstConfigured(env.WAWAPI_MODEL_WATCH_PREFIX, localConfig.watchPrefixes)),
    probeModels,
    probeIntervalMs
  }
}

// 模型探测状态：记录每个指定模型最近一次可用性探测结果。
function createProbeState (model) {
  return {
    model,
    state: 'unknown', // unknown | ok | failing
    lastProbedAt: null
  }
}

// 归一化探测状态数组；非法项丢弃，缺字段补默认。
function normalizeProbeStates (probeStates) {
  if (probeStates === null || probeStates === undefined) return []
  if (!Array.isArray(probeStates)) throw monitorError('STATE_INVALID', '状态文件中的探测状态无效')
  return probeStates
    .filter(item => item && typeof item === 'object' && typeof item.model === 'string' && item.model.trim())
    .map(item => ({
      model: item.model.trim(),
      state: item.state === 'ok' || item.state === 'failing' ? item.state : 'unknown',
      lastProbedAt: typeof item.lastProbedAt === 'string' ? item.lastProbedAt : null
    }))
}

// 判断某个模型本次探测是否应执行（core 唯一实现，monitor.isProbeDue 委托此处）：
// - 无记录/无时间戳 → 到期（首次或状态损坏）
// - 无效日期 → 到期（避免 NaN 比较导致永不探测）
// - 失败/未知态 → 距上次探测 >= 5 分钟（固定重试间隔，不受外层 daemon 间隔影响）
// - 成功态 → 按 probeIntervalMs 间隔；<=0 视为每次到期
function shouldProbe (probeState, probeIntervalMs, nowIso) {
  const now = new Date(nowIso).getTime()
  if (!Number.isFinite(now)) return true
  if (!probeState || !probeState.lastProbedAt) return true
  const last = new Date(probeState.lastProbedAt).getTime()
  if (!Number.isFinite(last)) return true
  if (probeState.state !== 'ok') {
    return now - last >= 300000 // 失败/未知：5 分钟重试
  }
  if (probeIntervalMs <= 0) return true
  return now - last >= probeIntervalMs
}

// 探测结果归一化：成功/失败两个状态枚举。
function probeResult (ok, detail) {
  return ok
    ? { state: 'ok', detail: detail || '' }
    : { state: 'failing', detail: detail || '无响应' }
}

// 对比旧状态->新状态，返回是否需要通知（core 唯一实现）：
// - unknown -> ok：首次建立正常基线，不通知。
// - unknown -> failing：首次探测就发现模型挂了，需要通知。
// - ok <-> failing：状态翻转（刚挂/刚恢复），需要通知。
// - failing -> failing / ok -> ok：持续同态，不通知。
function probeTransition (previous, next) {
  const prev = previous ? previous.state : 'unknown'
  if (prev === 'unknown') return next.state === 'failing'
  return prev !== next.state
}

// 生成探测报告文本（用于通知）。
function buildProbeReport ({ model, previous, next }) {
  const okLabels = { ok: '✅ 可用', failing: '❌ 不可用', unknown: '未知' }
  const prevLabel = previous ? okLabels[previous.state] || '未知' : '首次探测'
  const lines = [
    `模型：${model}`,
    `状态：${prevLabel} → ${okLabels[next.state]}`
  ]
  if (next.detail) lines.push(`说明：${next.detail}`)
  return lines.join('\n')
}

function normalizeModelsOrNull (models) {
  if (models === null) return null
  if (!Array.isArray(models) || models.some(id => typeof id !== 'string' || id.trim() === '')) {
    throw monitorError('STATE_INVALID', '状态文件中的模型快照无效')
  }
  return [...new Set(models.map(id => id.trim()))].sort()
}

function normalizeState (state) {
  if (state === null || state === undefined) return createEmptyState()
  if (!state || typeof state !== 'object' || state.schemaVersion !== 1) {
    throw monitorError('STATE_INVALID', '状态文件结构或版本无效')
  }
  const activeIncident = state.activeIncident
  if (activeIncident !== null && (!activeIncident || typeof activeIncident !== 'object' ||
        typeof activeIncident.key !== 'string' || typeof activeIncident.kind !== 'string')) {
    throw monitorError('STATE_INVALID', '状态文件中的异常事件无效')
  }
  if (state.lastObservationAt !== null && typeof state.lastObservationAt !== 'string') {
    throw monitorError('STATE_INVALID', '状态文件中的观测时间无效')
  }
  if (!VALID_STATUSES.has(state.lastStatus)) {
    throw monitorError('STATE_INVALID', '状态文件中的状态无效')
  }
  return {
    schemaVersion: 1,
    lastNonEmptyModels: normalizeModelsOrNull(state.lastNonEmptyModels),
    lastObservationAt: state.lastObservationAt || null,
    lastStatus: state.lastStatus,
    activeIncident: activeIncident ? { kind: activeIncident.kind, key: activeIncident.key } : null
  }
}

function incidentKey (observation) {
  if (!observation || observation.status === STATUS.EMPTY) return STATUS.EMPTY
  if (observation.status === STATUS.API_ERROR) return STATUS.API_ERROR
  return ''
}

function isoNow (now) {
  const value = typeof now === 'function' ? now() : now
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return new Date().toISOString()
  return date.toISOString()
}

function parseResponseBody (body) {
  if (body && typeof body === 'object') return body
  if (typeof body !== 'string') throw monitorError('INVALID_RESPONSE_BODY', 'WawAPI 响应体不是 JSON 文本')
  try { return JSON.parse(body) } catch (error) {
    throw monitorError('INVALID_JSON', 'WawAPI 响应不是合法 JSON')
  }
}

function responseCode (payload) {
  if (!payload || typeof payload !== 'object') return ''
  if (typeof payload.code === 'string' || typeof payload.code === 'number') return String(payload.code)
  if (payload.error && typeof payload.error === 'object' &&
      (typeof payload.error.code === 'string' || typeof payload.error.code === 'number')) {
    return String(payload.error.code)
  }
  return ''
}

function safeErrorCode (error) {
  if (!error || typeof error !== 'object') return 'UNKNOWN'
  if (typeof error.code === 'string' && error.code.trim() !== '') {
    return error.code.trim().replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()
  }
  if (Number.isInteger(error.statusCode)) return `HTTP_${error.statusCode}`
  return 'NETWORK_ERROR'
}

function isWatched (modelId, watch = {}) {
  const exact = Array.isArray(watch.watchExact) ? watch.watchExact : []
  const prefixes = Array.isArray(watch.watchPrefixes) ? watch.watchPrefixes : []
  return exact.includes(modelId) || prefixes.some(prefix => modelId.startsWith(prefix))
}

function modelLines (models, watch) {
  if (!models || models.length === 0) return '（无）'
  return models.map(id => `${isWatched(id, watch) ? '⭐ ' : ''}- ${id}`).join('\n')
}

function changeSections (added, removed, watch) {
  const sections = []
  if (added.length > 0) sections.push(`上新模型：\n${modelLines(added, watch)}`)
  if (removed.length > 0) sections.push(`下架模型：\n${modelLines(removed, watch)}`)
  return sections
}

function buildChangeBody ({ added, removed, watch }) {
  return changeSections(added, removed, watch).join('\n\n')
}

function buildEmptyBody (previousModels) {
  const previousCount = Array.isArray(previousModels) ? previousModels.length : '无基线'
  return [
    '接口返回：HTTP 200',
    '当前模型数量：0',
    `上一次有效模型数量：${previousCount}`,
    '',
    '可能原因：',
    '- 模型全部下架',
    '- API 临时异常',
    '- API Key 权限或余额异常',
    '',
    '已保留上一次有效模型快照。'
  ].join('\n')
}

function buildErrorBody (observation) {
  const lines = [
    `接口：${ENDPOINT}`,
    `错误分类：${observation.code || 'UNKNOWN'}`
  ]
  if (Number.isInteger(observation.statusCode)) lines.splice(1, 0, `HTTP 状态：${observation.statusCode}`)
  lines.push('', '本次未更新模型快照。', '后续恢复后会自动继续监测。')
  return lines.join('\n')
}

function buildRecoveryBody ({ currentModels, added, removed, watch, reportCurrent }) {
  const sections = ['接口已恢复正常', `当前模型数量：${currentModels.length}`]
  const changes = changeSections(added, removed, watch)
  if (changes.length > 0) sections.push('', ...changes)
  if (reportCurrent) sections.push('', `当前完整模型列表：\n${modelLines(currentModels, watch)}`)
  return sections.join('\n')
}

function buildReportBody (currentModels, watch) {
  return `当前模型数量：${currentModels.length}\n\n当前完整模型列表：\n${modelLines(currentModels, watch)}`
}

function buildObservation (response) {
  if (!response || !Number.isInteger(response.statusCode)) {
    throw monitorError('NETWORK_ERROR', 'WawAPI 没有返回有效 HTTP 响应')
  }
  if (response.statusCode !== 200) {
    const payload = (() => {
      try { return parseResponseBody(response.body) } catch (error) { return null }
    })()
    const code = responseCode(payload) || `HTTP_${response.statusCode}`
    const error = monitorError(code, `WawAPI 返回 HTTP ${response.statusCode}`)
    error.statusCode = response.statusCode
    return { status: STATUS.API_ERROR, code: safeErrorCode(error), statusCode: response.statusCode }
  }
  const payload = parseResponseBody(response.body)
  const models = normalizeModelIds(payload)
  return models.length === 0
    ? { status: STATUS.EMPTY, models }
    : { status: STATUS.HEALTHY, models }
}

function observationFromError (error) {
  return {
    status: STATUS.API_ERROR,
    code: safeErrorCode(error),
    statusCode: Number.isInteger(error && error.statusCode) ? error.statusCode : null
  }
}

function committedState (state, patch, timestamp) {
  return {
    ...state,
    ...patch,
    lastObservationAt: timestamp
  }
}

async function monitorOnce ({
  readState,
  writeState,
  fetchModels,
  notify,
  now = () => new Date(),
  reportCurrent = false,
  watch = { watchExact: [], watchPrefixes: [] }
}) {
  if (typeof readState !== 'function' || typeof writeState !== 'function' ||
      typeof fetchModels !== 'function' || typeof notify !== 'function') {
    throw new TypeError('monitorOnce 缺少必要依赖')
  }
  const state = normalizeState(await readState())
  const timestamp = isoNow(now)
  let observation
  try {
    observation = buildObservation(await fetchModels())
  } catch (error) {
    observation = observationFromError(error)
  }

  if (observation.status === STATUS.EMPTY || observation.status === STATUS.API_ERROR) {
    const key = incidentKey(observation)
    const sameIncident = state.activeIncident && state.activeIncident.key === key
    if (!sameIncident) {
      const title = observation.status === STATUS.EMPTY ? TITLES.EMPTY : TITLES.ERROR
      const body = observation.status === STATUS.EMPTY
        ? buildEmptyBody(state.lastNonEmptyModels)
        : buildErrorBody(observation)
      try {
        await notify(title, body)
      } catch (error) {
        return {
          outcome: 'notification_failed',
          added: [],
          removed: [],
          notified: false,
          stateCommitted: false,
          error
        }
      }
      const nextState = committedState(state, {
        lastStatus: observation.status,
        activeIncident: { kind: observation.status, key }
      }, timestamp)
      await writeState(nextState)
      return {
        outcome: observation.status,
        added: [],
        removed: [],
        notified: true,
        stateCommitted: true
      }
    }
    await writeState(committedState(state, { lastStatus: observation.status }, timestamp))
    return {
      outcome: observation.status,
      added: [],
      removed: [],
      notified: false,
      stateCommitted: true
    }
  }

  const currentModels = observation.models
  const hasBaseline = Array.isArray(state.lastNonEmptyModels)
  const diff = hasBaseline
    ? diffModelIds(state.lastNonEmptyModels, currentModels)
    : { added: [], removed: [] }
  const recovering = Boolean(state.activeIncident)
  const hasChanges = diff.added.length > 0 || diff.removed.length > 0
  const needsReport = reportCurrent
  const needsNotification = recovering || hasChanges || needsReport

  if (!hasBaseline && !needsReport && !recovering) {
    await writeState(committedState(state, {
      lastNonEmptyModels: currentModels,
      lastStatus: STATUS.HEALTHY,
      activeIncident: null
    }, timestamp))
    return { outcome: 'baseline', added: [], removed: [], notified: false, stateCommitted: true }
  }

  if (needsNotification) {
    let title = TITLES.CHANGE
    let body = buildChangeBody({ added: diff.added, removed: diff.removed, watch })
    if (recovering) {
      title = TITLES.RECOVERY
      body = buildRecoveryBody({
        currentModels,
        added: diff.added,
        removed: diff.removed,
        watch,
        reportCurrent
      })
    } else if (!hasChanges && needsReport) {
      title = TITLES.REPORT
      body = buildReportBody(currentModels, watch)
    } else if (needsReport) {
      body += `\n\n当前完整模型列表：\n${modelLines(currentModels, watch)}`
    }
    try {
      await notify(title, body)
    } catch (error) {
      return {
        outcome: 'notification_failed',
        added: diff.added,
        removed: diff.removed,
        notified: false,
        stateCommitted: false,
        error
      }
    }
  }

  await writeState(committedState(state, {
    lastNonEmptyModels: currentModels,
    lastStatus: STATUS.HEALTHY,
    activeIncident: null
  }, timestamp))
  let outcome = 'unchanged'
  if (recovering) outcome = 'recovered'
  else if (hasChanges) outcome = 'changed'
  else if (needsReport) outcome = 'reported'
  return {
    outcome,
    added: diff.added,
    removed: diff.removed,
    notified: needsNotification,
    stateCommitted: true
  }
}

module.exports = {
  ENDPOINT,
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  STATUS,
  TITLES,
  normalizeModelIds,
  diffModelIds,
  createEmptyState,
  resolveMonitorConfig,
  normalizeState,
  incidentKey,
  monitorOnce,
  buildObservation,
  isWatched,
  buildChangeBody,
  buildEmptyBody,
  buildErrorBody,
  buildRecoveryBody,
  buildReportBody,
  createProbeState,
  normalizeProbeStates,
  shouldProbe,
  probeResult,
  probeTransition,
  buildProbeReport,
  monitorError
}
