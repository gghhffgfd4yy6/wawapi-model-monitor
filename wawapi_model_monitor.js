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

function runOnce ({
  config,
  reportCurrent = false,
  monitor = monitorOnce,
  request = got,
  notify = defaultNotify,
  stateStore,
  now
}) {
  if (!config || typeof config !== 'object' || typeof config.apiKey !== 'string' || config.apiKey.trim() === '') {
    return Promise.reject(monitorError('CONFIG_MISSING_API_KEY', '未配置 WAWAPI_API_KEY 或本地 API Key'))
  }
  const store = stateStore || createStateStore(config.stateFile)
  return monitor({
    readState: store.read,
    writeState: store.write,
    fetchModels: () => fetchModels({ apiKey: config.apiKey, request }),
    notify,
    now,
    reportCurrent,
    watch: { watchExact: config.watchExact || [], watchPrefixes: config.watchPrefixes || [] }
  })
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
      try {
        await runDaemon({
          runOnce: () => {
            const report = args.reportCurrent && firstRun
            firstRun = false
            return executeOnce(report)
          },
          intervalMs: config.intervalMs,
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
