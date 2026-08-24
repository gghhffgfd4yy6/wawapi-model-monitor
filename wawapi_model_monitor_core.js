'use strict'

const STATUS = Object.freeze({
  HEALTHY: 'healthy',
  EMPTY: 'empty_models',
  API_ERROR: 'api_error'
})

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

module.exports = { STATUS, normalizeModelIds, diffModelIds, createEmptyState, monitorError }
