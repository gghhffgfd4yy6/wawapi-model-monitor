# WawAPI Model Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增一个独立的 WawAPI 模型目录监测脚本，比较相邻的有效模型快照，提醒模型上新、下架、空列表和 API 异常，并同时支持青龙单次执行与服务器常驻运行。

**Architecture:** `wawapi_model_monitor_core.js` 负责纯解析、差异计算、状态机和通知文本；`wawapi_model_monitor.js` 负责配置加载、WawAPI HTTP 请求、状态文件、单实例锁、CLI 和常驻调度。核心通过依赖注入接受 HTTP、状态和通知适配器，因此测试不需要真实 API Key 或真实推送。

**Tech Stack:** Node.js `>=20`、现有 `got@11.8.6`、现有 `xbk_sendNotify_slim.js`、现有 `xbk_storage.js`、现有 `xbk_loop.js`、项目自有异步测试 harness；不新增 npm 依赖。

## Global Constraints

- WawAPI endpoint 固定为 `https://wawapii.com/v1/models`，请求使用 `Authorization: Bearer <key>`；不允许通过配置重定向到其他 endpoint。
- `WAWAPI_API_KEY` 环境变量优先于 `wawapi_model_monitor.local.js`；真实密钥不得进入 Git、日志、通知、命令行参数或测试 fixture 之外的源码。
- 状态只保留一个最新的非空快照；空列表和 API 异常不覆盖该快照。
- 监测脚本独立于 `xbk_function_v3.js`，通知复用 `xbk_sendNotify_slim.js`。
- 连续相同异常只通知一次；异常类型变化立即通知；恢复后通知一次恢复事件。
- 正常模型变更通知至少一个通知渠道成功后才提交新快照；全部通知渠道失败时保留旧快照并在下一轮重试。
- 单次模式与常驻模式必须调用同一个 `monitorOnce` 核心函数。
- 使用现有自定义测试风格；全量集成测试必须经过 `test_app_p.js` 并行调度器，不能把 `node test_app.js` 作为默认全量入口。
- 文档不添加当前版本、测试总数、性能耗时等易过时数字；必要的 endpoint、协议状态码和用户要求的轮询配置可以保留。
- 每个任务完成后运行其针对性测试并创建原子 Git commit；不执行远程 push。

## File Map

- Create: `wawapi_model_monitor_core.js` — 纯模型目录解析、快照差异、异常状态机、通知文本和一次监测编排。
- Create: `wawapi_model_monitor.js` — CLI 入口、配置优先级、WawAPI HTTP 适配、状态文件适配、锁和 `--daemon` 调度。
- Create: `test_wawapi_model_monitor.js` — 模型监测核心、配置、HTTP、状态、锁和 CLI 的 mock 回归测试。
- Create: `wawapi_model_monitor.local.js.example` — 本地 WawAPI Key、关注列表和可选运行配置示例，不含真实密钥。
- Modify: `.gitignore` — 忽略本地 WawAPI 配置、默认状态文件和锁文件。
- Modify: `package.json` — 增加模型监测针对性测试命令。
- Modify: `run_tests.js` — 将模型监测测试接入统一测试入口。
- Modify: `README.md` — 增加独立监测脚本的配置与运行说明，不重复维护易过时的测试数或版本号。
- Modify: `FILE_INDEX.md` — 登记新脚本、核心模块、示例配置和测试入口。

---

### Task 1: 建立纯核心函数和模型差异契约

**Files:**
- Create: `wawapi_model_monitor_core.js`
- Create: `test_wawapi_model_monitor.js`

**Interfaces:**
- Produces `normalizeModelIds(payload) -> string[]`：严格读取 `payload.data[].id`，去掉重复 ID，按确定性顺序返回；缺少合法 `data` 数组或元素 ID 不是非空字符串时抛出带 `code = 'INVALID_MODEL_RESPONSE'` 的错误。
- Produces `diffModelIds(previousModels, currentModels) -> { added: string[], removed: string[] }`：两个数组按集合差异计算，结果确定性排序。
- Produces `resolveMonitorConfig({ env, localConfig, rootDir }) -> config`：环境变量优先、本地配置备用，并返回固定 endpoint、API Key、轮询间隔、状态路径和关注列表。
- Produces `createEmptyState() -> state`：返回 `lastNonEmptyModels: null` 的初始状态。

