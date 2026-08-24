'use strict'

const assert = require('assert/strict')
const {
  normalizeModelIds,
  diffModelIds,
  createEmptyState,
  monitorOnce,
  resolveMonitorConfig,
  incidentKey
} = require('./wawapi_model_monitor_core')

let passed = 0
let failed = 0

function makeStateStore (initialState) {
  let state = initialState
  return {
    read: async () => state,
    write: async next => { state = next },
    get: () => state
  }
}

function jsonResponse (models, statusCode = 200) {
  return { statusCode, body: JSON.stringify({ object: 'list', data: models.map(id => ({ id })) }) }
}

async function test (name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  ❌ ${name}: ${error.message}`)
  }
}

;(async () => {
  console.log('\n========================================')
  console.log('  🧪 WawAPI 模型监测测试')
  console.log('========================================\n')

  await test('解析模型 ID、去重并稳定排序', () => {
    const actual = normalizeModelIds({
      object: 'list',
      data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-b' }]
    })
    assert.deepEqual(actual, ['model-a', 'model-b'])
  })

  await test('缺少 data 数组时拒绝响应', () => {
    assert.throws(
      () => normalizeModelIds({ object: 'list' }),
      error => error.code === 'INVALID_MODEL_RESPONSE'
    )
  })

  await test('上新和下架使用相邻快照差异', () => {
    assert.deepEqual(
      diffModelIds(['model-a', 'model-b'], ['model-b', 'model-c']),
      { added: ['model-c'], removed: ['model-a'] }
    )
  })

  await test('初始状态没有基线', () => {
    assert.deepEqual(createEmptyState(), {
      schemaVersion: 1,
      lastNonEmptyModels: null,
      lastObservationAt: null,
      lastStatus: 'healthy',
      activeIncident: null
    })
  })

  await test('配置使用环境变量覆盖本地配置', () => {
    const config = resolveMonitorConfig({
      env: {
        WAWAPI_API_KEY: 'env-key',
        WAWAPI_MODEL_INTERVAL_MS: '600000',
        WAWAPI_MODEL_WATCH_EXACT: 'model-a, model-b',
        WAWAPI_MODEL_WATCH_PREFIX: 'claude-,gpt-'
      },
      localConfig: {
        apiKey: 'local-key',
        intervalMs: 1000,
        stateFile: '/tmp/local-state.json',
        watchExact: ['local-model'],
        watchPrefixes: ['local-']
      },
      rootDir: '/tmp/monitor'
    })
    assert.equal(config.apiKey, 'env-key')
    assert.equal(config.endpoint, 'https://wawapii.com/v1/models')
    assert.equal(config.intervalMs, 600000)
    assert.deepEqual(config.watchExact, ['model-a', 'model-b'])
    assert.deepEqual(config.watchPrefixes, ['claude-', 'gpt-'])
  })

  await test('配置缺少环境变量时使用本地 API Key、间隔和关注列表', () => {
    const config = resolveMonitorConfig({
      env: {},
      localConfig: {
        apiKey: 'local-key',
        intervalMs: 1234,
        watchExact: ['local-model'],
        watchPrefixes: ['local-']
      },
      rootDir: '/tmp/monitor'
    })
    assert.equal(config.apiKey, 'local-key')
    assert.equal(config.intervalMs, 1234)
    assert.deepEqual(config.watchExact, ['local-model'])
    assert.deepEqual(config.watchPrefixes, ['local-'])
    assert.match(config.stateFile, /xianbaoku_cache[\\/]wawapi_model_monitor_state\.json$/)
  })

  await test('incidentKey 对同类异常稳定、对状态码变化敏感', () => {
    assert.equal(incidentKey({ status: 'empty_models' }), 'empty_models')
    assert.equal(incidentKey({ status: 'api_error', code: 'HTTP_401' }), 'api_error:HTTP_401')
    assert.equal(incidentKey({ status: 'api_error', code: 'HTTP_403' }), 'api_error:HTTP_403')
  })

  await test('首次非空列表只建立基线', async () => {
    const store = makeStateStore(null)
    const notices = []
    const result = await monitorOnce({
      readState: store.read,
      writeState: store.write,
      fetchModels: async () => jsonResponse(['model-a', 'model-b']),
      notify: async (title, body) => notices.push({ title, body }),
      now: () => new Date('2026-08-25T00:00:00.000Z')
    })
    assert.equal(result.outcome, 'baseline')
    assert.equal(notices.length, 0)
    assert.deepEqual(store.get().lastNonEmptyModels, ['model-a', 'model-b'])
  })

  await test('相邻快照同时产生上新和下架', async () => {
    const store = makeStateStore({
      schemaVersion: 1,
      lastNonEmptyModels: ['model-a', 'model-b'],
      lastObservationAt: '2026-08-24T23:55:00.000Z',
      lastStatus: 'healthy',
      activeIncident: null
    })
    const notices = []
    const result = await monitorOnce({
      readState: store.read,
      writeState: store.write,
      fetchModels: async () => jsonResponse(['model-b', 'model-c']),
      notify: async (title, body) => notices.push({ title, body }),
      now: () => new Date('2026-08-25T00:00:00.000Z')
    })
    assert.equal(result.outcome, 'changed')
    assert.deepEqual(result.added, ['model-c'])
    assert.deepEqual(result.removed, ['model-a'])
    assert.equal(notices.length, 1)
    assert.match(notices[0].body, /model-c/)
    assert.match(notices[0].body, /model-a/)
    assert.deepEqual(store.get().lastNonEmptyModels, ['model-b', 'model-c'])
  })

  await test('持续相同 API 异常只提醒一次', async () => {
    const store = makeStateStore({
      schemaVersion: 1,
      lastNonEmptyModels: ['model-a'],
      lastObservationAt: '2026-08-24T23:55:00.000Z',
      lastStatus: 'healthy',
      activeIncident: null
    })
    const notices = []
    const run = () => monitorOnce({
      readState: store.read,
      writeState: store.write,
      fetchModels: async () => jsonResponse([], 401),
      notify: async (title, body) => notices.push({ title, body }),
      now: () => new Date('2026-08-25T00:00:00.000Z')
    })
    const first = await run()
    const second = await run()
    assert.equal(first.outcome, 'api_error')
    assert.equal(second.outcome, 'api_error')
    assert.equal(notices.length, 1)
    assert.deepEqual(store.get().lastNonEmptyModels, ['model-a'])
  })

  await test('空列表立即提醒但不覆盖非空快照', async () => {
    const store = makeStateStore({
      schemaVersion: 1,
      lastNonEmptyModels: ['model-a'],
      lastObservationAt: '2026-08-24T23:55:00.000Z',
      lastStatus: 'healthy',
      activeIncident: null
    })
    const notices = []
    const first = await monitorOnce({
      readState: store.read,
      writeState: store.write,
      fetchModels: async () => jsonResponse([]),
      notify: async (title, body) => notices.push({ title, body }),
      now: () => new Date('2026-08-25T00:00:00.000Z')
    })
    const second = await monitorOnce({
      readState: store.read,
      writeState: store.write,
      fetchModels: async () => jsonResponse([]),
      notify: async (title, body) => notices.push({ title, body }),
      now: () => new Date('2026-08-25T00:05:00.000Z')
    })
    assert.equal(first.outcome, 'empty_models')
    assert.equal(second.outcome, 'empty_models')
    assert.equal(notices.length, 1)
    assert.match(notices[0].title, /模型列表为空/)
    assert.deepEqual(store.get().lastNonEmptyModels, ['model-a'])
  })

  await test('空列表恢复后发送恢复并按最后非空快照比较', async () => {
    const store = makeStateStore({
      schemaVersion: 1,
      lastNonEmptyModels: ['model-a', 'model-b'],
      lastObservationAt: '2026-08-25T00:00:00.000Z',
      lastStatus: 'empty_models',
      activeIncident: { kind: 'empty_models', key: 'empty_models' }
    })
    const notices = []
    const result = await monitorOnce({
      readState: store.read,
      writeState: store.write,
      fetchModels: async () => jsonResponse(['model-b', 'model-c']),
      notify: async (title, body) => notices.push({ title, body }),
      now: () => new Date('2026-08-25T00:05:00.000Z')
    })
    assert.equal(result.outcome, 'recovered')
    assert.deepEqual(result.added, ['model-c'])
    assert.deepEqual(result.removed, ['model-a'])
    assert.equal(notices.length, 1)
    assert.match(notices[0].title, /监测恢复/)
    assert.equal(store.get().activeIncident, null)
  })

  await test('通知失败时保留旧快照并返回 notification_failed', async () => {
    const store = makeStateStore({
      schemaVersion: 1,
      lastNonEmptyModels: ['model-a'],
      lastObservationAt: '2026-08-24T23:55:00.000Z',
      lastStatus: 'healthy',
      activeIncident: null
    })
    const result = await monitorOnce({
      readState: store.read,
      writeState: store.write,
      fetchModels: async () => jsonResponse(['model-b']),
      notify: async () => { throw new Error('ALL_CHANNELS_FAILED') },
      now: () => new Date('2026-08-25T00:00:00.000Z')
    })
    assert.equal(result.outcome, 'notification_failed')
    assert.equal(result.stateCommitted, false)
    assert.deepEqual(store.get().lastNonEmptyModels, ['model-a'])
  })

  await test('模型变更通知至少一个渠道成功后提交快照', async () => {
    const store = makeStateStore({
      schemaVersion: 1,
      lastNonEmptyModels: ['model-a'],
      lastObservationAt: '2026-08-24T23:55:00.000Z',
      lastStatus: 'healthy',
      activeIncident: null
    })
    const result = await monitorOnce({
      readState: store.read,
      writeState: store.write,
      fetchModels: async () => jsonResponse(['model-b']),
      notify: async () => {},
      now: () => new Date('2026-08-25T00:00:00.000Z')
    })
    assert.equal(result.stateCommitted, true)
    assert.deepEqual(store.get().lastNonEmptyModels, ['model-b'])
  })

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`)
  if (failed > 0) process.exitCode = 1
})()
