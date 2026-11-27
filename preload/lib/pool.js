'use strict'

/**
 * 带并发上限的批量执行器（滚动补槽）。
 *
 * 为什么不用「分块 + Promise.all」：分块会让块内最慢的一项拖住整块，块与块之间有
 * 木桶效应（binaries.scan 就是那种写法，只适合一次性扫描几十个候选）。
 * 滚动补槽是「谁先空出槽位谁领下一项」，几百个文件时总耗时接近 ceil(n / limit) * 单项耗时。
 *
 * 契约（调用方依赖，改动前先看这三个测试用例）：
 * - 返回值与入参**同序等长**；被取消而未派发的位置是 undefined，由调用方补占位。
 * - worker 抛错视为致命：立即停止派发，把第一个错误抛给调用方（逐项容错由 worker 自己 catch）。
 * - signal 只在每项开始前检查，不中断已在执行的那一项——要中断必须让 worker 自己响应 signal。
 */

/** 默认并发数：探测类任务是外部进程，3 路既能提速又不会把机械盘打满 */
const DEFAULT_LIMIT = 3
/** 并发上限：再高就该考虑分批，而不是继续加槽位 */
const MAX_LIMIT = 16

/**
 * 按并发上限处理一批项，结果与入参同序等长。
 * @template T, R
 * @param {T[]} items 待处理项
 * @param {(item: T, index: number) => Promise<R>} worker 单项处理函数；逐项容错请在内部 catch
 * @param {{limit?: number, signal?: {aborted: boolean}}} [opts] limit 并发上限（默认 3，夹在 1–16）；
 *        signal 形如 AbortSignal，只在每项开始前检查
 * @returns {Promise<Array<R|undefined>>} 与 items 同序等长的结果；未派发的位置为 undefined
 * @throws {Error} worker 抛出的第一个错误
 */
async function runPool(items, worker, opts = {}) {
  const list = Array.isArray(items) ? items : []
  const total = list.length
  if (!total) return []

  // limit 缺省（undefined/NaN）才用默认值；显式传 0 属于「夹到 1」，不能被 `||` 吞成默认值
  const raw = Number(opts.limit)
  const limit = Number.isFinite(raw) ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(raw))) : DEFAULT_LIMIT
  const signal = opts.signal || null
  const results = new Array(total)

  let next = 0
  let failure = null

  /**
   * 单个槽位的循环：领一项、跑一项、再领下一项，直到没活干、被取消或已出错。
   * @returns {Promise<void>} 槽位退出时 resolve
   */
  const runner = async () => {
    for (;;) {
      if (failure) return
      // 取消后不再派发新项；已跑完的结果保留在 results 里
      if (signal && signal.aborted) return
      const index = next
      next += 1
      if (index >= total) return
      try {
        results[index] = await worker(list[index], index)
      } catch (err) {
        // 只记第一个错误并停止派发，避免后续项在已知失败时继续跑
        if (!failure) failure = err
        return
      }
    }
  }

  const slots = Math.min(limit, total)
  await Promise.all(Array.from({ length: slots }, runner))
  if (failure) throw failure
  return results
}

module.exports = { runPool }