- [ ] **Step 1: 写失败测试，锁定模型列表解析和集合差异**

在 `test_wawapi_model_monitor.js` 中先加入项目现有风格的最小 harness 和以下测试：

```js
const assert = require('assert/strict')
const {
  normalizeModelIds,
  diffModelIds,
  createEmptyState
} = require('./wawapi_model_monitor_core')

async function test (name, fn) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    console.error(`  ❌ ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

;(async () => {
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
})()
```

- [ ] **Step 2: 运行测试，确认当前实现确实失败**

Run: `node test_wawapi_model_monitor.js`

Expected: FAIL，原因是 `wawapi_model_monitor_core.js` 尚不存在或尚未导出所需函数。

- [ ] **Step 3: 实现最小纯函数**

在 `wawapi_model_monitor_core.js` 中实现：

```js
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
```

- [ ] **Step 4: 运行针对性测试，确认解析契约通过**

Run: `node test_wawapi_model_monitor.js`

Expected: 当前新增测试全部通过，尚未声称完整功能完成。

- [ ] **Step 5: 提交纯核心契约**

```bash
git add wawapi_model_monitor_core.js test_wawapi_model_monitor.js
git commit -m "feat: add WawAPI model diff core"
```

---

### Task 2: 实现配置解析、异常分类和快照状态机

**Files:**
- Modify: `wawapi_model_monitor_core.js`
- Modify: `test_wawapi_model_monitor.js`

**Interfaces:**
- Produces `resolveMonitorConfig({ env = process.env, localConfig = {}, rootDir = __dirname }) -> { apiKey, endpoint, intervalMs, stateFile, watchExact, watchPrefixes }`。
- Produces `incidentKey(observation) -> string`：空列表固定为 `empty_models`；API 异常使用稳定的错误类别和 HTTP 状态或错误代码，不把完整错误消息作为去重键。
- Produces `monitorOnce({ readState, writeState, fetchModels, notify, now, reportCurrent, watch }) -> result`。
- `fetchModels()` 返回 `{ statusCode, body }`；传输失败可以抛出带 `code` 的错误。
- `notify(title, body)` 返回成功 Promise；所有渠道失败时 reject。
- `readState()` 返回合法状态或 `null`；`writeState(state)` 返回成功 Promise 或抛出错误。
- `monitorOnce` 返回 `{ outcome, added, removed, notified, stateCommitted }`，其中 `outcome` 至少覆盖 `baseline`、`changed`、`unchanged`、`empty_models`、`api_error`、`recovered` 和 `notification_failed`。

- [ ] **Step 1: 写失败测试，覆盖配置优先级和相邻快照状态机**

将下面的测试辅助函数加入同一测试文件：

```js
const { monitorOnce, resolveMonitorConfig, incidentKey } = require('./wawapi_model_monitor_core')

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
```

测试以下行为：

```js
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
  const state = {
    schemaVersion: 1,
    lastNonEmptyModels: ['model-a'],
    lastObservationAt: '2026-08-24T23:55:00.000Z',
    lastStatus: 'healthy',
    activeIncident: null
  }
  const store = makeStateStore(state)
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
  await monitorOnce({
    readState: store.read,
    writeState: store.write,
    fetchModels: async () => jsonResponse([]),
    notify: async (title, body) => notices.push({ title, body }),
    now: () => new Date('2026-08-25T00:00:00.000Z')
  })
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
```

同时锁定 `incidentKey({ status: 'api_error', code: 'HTTP_401' }) === 'api_error:HTTP_401'`，并确认错误消息变化不会导致同一持续事件重复提醒。

- [ ] **Step 2: 运行测试，确认状态机测试先失败**

Run: `node test_wawapi_model_monitor.js`

Expected: 新增配置、状态机和异常测试 FAIL，而 Task 1 的纯函数测试仍 PASS。

- [ ] **Step 3: 实现配置解析和关注列表标记**

在核心模块增加：

```js
function splitList (value) {
  if (typeof value !== 'string') return []
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function resolveMonitorConfig ({ env = process.env, localConfig = {}, rootDir = __dirname } = {}) {
  const apiKey = typeof env.WAWAPI_API_KEY === 'string' && env.WAWAPI_API_KEY.trim() !== ''
    ? env.WAWAPI_API_KEY.trim()
    : typeof localConfig.apiKey === 'string' ? localConfig.apiKey.trim() : ''
  const intervalValue = env.WAWAPI_MODEL_INTERVAL_MS || localConfig.intervalMs
  const intervalMs = Number.isFinite(Number(intervalValue)) && Number(intervalValue) >= 0
    ? Number(intervalValue)
    : 300000
  const stateFile = env.WAWAPI_MODEL_STATE_FILE || localConfig.stateFile ||
    require('path').join(rootDir, 'xianbaoku_cache', 'wawapi_model_monitor_state.json')
  return {
    endpoint: 'https://wawapii.com/v1/models',
    apiKey,
    intervalMs,
    stateFile,
    watchExact: splitList(env.WAWAPI_MODEL_WATCH_EXACT || localConfig.watchExact || ''),
    watchPrefixes: splitList(env.WAWAPI_MODEL_WATCH_PREFIX || localConfig.watchPrefixes || '')
  }
}

function isWatched (modelId, watch) {
  return watch.watchExact.includes(modelId) || watch.watchPrefixes.some(prefix => modelId.startsWith(prefix))
}
```

环境变量优先级测试使用 `env.WAWAPI_API_KEY = 'env-key'`、本地 `apiKey = 'local-key'`，断言最终使用 `env-key`；同时断言 endpoint 固定为 WawAPI 地址。

- [ ] **Step 4: 实现状态机的提交顺序**

`monitorOnce` 按以下顺序实现：

1. 读取合法状态；缺失状态使用 `createEmptyState()`，损坏状态抛出 `STATE_INVALID`，不自动覆盖。
2. 调用 `fetchModels()`；HTTP 非 200、传输异常和解析异常统一分类为 `api_error`。
3. 合法 `data: []` 分类为 `empty_models`，只更新状态和异常事件，不改 `lastNonEmptyModels`。
4. 首次合法非空列表写入基线，不发变更通知。
5. 有基线时计算 `added` 和 `removed`；异常恢复时把恢复标题、变更项和可选当前列表合并到一条通知。
6. 同一个 `activeIncident.key` 已经成功提醒时不再调用 `notify`，只更新观测时间。
7. 新异常或恢复通知成功后才写入新的 `activeIncident` / `lastStatus`。
8. 正常变更通知成功后才覆盖 `lastNonEmptyModels`；所有通知失败时返回 `notification_failed` 并保持旧状态。
9. `reportCurrent` 在通知正文中附加当前完整模型 ID 列表；没有基线时发送后建立基线，有基线时仍按相邻快照规则处理。

- [ ] **Step 5: 实现安全通知文本**

新增纯格式函数，固定使用以下标题：

```js
const TITLES = Object.freeze({
  CHANGE: '【WawAPI模型变更】',
  EMPTY: '【WawAPI模型列表为空】',
  ERROR: '【WawAPI API异常】',
  RECOVERY: '【WawAPI监测恢复】',
  REPORT: '【WawAPI当前模型列表】'
})
```

正文只输出 endpoint、状态分类、HTTP 状态或安全错误代码、模型 ID 和数量；禁止把响应原文、请求 headers 或 API Key 拼入正文。关注列表中的 ID 用 `⭐` 标记，但不改变全量变更集合。

- [ ] **Step 6: 运行状态机测试并提交**

Run: `node test_wawapi_model_monitor.js`

Expected: Task 1 和 Task 2 的测试全部通过；此时 HTTP 适配和 CLI 尚未接入真实 `got`。

```bash
git add wawapi_model_monitor_core.js test_wawapi_model_monitor.js
git commit -m "feat: add WawAPI monitor state machine"
```

---

### Task 3: 实现 WawAPI HTTP、状态文件和单实例锁适配

**Files:**
- Create: `wawapi_model_monitor.js`
- Modify: `test_wawapi_model_monitor.js`
- Modify: `.gitignore`
- Create: `wawapi_model_monitor.local.js.example`

**Interfaces:**
- Produces `fetchModels({ apiKey, request = got }) -> Promise<{ statusCode, body }>`。
- Produces `loadLocalConfig(modulePath) -> object`：本地文件不存在返回空对象，存在但语法错误时抛出配置错误。
- Produces `createStateStore(statePath) -> { read, write }`：使用 `readSafeTextResult`、JSON 校验和 `writeAtomic`，状态文件权限沿用现有安全文件工具。
- Produces `withInstanceLock(lockPath, task) -> Promise<task result>`：独占创建锁，任务结束释放锁；活跃锁不删除，已退出进程的残留锁可恢复。
- Produces `parseArgs(argv) -> { mode, reportCurrent }`，只接受 `--once`、`--daemon` 和 `--report-current`。

- [ ] **Step 1: 写失败测试，锁定 HTTP 鉴权和响应分类输入**

在测试文件中注入假的 `request` 函数，断言请求参数：

```js
const { fetchModels, parseArgs } = require('./wawapi_model_monitor')

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
```

- [ ] **Step 2: 运行测试，确认适配层测试失败**

Run: `node test_wawapi_model_monitor.js`

Expected: 新增 HTTP、CLI、状态文件和锁测试 FAIL，核心状态机测试保持通过。

- [ ] **Step 3: 实现 HTTP 适配器**

在 CLI 模块中使用现有 `got`：

```js
const got = require('got')

async function fetchModels ({ apiKey, request = got }) {
  return request('https://wawapii.com/v1/models', {
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
```

不打印 request options；网络异常原样交给核心状态机分类，但日志只使用错误代码和安全摘要。

- [ ] **Step 4: 实现本地配置和状态文件适配**

本地配置加载只接受同目录下的固定文件名：

```js
function loadLocalConfig (modulePath) {
  try {
    return require(modulePath)
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND' && error.message.includes(modulePath)) return {}
    throw error
  }
}
```

状态适配器：

- 缺失文件返回 `null`。
- 文件不是普通文件、读取失败或 JSON 结构损坏时抛出 `STATE_INVALID`。
- 写入调用现有 `writeAtomic(statePath, JSON.stringify(state, null, 2), 'WawAPI模型监测状态')`。
- 不在状态文件中写入 API Key 或通知凭据。

测试创建临时目录，覆盖缺失状态、合法状态、损坏 JSON、原子更新后再次读取和拒绝符号链接路径。

- [ ] **Step 5: 实现单实例锁**

锁文件使用状态路径加 `.lock` 后缀。创建时使用 `fs.openSync(lockPath, 'wx', 0o600)`，写入 `{ pid, startedAt }`。释放时关闭 fd 并删除本次创建的锁。

遇到 `EEXIST` 时：

1. 读取锁内 PID。
2. 用 `process.kill(pid, 0)` 判断持有者是否仍在运行。
3. 持有者存活或锁内容无法安全判断时抛出 `LOCK_HELD`，绝不删除。
4. 确认 PID 已退出后删除残留锁并只重试一次。

测试覆盖活跃锁阻止第二实例、退出 PID 的残留锁可恢复、锁任务异常仍释放、锁内容损坏时不误删。

- [ ] **Step 6: 添加密钥示例和忽略规则**

创建 `wawapi_model_monitor.local.js.example`：

```js
module.exports = {
  apiKey: '在本机填写 WawAPI API Key',
  watchExact: [],
  watchPrefixes: [],
  intervalMs: 300000
}
```

`.gitignore` 增加：

```text
wawapi_model_monitor.local.js
xianbaoku_cache/wawapi_model_monitor_state.json
xianbaoku_cache/wawapi_model_monitor_state.json.lock
```

测试确认示例文件没有真实密钥，真实本地文件和状态文件不会出现在 `git status`。

- [ ] **Step 7: 运行适配层测试并提交**

Run: `node test_wawapi_model_monitor.js`

Expected: HTTP、配置、状态文件和锁测试全部通过；测试只访问本地 mock 或注入的 request，不访问 WawAPI。

```bash
git add wawapi_model_monitor.js wawapi_model_monitor.local.js.example test_wawapi_model_monitor.js .gitignore
git commit -m "feat: add WawAPI monitor adapters"
```

---

### Task 4: 接入 CLI 单次模式、常驻模式和信号停止

**Files:**
- Modify: `wawapi_model_monitor.js`
- Modify: `test_wawapi_model_monitor.js`

**Interfaces:**
- Produces `runOnce(options) -> Promise<monitor result>`：加载状态、调用核心 `monitorOnce`、使用现有 `sendNotify` 适配器。
- Produces `runDaemon(options) -> Promise<void>`：通过现有 `runLoop` 重复调用同一个 `runOnce`，接收 `AbortSignal`。
- Produces `main(argv, dependencies) -> Promise<number>`：解析模式、校验 API Key、获取锁、运行并返回安全退出码。

- [ ] **Step 1: 写失败测试，验证单次和常驻复用同一核心函数**

在测试中注入 `monitorOnce`、`runLoop`、锁和通知依赖：

```js
await test('单次模式只调用一次核心监测', async () => {
  let calls = 0
  const code = await main(['--once'], {
    config: { apiKey: 'sk-test-key', stateFile: '/tmp/wawapi-state.json' },
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
```

- [ ] **Step 2: 运行测试，确认 CLI 测试失败**

Run: `node test_wawapi_model_monitor.js`

Expected: `main` 和 `runDaemon` 尚未实现的测试 FAIL，其余测试保持通过。

- [ ] **Step 3: 实现通知和状态依赖装配**

在 `runOnce` 中装配：

```js
const notifyModule = require('./xbk_sendNotify_slim')
const storage = require('./xbk_storage')

const notify = (title, body) => notifyModule.sendNotify(title, body)
```

状态读写、HTTP 请求、配置解析都通过参数传入核心，不在核心模块中直接 `require` 真实网络或通知实现。

- [ ] **Step 4: 实现单次模式**

`main(['--once'])` 执行顺序固定为：

1. 解析参数。
2. 加载环境变量和本地配置。
3. 缺少 API Key 时输出不含密钥的配置错误并返回非零退出码。
4. 获取实例锁。
5. 调用 `runOnce` 一次。
6. 释放锁。
7. 对已成功记录的远程 API 异常返回正常完成；配置、锁、状态写入或全部通知失败返回非零。

单次模式不会调用 `setInterval`，适合青龙和 cron。

- [ ] **Step 5: 实现常驻模式和优雅停止**

常驻模式使用现有 `xbk_loop.runLoop`：

```js
async function runDaemon ({ runOnce, intervalMs, signal, loop = runLoop, onError }) {
  await loop(runOnce, {
    intervalMs,
    signal,
    onError
  })
}
```

CLI 创建 `AbortController`，为 `SIGTERM` 和 `SIGINT` 注册一次性处理器；收到信号后只停止下一轮调度，不强杀正在执行的 HTTP 请求或通知。

- [ ] **Step 6: 运行模式测试并提交**

Run: `node test_wawapi_model_monitor.js`

Expected: 单次调用次数、常驻信号停止、锁释放和安全退出码测试全部通过。

```bash
git add wawapi_model_monitor.js test_wawapi_model_monitor.js
git commit -m "feat: add WawAPI monitor runtime modes"
```

---

### Task 5: 接入项目测试、文档和关注列表验收

**Files:**
- Modify: `package.json`
- Modify: `run_tests.js`
- Modify: `README.md`
- Modify: `FILE_INDEX.md`
- Modify: `test_wawapi_model_monitor.js`

**Interfaces:**
- Produces npm script `test:model-monitor`，执行 `node test_wawapi_model_monitor.js`。
- Produces统一测试入口中的“WawAPI模型监测”套件。
- Produces用户可核对的配置、单次运行、常驻运行和报告当前列表说明。

- [ ] **Step 1: 写失败测试，锁定关注列表和主动报告**

加入以下测试：

```js
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
  await monitorOnce({
    readState: store.read,
    writeState: store.write,
    fetchModels: async () => jsonResponse(['model-a']),
    notify: async (title, body) => notices.push({ title, body }),
    reportCurrent: true,
    now: () => new Date('2026-08-25T00:05:00.000Z')
  })
  assert.equal(notices.length, 1)
  assert.match(notices[0].body, /model-a/)
})
```

- [ ] **Step 2: 运行测试，确认关注列表和报告测试先失败**

Run: `node test_wawapi_model_monitor.js`

Expected: 关注标记和 `--report-current` 相关断言 FAIL。

- [ ] **Step 3: 实现关注列表和主动报告**

关注列表从 `watchExact` 与 `watchPrefixes` 读取；所有上新/下架仍然进入通知，关注项只在正文中增加 `⭐` 标记。

`--report-current` 在没有变更时使用报告标题；有变更或恢复事件时把完整当前列表附加到同一条通知中，不额外发送第二条重复通知。

- [ ] **Step 4: 接入项目测试入口**

在 `package.json` 增加：

```json
"test:model-monitor": "node test_wawapi_model_monitor.js"
```

在 `run_tests.js` 的 `SUITES` 中增加：

```js
{ name: 'WawAPI模型监测', file: 'test_wawapi_model_monitor.js', desc: '模型上新下架、空列表、API异常和运行模式' }
```

保持现有集成测试条目继续使用 `test_app_p.js`。

- [ ] **Step 5: 更新使用文档和索引**

`README.md` 新增独立小节，包含：

- WawAPI Base URL 和 `/v1/models` 用途。
- `WAWAPI_API_KEY` 环境变量优先级。
- 本地配置文件复制方式和“不提交真实密钥”说明。
- `node wawapi_model_monitor.js --once`、`--daemon`、`--report-current` 三种入口。
- 青龙/cron 使用单次入口，systemd/pm2/Docker 使用常驻入口。
- 空列表和 API 异常的提醒语义。

不在 README 中维护版本号、测试总数、运行耗时或易过时的模型清单。

`FILE_INDEX.md` 登记新脚本、核心模块、测试文件、示例配置和 npm 测试入口，并说明状态文件只保留一份最新快照。

- [ ] **Step 6: 运行针对性测试并提交项目接入**

Run: `npm run test:model-monitor`

Expected: 模型监测测试全部通过。

```bash
git add package.json run_tests.js README.md FILE_INDEX.md test_wawapi_model_monitor.js
git commit -m "test: integrate WawAPI monitor regression suite"
```

---

### Task 6: 故障注入、全量验证和交付检查

**Files:**
- Modify: `test_wawapi_model_monitor.js` only if a missing regression is found during injection.
- Review: `wawapi_model_monitor_core.js`
- Review: `wawapi_model_monitor.js`
- Review: `.gitignore`, `package.json`, `run_tests.js`, `README.md`, `FILE_INDEX.md`

- [ ] **Step 1: 执行故障注入矩阵**

依次用 mock 注入以下响应：

```text
HTTP 200 + data: []
HTTP 401 + API_KEY_REQUIRED
HTTP 403
HTTP 404
HTTP 429
HTTP 500
请求超时
连接失败
无效 JSON
合法响应但 data 元素缺少 id
所有通知渠道失败
单个通知渠道失败、其他渠道成功
状态文件 JSON 损坏
状态文件替换为符号链接
活跃锁文件
已退出进程的残留锁
```

每个场景都核对：通知标题、状态是否提交、旧快照是否保留、连续事件是否去重、恢复是否只通知一次以及日志是否没有密钥。

- [ ] **Step 2: 运行静态检查和针对性套件**

Run:

```bash
npm run lint
npm run test:model-monitor
npm run test:filter
npm run test:notify
```

Expected: lint、模型监测、单元和通知测试全部通过。

- [ ] **Step 3: 运行完整测试**

Run:

```bash
npm test
```

Expected: 统一入口完成全部套件；集成部分由 `test_app_p.js` 并行调度，失败片按项目既有机制串行重跑。

- [ ] **Step 4: 检查工作区和最终 diff**

Run:

```bash
git diff --check
git status --short --branch
git diff 0c8378b..HEAD --stat
```

核对：

- 真实密钥和运行状态没有出现在 Git 状态中。
- 没有修改 V3 主业务逻辑。
- 新脚本、核心、测试、示例配置和文档修改范围与本计划一致。
- 没有删除 `.git` 内部文件或其他用户文件。

- [ ] **Step 5: 创建最终原子提交**

```bash
git add wawapi_model_monitor_core.js wawapi_model_monitor.js test_wawapi_model_monitor.js \
  wawapi_model_monitor.local.js.example .gitignore package.json run_tests.js README.md FILE_INDEX.md
git commit -m "feat: add WawAPI model availability monitor"
```

- [ ] **Step 6: 交付前只报告有证据的结果**

记录并报告：

- 最终 commit。
- `npm test`、lint 和模型监测针对性测试的实际输出结论。
- 变更文件范围。
- 状态文件位置和密钥配置方式。
- 青龙单次模式与服务器常驻模式命令。
- 是否 push；本计划不自动 push。
