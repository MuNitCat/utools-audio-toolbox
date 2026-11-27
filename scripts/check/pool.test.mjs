/**
 * runPool 的断言脚本：并发上限、顺序、取消、抛错停止派发。
 *
 * 纯函数，不依赖 window / uTools / 文件系统，直接 node scripts/check/pool.test.mjs 运行。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { runPool } = require('../../preload/lib/pool.js')

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => (cond ? (pass += 1) : fails.push(`${name}${detail ? ' → ' + detail : ''}`))

/**
 * 让出一个宏任务，给其它槽位真正并发的机会。
 * @param {number} [ms] 毫秒
 * @returns {Promise<void>} 计时结束 resolve
 */
const sleep = (ms = 1) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------ 1. 并发上限与顺序 ------------------------------ */

{
  const items = Array.from({ length: 20 }, (_, i) => i)
  let active = 0
  let peak = 0
  const results = await runPool(
    items,
    async (item) => {
      active += 1
      peak = Math.max(peak, active)
      await sleep(2)
      active -= 1
      return item * 2
    },
    { limit: 4 }
  )

  ok('并发峰值等于 limit', peak === 4, `peak=${peak}`)
  ok('结果同序等长', results.length === 20 && results.every((v, i) => v === i * 2), `got=${results.slice(0, 5).join(',')}`)
}

/* ------------------------------ 2. 边界入参 ------------------------------ */

{
  const empty = await runPool([], async () => 1)
  ok('空数组返回空数组', Array.isArray(empty) && empty.length === 0)
}

{
  // limit 传 0 / undefined 时应回落到默认 3，而不是退化成串行或死循环
  const seen = []
  await runPool([1, 2, 3, 4, 5], async (v) => {
    seen.push(v)
  })
  ok('缺省 limit 仍能跑完全部项', seen.length === 5, `got=${seen.length}`)

  let peak = 0
  let active = 0
  await runPool(
    [1, 2, 3, 4, 5],
    async () => {
      active += 1
      peak = Math.max(peak, active)
      await sleep(2)
      active -= 1
    },
    { limit: 0 }
  )
  ok('limit=0 夹到 1', peak === 1, `peak=${peak}`)

  let peak2 = 0
  let active2 = 0
  await runPool(
    Array.from({ length: 40 }, (_, i) => i),
    async () => {
      active2 += 1
      peak2 = Math.max(peak2, active2)
      await sleep(1)
      active2 -= 1
    },
    { limit: 999 }
  )
  ok('limit 超上限夹到 16', peak2 === 16, `peak=${peak2}`)
}

/* ------------------------------ 3. 取消 ------------------------------ */

{
  const signal = { aborted: true }
  let calls = 0
  const out = await runPool([1, 2, 3], async () => {
    calls += 1
    return 1
  }, { signal })
  ok('开始前已取消：worker 一次不跑', calls === 0, `calls=${calls}`)
  ok('开始前已取消：结果全为 undefined', out.length === 3 && out.every((v) => v === undefined))
}

{
  // 跑完 2 项后取消：已完成的结果保留，后续位置留 undefined
  const signal = { aborted: false }
  let calls = 0
  const out = await runPool(
    Array.from({ length: 30 }, (_, i) => i),
    async (item) => {
      calls += 1
      if (item === 1) signal.aborted = true
      await sleep(2)
      return item
    },
    { limit: 2, signal }
  )
  ok('中途取消：已完成的保留', out[0] === 0 && out[1] === 1, `got=${out[0]},${out[1]}`)
  ok('中途取消：未派发位置为 undefined', out[29] === undefined && out[15] === undefined)
  ok('中途取消：没有跑满', calls < 30, `calls=${calls}`)
}

/* ------------------------------ 4. worker 抛错 ------------------------------ */

{
  const callOrder = []
  let caught = null
  try {
    await runPool(
      Array.from({ length: 30 }, (_, i) => i),
      async (item) => {
        callOrder.push(item)
        await sleep(1)
        if (item === 5) throw new Error('boom')
        return item
      },
      { limit: 3 }
    )
  } catch (err) {
    caught = err
  }

  ok('worker 抛错会 reject', caught instanceof Error && caught.message === 'boom', `got=${caught && caught.message}`)
  ok('抛错后不再派发后续项', callOrder.length < 30 && !callOrder.includes(29), `calls=${callOrder.length}`)
  ok('抛错不影响已派发项不重复', new Set(callOrder).size === callOrder.length)
}

console.log(`\n通过 ${pass} 项`)
if (fails.length) {
  console.log(`失败 ${fails.length} 项：`)
  for (const f of fails) console.log('  ✗', f)
  process.exit(1)
}
console.log('✓ runPool 行为符合预期')
