'use strict'

const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  normalizeModelIds,
  diffModelIds,
  createEmptyState,
  monitorOnce,
  resolveMonitorConfig,
  incidentKey,
  normalizeState,
  normalizeProbeStates,
  shouldProbe,
  probeResult,
  probeTransition,
  buildProbeReport
} = require('./wawapi_model_monitor_core')
const {
  fetchModels,
  fetchModelsMulti,
  fetchModelProbe,
  runProbes,
  createProbeStore,
  buildProbeNotice,
  parseArgs,
  loadLocalConfig,
  createStateStore,
  withInstanceLock,
  runOnce,
  main,
  runDaemon
} = require('./wawapi_model_monitor')

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

  await test('WawAPI 请求使用固定 endpoint 和 Bearer 鉴权', async () => {
    let captured
    const response = await fetchModels({
      apiKey: 'sk-test-key',
      request: async (url, options) => {
        captured = { url, options }
        return { statusCode: 200, body: '{"object":"list","data":[]}' }
      }
    })
    assert.equal(response.statusCode, 200)
    assert.equal(captured.url, 'https://wawapii.com/v1/models')
    assert.equal(captured.options.headers.authorization, 'Bearer sk-test-key')
    assert.equal(captured.options.throwHttpErrors, false)
    assert.equal(captured.options.retry.limit, 0)
  })

  await test('CLI 参数解析支持两种运行模式', () => {
    assert.deepEqual(parseArgs(['--once']), { mode: 'once', reportCurrent: false })
    assert.deepEqual(parseArgs(['--daemon', '--report-current']), { mode: 'daemon', reportCurrent: true })
    assert.throws(() => parseArgs(['--unknown']), /未知参数/)
  })

  await test('状态文件可原子读写并拒绝损坏 JSON', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wawapi-monitor-state-'))
    const statePath = path.join(dir, 'state.json')
    const store = createStateStore(statePath)
    assert.equal(await store.read(), null)
    await store.write({
      schemaVersion: 1,
      lastNonEmptyModels: ['model-a'],
      lastObservationAt: '2026-08-25T00:00:00.000Z',
      lastStatus: 'healthy',
      activeIncident: null
    })
    assert.deepEqual((await store.read()).lastNonEmptyModels, ['model-a'])
    fs.writeFileSync(statePath, '{bad-json', 'utf8')
    await assert.rejects(store.read(), error => error.code === 'STATE_INVALID')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('活跃锁阻止并发实例，任务结束后释放', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wawapi-monitor-lock-'))
    const lockPath = path.join(dir, 'state.json.lock')
    await withInstanceLock(lockPath, async () => {
      await assert.rejects(
        withInstanceLock(lockPath, async () => {}),
        error => error.code === 'LOCK_HELD'
      )
      assert.equal(fs.existsSync(lockPath), true)
    })
    assert.equal(fs.existsSync(lockPath), false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('已退出进程的残留锁可安全恢复', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wawapi-monitor-stale-'))
    const lockPath = path.join(dir, 'state.json.lock')
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, startedAt: '2026-08-25T00:00:00.000Z' }), 'utf8')
    let ran = false
    await withInstanceLock(lockPath, async () => { ran = true })
    assert.equal(ran, true)
    assert.equal(fs.existsSync(lockPath), false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('本地配置文件不存在时返回空对象', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wawapi-monitor-config-'))
    assert.deepEqual(loadLocalConfig(path.join(dir, 'missing.local.js')), {})
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('单次模式只调用一次核心监测', async () => {
    let calls = 0
    const code = await main(['--once'], {
      config: { apiKey: 'sk-test-key', stateFile: '/tmp/wawapi-state.json', watchExact: [], watchPrefixes: [] },
      monitorOnce: async () => { calls += 1; return { outcome: 'unchanged' } },
      withInstanceLock: async (_path, task) => task(),
      logger: { log: () => {}, error: () => {} }
    })
    assert.equal(code, 0)
    assert.equal(calls, 1)
  })

  await test('常驻模式把同一个 runOnce 交给调度器', async () => {
    let calls = 0
    const controller = new AbortController()
    const loop = async run => {
      await run()
      calls += 1
      controller.abort()
    }
    await runDaemon({
      runOnce: async () => { calls += 1 },
      intervalMs: 300000,
      signal: controller.signal,
      loop
    })
    assert.equal(calls, 2)
  })

  await test('关注列表只标记重点，不过滤其他模型变化', async () => {
    const store = makeStateStore({
      schemaVersion: 1,
      lastNonEmptyModels: ['model-a'],
      lastObservationAt: '2026-08-25T00:00:00.000Z',
      lastStatus: 'healthy',
      activeIncident: null
    })
    const notices = []
    const result = await monitorOnce({
      readState: store.read,
      writeState: store.write,
      fetchModels: async () => jsonResponse(['model-a', 'claude-opus-4']),
      notify: async (title, body) => notices.push({ title, body }),
      watch: { watchExact: ['claude-opus-4'], watchPrefixes: ['gpt-'] },
      now: () => new Date('2026-08-25T00:05:00.000Z')
    })
    assert.deepEqual(result.added, ['claude-opus-4'])
    assert.match(notices[0].body, /⭐/)
  })

  await test('report-current 在无变化时仍发送当前列表', async () => {
    const store = makeStateStore({
      schemaVersion: 1,
      lastNonEmptyModels: ['model-a'],
      lastObservationAt: '2026-08-25T00:00:00.000Z',
      lastStatus: 'healthy',
      activeIncident: null
    })
    const notices = []
    const result = await monitorOnce({
      readState: store.read,
      writeState: store.write,
      fetchModels: async () => jsonResponse(['model-a']),
      notify: async (title, body) => notices.push({ title, body }),
      reportCurrent: true,
      now: () => new Date('2026-08-25T00:05:00.000Z')
    })
    assert.equal(result.outcome, 'reported')
    assert.equal(notices.length, 1)
    assert.match(notices[0].title, /当前模型列表/)
    assert.match(notices[0].body, /model-a/)
  })

  await test('多个 HTTP API 异常都保留旧快照并立即分类提醒', async () => {
    for (const statusCode of [403, 404, 429, 500]) {
      const store = makeStateStore({
        schemaVersion: 1,
        lastNonEmptyModels: ['model-a'],
        lastObservationAt: '2026-08-24T23:55:00.000Z',
        lastStatus: 'healthy',
        activeIncident: null
      })
      const notices = []
      const result = await monitorOnce({
        readState: store.read,
        writeState: store.write,
        fetchModels: async () => ({ statusCode, body: '{}' }),
        notify: async (title, body) => notices.push({ title, body }),
        now: () => new Date('2026-08-25T00:00:00.000Z')
      })
      assert.equal(result.outcome, 'api_error')
      assert.equal(notices.length, 1)
      assert.match(notices[0].title, /API异常/)
      assert.deepEqual(store.get().lastNonEmptyModels, ['model-a'])
    }
  })

  await test('超时、无效 JSON 和缺失模型 ID 都分类为 API 异常', async () => {
    const scenarios = [
      {
        fetchModels: async () => { const error = new Error('timeout'); error.code = 'ETIMEDOUT'; throw error }
      },
      { fetchModels: async () => ({ statusCode: 200, body: '{bad-json' }) },
      { fetchModels: async () => ({ statusCode: 200, body: JSON.stringify({ data: [{}] }) }) }
    ]
    for (const scenario of scenarios) {
      const store = makeStateStore({
        schemaVersion: 1,
        lastNonEmptyModels: ['model-a'],
        lastObservationAt: '2026-08-24T23:55:00.000Z',
        lastStatus: 'healthy',
        activeIncident: null
      })
      const notices = []
      const result = await monitorOnce({
        readState: store.read,
        writeState: store.write,
        fetchModels: scenario.fetchModels,
        notify: async (title, body) => notices.push({ title, body }),
        now: () => new Date('2026-08-25T00:00:00.000Z')
      })
      assert.equal(result.outcome, 'api_error')
      assert.equal(notices.length, 1)
      assert.deepEqual(store.get().lastNonEmptyModels, ['model-a'])
    }
  })

  await test('API 错误恢复时只发送一次恢复通知', async () => {
    const store = makeStateStore({
      schemaVersion: 1,
      lastNonEmptyModels: ['model-a'],
      lastObservationAt: '2026-08-25T00:00:00.000Z',
      lastStatus: 'api_error',
      activeIncident: { kind: 'api_error', key: 'api_error:HTTP_500' }
    })
    const notices = []
    const run = () => monitorOnce({
      readState: store.read,
      writeState: store.write,
      fetchModels: async () => jsonResponse(['model-a']),
      notify: async (title, body) => notices.push({ title, body }),
      now: () => new Date('2026-08-25T00:05:00.000Z')
    })
    const first = await run()
    const second = await run()
    assert.equal(first.outcome, 'recovered')
    assert.equal(second.outcome, 'unchanged')
    assert.equal(notices.length, 1)
    assert.match(notices[0].title, /监测恢复/)
  })

  await test('缺少 API Key 时 CLI 返回非零且不请求网络', async () => {
    let requested = false
    const errors = []
    const code = await main(['--once'], {
      config: { apiKey: '', stateFile: '/tmp/wawapi-state.json' },
      request: async () => { requested = true },
      logger: { log: () => {}, error: message => errors.push(message) }
    })
    assert.equal(code, 1)
    assert.equal(requested, false)
    assert.match(errors[0], /CONFIG_MISSING_API_KEY/)
  })

  await test('状态文件符号链接不会被读取', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wawapi-monitor-symlink-'))
    const targetPath = path.join(dir, 'target.json')
    const statePath = path.join(dir, 'state.json')
    fs.writeFileSync(targetPath, JSON.stringify(createEmptyState()), 'utf8')
    fs.symlinkSync(targetPath, statePath)
    await assert.rejects(
      createStateStore(statePath).read(),
      error => error.code === 'STATE_INVALID'
    )
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('无法判断锁持有者时不删除锁文件', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wawapi-monitor-lock-invalid-'))
    const lockPath = path.join(dir, 'state.json.lock')
    fs.writeFileSync(lockPath, '{not-json', 'utf8')
    await assert.rejects(
      withInstanceLock(lockPath, async () => {}),
      error => error.code === 'LOCK_HELD'
    )
    assert.equal(fs.existsSync(lockPath), true)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('状态文件未知状态不会静默归一化', () => {
    assert.throws(
      () => normalizeState({
        schemaVersion: 1,
        lastNonEmptyModels: ['model-a'],
        lastObservationAt: null,
        lastStatus: 'unknown',
        activeIncident: null
      }),
      error => error.code === 'STATE_INVALID'
    )
  })

  await test('锁目录不存在时会先创建父目录', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wawapi-monitor-lock-parent-'))
    const lockPath = path.join(dir, 'nested', 'state.json.lock')
    await withInstanceLock(lockPath, async () => {
      assert.equal(fs.existsSync(lockPath), true)
    })
    assert.equal(fs.existsSync(lockPath), false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('探测状态归一化丢弃非法项并补默认', () => {
    assert.deepEqual(
      normalizeProbeStates([
        { model: ' m1 ', state: 'ok', lastProbedAt: '2026-08-25T00:00:00.000Z' },
        { model: 'm2', state: 'bogus' },
        { model: '', state: 'ok' },
        null
      ]),
      [
        { model: 'm1', state: 'ok', lastProbedAt: '2026-08-25T00:00:00.000Z' },
        { model: 'm2', state: 'unknown', lastProbedAt: null }
      ]
    )
    assert.deepEqual(normalizeProbeStates(null), [])
  })

  await test('shouldProbe 仅在未知/失败/距上次成功超间隔时触发', () => {
    const now = '2026-08-25T05:00:00.000Z'
    assert.equal(shouldProbe(null, 3600000, now), true)
    assert.equal(shouldProbe({ state: 'ok', lastProbedAt: '2026-08-25T04:30:00.000Z' }, 3600000, now), false)
    assert.equal(shouldProbe({ state: 'ok', lastProbedAt: '2026-08-25T03:59:00.000Z' }, 3600000, now), true)
    assert.equal(shouldProbe({ state: 'failing', lastProbedAt: '2026-08-25T04:00:00.000Z' }, 3600000, now), true)
  })

  await test('探测状态翻转和报告文本', () => {
    assert.equal(probeTransition(null, { state: 'ok' }), false)
    assert.equal(probeTransition({ state: 'ok' }, { state: 'failing' }), true)
    assert.equal(probeTransition({ state: 'ok' }, { state: 'ok' }), false)
    const body = buildProbeReport({ model: 'm1', previous: { state: 'ok' }, next: probeResult(false, 'HTTP 503') })
    assert.match(body, /m1/)
    assert.match(body, /不可用/)
    assert.match(body, /HTTP 503/)
  })

  await test('runProbes 首次探测不通知、状态翻转触发通知、间隔内不重复探测', async () => {
    let probes = 0
    const calls = []
    const run = (state, nowIso, ok) => runProbes({
      apiKeys: ['key'],
      probeModels: ['m1'],
      probeIntervalMs: 3600000,
      state: { probeStates: state },
      now: () => new Date(nowIso),
      fetchProbe: async () => { probes++; return ok ? { ok: true, detail: '' } : { ok: false, detail: 'HTTP 503' } }
    })

    // 首次：unknown -> ok，不通知
    let r = await run([], '2026-08-25T05:00:00.000Z', true)
    calls.push(['first', r.notifications.length, probes])
    assert.equal(r.notifications.length, 0)
    assert.equal(r.probeStates[0].state, 'ok')

    // 间隔内刚测过：不再探测
    const p1 = probes
    r = await run(r.probeStates, '2026-08-25T05:30:00.000Z', true)
    assert.equal(r.notifications.length, 0)
    assert.equal(probes, p1) // 未新增探测次数

    // 超 1h 后探测失败：ok -> failing 通知
    const prev = [{ model: 'm1', state: 'ok', lastProbedAt: '2026-08-25T04:00:00.000Z' }]
    r = await run(prev, '2026-08-25T05:30:00.000Z', false)
    assert.equal(r.notifications.length, 1)
    assert.equal(r.notifications[0].model, 'm1')
    assert.equal(r.probeStates[0].state, 'failing')
  })

  await test('runOnce 启用探测时并行执行并持久化探测状态（不干扰模型监测结果）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wawapi-probe-once-'))
    const stateFile = path.join(dir, 'state.json')
    const probeFile = path.join(dir, 'wawapi_probe_state.json')
    const notices = []
    const result = await runOnce({
      config: { apiKey: 'key', stateFile, probeModels: ['m1'], probeIntervalMs: 3600000, watchExact: [], watchPrefixes: [] },
      monitor: async () => ({ outcome: 'unchanged' }),
      notify: async (t, b) => notices.push({ t, b }),
      runProbes: async () => ({ notifications: [{ model: 'm1', previous: { state: 'ok' }, next: { state: 'failing' }, detail: 'HTTP 503' }], probeStates: [{ model: 'm1', state: 'failing', lastProbedAt: '2026-08-25T05:00:00.000Z' }] })
    })
    assert.equal(result.outcome, 'unchanged')
    assert.equal(notices.length, 1)
    assert.match(notices[0].t, /探测/)
    assert.equal(fs.existsSync(probeFile), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(probeFile, 'utf8')).probeStates[0].state, 'failing')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('runOnce 未配置 probeModels 时不创建探测状态', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wawapi-no-probe-'))
    const result = await runOnce({
      config: { apiKey: 'key', stateFile: path.join(dir, 'state.json'), probeModels: [], probeIntervalMs: 3600000, watchExact: [], watchPrefixes: [] },
      monitor: async () => ({ outcome: 'unchanged' }),
      notify: async () => {}
    })
    assert.equal(result.outcome, 'unchanged')
    assert.equal(fs.existsSync(path.join(dir, 'wawapi_probe_state.json')), false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('fetchModelProbe HTTP 200 且含内容算可用，否则不可用', async () => {
    const mockRequest = async (url, options) => ({ statusCode: 200, body: JSON.stringify({ choices: [{ message: { content: 'hi' } }] }) })
    const ok = await fetchModelProbe({ apiKey: 'key', model: 'm1', request: mockRequest })
    assert.equal(ok.ok, true)
    const bad = await fetchModelProbe({ apiKey: 'key', model: 'm1', request: async () => ({ statusCode: 503, body: '{}' }) })
    assert.equal(bad.ok, false)
    assert.match(bad.detail, /503/)
  })

  await test('所有 Key 都 HTTP 报错时抛 API 异常而非假空列表', async () => {
    // 全 503：合并逻辑应抛 HTTP_503，让 monitorOnce 归类为 API 异常
    await assert.rejects(
      fetchModelsMulti({ apiKeys: ['k1', 'k2'], request: async () => ({ statusCode: 503, body: 'down' }) }),
      error => error.code === 'HTTP_503'
    )
    // 一个成功一个失败：正常合并成功的模型
    const merged = await fetchModelsMulti({
      apiKeys: ['ok', 'bad'],
      request: async (url, options) => {
        const key = options.headers.authorization.replace('Bearer ', '')
        return key === 'ok'
          ? { statusCode: 200, body: JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }) }
          : { statusCode: 503, body: 'down' }
      }
    })
    assert.deepEqual(JSON.parse(merged.body).data.map(x => x.id), ['m1', 'm2'])
    // 多 Key 都返回 200 但缺 data：也算失败
    await assert.rejects(
      fetchModelsMulti({ apiKeys: ['k1', 'k2'], request: async () => ({ statusCode: 200, body: JSON.stringify({ foo: 1 }) }) }),
      error => error.code === 'HTTP_200'
    )
  })

  await test('探测响应判定：空数组/空字符串不算可用（B2）', async () => {
    // 空 choices 数组：旧逻辑会误判可用，现在应判不可用
    const emptyChoices = await fetchModelProbe({ apiKey: 'key', model: 'm1', request: async () => ({ statusCode: 200, body: JSON.stringify({ choices: [] }) }) })
    assert.equal(emptyChoices.ok, false)
    // 空 data 数组：同理
    const emptyData = await fetchModelProbe({ apiKey: 'key', model: 'm1', request: async () => ({ statusCode: 200, body: JSON.stringify({ data: [] }) }) })
    assert.equal(emptyData.ok, false)
    // 空 output_text：不可用
    const emptyText = await fetchModelProbe({ apiKey: 'key', model: 'm1', request: async () => ({ statusCode: 200, body: JSON.stringify({ output_text: '' }) }) })
    assert.equal(emptyText.ok, false)
    // 真实内容：可用（choices 非空）
    const real = await fetchModelProbe({ apiKey: 'key', model: 'm1', request: async () => ({ statusCode: 200, body: JSON.stringify({ choices: [{ message: { content: 'hi' } }] }) }) })
    assert.equal(real.ok, true)
    // 请求体校验：max_tokens 应 >= 1 且实际使用 16
    let sentBody = null
    await fetchModelProbe({ apiKey: 'key', model: 'm1', request: async (url, options) => { sentBody = options.json; return { statusCode: 200, body: JSON.stringify({ choices: [{ message: { content: 'hi' } }] }) } } })
    assert.equal(sentBody.max_tokens, 16)
  })

  await test('S1/C1: 合法空列表 + 部分Key失败 → 不抛异常归为空列表', async () => {
    // 一个 Key 返回合法 200 data:[]，另一个 Key 503：应成功返回空列表而非抛错
    const merged = await fetchModelsMulti({
      apiKeys: ['empty', 'bad'],
      request: async (url, options) => {
        const key = options.headers.authorization.replace('Bearer ', '')
        return key === 'empty'
          ? { statusCode: 200, body: JSON.stringify({ data: [] }) }
          : { statusCode: 503, body: 'down' }
      }
    })
    assert.equal(merged.statusCode, 200)
    assert.deepEqual(JSON.parse(merged.body).data, [])
  })

  await test('S2/C2: choices 项内无内容不算可用', async () => {
    const cases = [
      { choices: [{}] },
      { choices: [{ message: { content: '' } }] },
      { choices: [{ message: {} }] },
      { choices: [{ text: '' }] }
    ]
    for (const body of cases) {
      const r = await fetchModelProbe({ apiKey: 'key', model: 'm1', request: async () => ({ statusCode: 200, body: JSON.stringify(body) }) })
      assert.equal(r.ok, false, `应判不可用: ${JSON.stringify(body)}`)
    }
    // 项内有内容才算可用
    const ok = await fetchModelProbe({ apiKey: 'key', model: 'm1', request: async () => ({ statusCode: 200, body: JSON.stringify({ choices: [{ message: { content: 'hi' } }] }) }) })
    assert.equal(ok.ok, true)
    const okText = await fetchModelProbe({ apiKey: 'key', model: 'm1', request: async () => ({ statusCode: 200, body: JSON.stringify({ choices: [{ text: 'hi' }] }) }) })
    assert.equal(okText.ok, true)
  })

  await test('C3: probeIntervalMs=0 → ok 状态每次仍探测', async () => {
    const { runProbes } = require('./wawapi_model_monitor')
    let probes = 0
    const r = await runProbes({
      apiKeys: ['k'],
      probeModels: ['m1'],
      probeIntervalMs: 0,
      state: { probeStates: [{ model: 'm1', state: 'ok', lastProbedAt: '2026-08-25T00:00:00.000Z' }] },
      now: () => new Date('2026-08-25T00:01:00.000Z'),
      fetchProbe: async () => { probes++; return { ok: true, detail: '' } }
    })
    assert.equal(probes, 1)
  })

  await test('S3: 损坏时间戳 → 立即重新探测而非永不探测', async () => {
    const { runProbes } = require('./wawapi_model_monitor')
    let probes = 0
    const r = await runProbes({
      apiKeys: ['k'],
      probeModels: ['m1'],
      probeIntervalMs: 3600000,
      state: { probeStates: [{ model: 'm1', state: 'ok', lastProbedAt: 'invalid-date' }] },
      now: () => new Date('2026-08-25T00:01:00.000Z'),
      fetchProbe: async () => { probes++; return { ok: true, detail: '' } }
    })
    assert.equal(probes, 1)
  })

  await test('S6: 失败态固定 5 分钟重试（不跟随外层 intervalMs）', async () => {
    const { isProbeDue } = require('./wawapi_model_monitor')
    const nowMs = new Date('2026-08-25T00:06:00.000Z').getTime()
    // 失败态 4 分钟前探测过：未到 5 分钟 → 不探测
    assert.equal(isProbeDue({ state: 'failing', lastProbedAt: '2026-08-25T00:02:00.000Z' }, 3600000, nowMs), false)
    // 失败态 5 分钟后：探测
    assert.equal(isProbeDue({ state: 'failing', lastProbedAt: '2026-08-25T00:00:00.000Z' }, 3600000, nowMs), true)
    // 成功态：按 probeIntervalMs（1 小时）
    assert.equal(isProbeDue({ state: 'ok', lastProbedAt: '2026-08-25T00:00:00.000Z' }, 3600000, nowMs), false)
  })

  await test('S4: 通知失败时保留旧状态，下轮可重试', async () => {
    const fsx = require('fs')
    const osx = require('os')
    const pathx = require('path')
    const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'wawapi-s4-'))
    const stateFile = pathx.join(dir, 'state.json')
    const notices = []
    // 首次探测到 failing（unknown->failing），通知失败 → 状态应保持 unknown（不提交 failing）
    await runOnce({
      config: { apiKey: 'key', stateFile, probeModels: ['m1'], probeIntervalMs: 3600000, watchExact: [], watchPrefixes: [] },
      monitor: async () => ({ outcome: 'unchanged' }),
      notify: async () => { throw new Error('channel down') },
      runProbes: async () => ({
        notifications: [{ model: 'm1', previous: null, next: { state: 'failing' }, detail: 'HTTP 503' }],
        probeStates: [{ model: 'm1', state: 'failing', lastProbedAt: '2026-08-25T05:00:00.000Z' }]
      })
    })
    // 通知失败 + 无 previous → 不提交新状态（保持空），确保下轮仍会识别翻转
    const saved = JSON.parse(fsx.readFileSync(pathx.join(dir, 'wawapi_probe_state.json'), 'utf8'))
    assert.deepEqual(saved.probeStates, [])
    fsx.rmSync(dir, { recursive: true, force: true })
  })

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`)
  if (failed > 0) process.exitCode = 1
})()
