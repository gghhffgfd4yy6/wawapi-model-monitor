'use strict'

const assert = require('assert/strict')
const {
  normalizeModelIds,
  diffModelIds,
  createEmptyState
} = require('./wawapi_model_monitor_core')

let passed = 0
let failed = 0

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

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`)
  if (failed > 0) process.exitCode = 1
})()
