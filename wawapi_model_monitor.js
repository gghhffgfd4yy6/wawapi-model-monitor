'use strict'

const fs = require('fs')
const got = require('got')
const {
  ENDPOINT,
  createEmptyState,
  monitorError,
  normalizeState,
  resolveMonitorConfig
} = require('./wawapi_model_monitor_core')
const { readSafeTextResult, writeAtomic } = require('./xbk_storage')

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
  const acquire = () => {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600)
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8')
      return fd
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
      const info = readLockInfo(lockPath)
      if (!info || processAlive(info.pid)) throw monitorError('LOCK_HELD', '已有 WawAPI 模型监测实例运行')
      try { fs.unlinkSync(lockPath) } catch (unlinkError) {
        throw monitorError('LOCK_HELD', '残留锁无法安全清理')
      }
      const retryFd = fs.openSync(lockPath, 'wx', 0o600)
      fs.writeFileSync(retryFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8')
      return retryFd
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

module.exports = {
  ENDPOINT,
  fetchModels,
  parseArgs,
  loadLocalConfig,
  createStateStore,
  withInstanceLock,
  resolveMonitorConfig,
  createEmptyState
}
