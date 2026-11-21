/**
 * 任务队列引擎：默认 2 个任务并行（可在「应用设置」里调 1–4，单个任务内部仍是 op 串行）。
 * 状态机：pending → running → done | failed | canceled | skipped
 */

import { getFeature } from './features.js'
import * as A from './args.js'
import { parseSilence, parseLoudnorm, planSegments, errorTail, clockTag } from './format.js'
import { getState, setState, toast } from './store.js'

const svc = () => window.audioServices

let counter = 0
let running = false
const waiters = new Map()

/**
 * 生成任务 id：时间戳 + 自增序号，同一毫秒内也不会撞。
 * @returns {string} 形如 t1a2b3c-7
 */
function nextId() {
  counter += 1
  return `t${Date.now().toString(36)}-${counter}`
}

/**
 * 局部更新单个任务字段（进度回调 10Hz 走这里，避免整表重建）。
 * @param {string} id 任务 id
 * @param {object} patch 要覆盖的字段
 * @returns {void} 无返回值
 */
function patchTask(id, patch) {
  setState({
    tasks: getState().tasks.map((t) => (t.id === id ? { ...t, ...patch } : t))
  })
}

/**
 * 唤醒等待该任务结束的 waitFor（MCP 路径靠它拿到结果）。
 * @param {string} id 任务 id
 * @param {object} result 最终任务快照
 * @returns {void} 无返回值
 */
function settle(id, result) {
  const fn = waiters.get(id)
  if (fn) {
    waiters.delete(id)
    fn(result)
  }
}

/**
 * 为任务登记一个待兑现的 Promise。
 * @param {string} id 任务 id
 * @returns {Promise<object>} 任务结束时 resolve 成最终快照
 */
function deferred(id) {
  return new Promise((resolve) => waiters.set(id, resolve))
}

/* ------------------------------ 建任务 ------------------------------ */

/**
 * 把「功能 + 参数 + 文件」翻译成任务列表（只建不跑）。
 * 真正干活的是 features.build()，这里只补运行期字段（id、权重、快照）。
 * @param {{featureId: string, params: object, files: object[]}} options 入队参数
 * @returns {object[]} 任务快照数组
 * @throws {Error} preload 未就绪、功能不存在或没有可处理文件时抛出
 */
export function buildTasks({ featureId, params, files }) {
  const api = svc()
  if (!api) throw new Error('audioServices 未就绪')

  const feature = getFeature(featureId)
  if (!feature) throw new Error(`未知功能：${featureId}`)

  const usable = (files || []).filter((f) => f && f.info && f.info.ok)
  if (!usable.length) throw new Error('没有可处理的音频文件')

  const inputs = usable.map((f) => f.path)
  const infos = usable.map((f) => f.info)
  const blocks = feature.build(inputs, params, infos) || []

  return blocks.map((block) => {
    const ops = (block.ops || []).map((op) => ({ ...op, args: op.args ? [...op.args] : op.args }))
    return {
      id: nextId(),
      input: block.input || inputs[0],
      info: infos[inputs.indexOf(block.input)] || infos[0] || {},
      inputCount: inputs.length,
      featureId,
      featureName: feature.name,
      ops,
      originOps: ops.map((op) => ({ ...op, args: op.args ? [...op.args] : op.args })),
      status: block.skip ? 'skipped' : 'pending',
      progress: 0,
      message: block.skip || '',
      output: block.outputs && block.outputs[0] ? block.outputs[0] : ops.reduce((acc, op) => acc || op.output || '', ''),
      outputs: block.outputs || [],
      error: '',
      canceled: false,
      speed: 0,
      eta: 0,
      startedAt: 0,
      plan: params
    }
  })
}

/**
 * 入队并开始执行（最多 2 个任务并行）。
 * @param {{featureId: string, params: object, files: object[]}} options 入队参数
 * @returns {object[]} 刚创建的任务快照
 * @throws {Error} 建任务失败时抛出（例如没有可处理的文件）
 */
export function enqueue(options) {
  const tasks = buildTasks(options)
  setState({ tasks: [...getState().tasks, ...tasks] })
  for (const task of tasks) {
    if (task.status === 'pending') task.waitPromise = deferred(task.id)
  }
  run()
  return tasks
}

/**
 * 等待这些任务全部结束（MCP 用；GUI 路径不需要）。
 * @param {object[]} tasks enqueue 返回的任务
 * @returns {Promise<object[]>} 全部结束后 resolve 成任务数组
 */
export function waitFor(tasks) {
  const pending = tasks.filter((t) => t.waitPromise).map((t) => t.waitPromise)
  if (!pending.length) return Promise.resolve(tasks)
  return Promise.all(pending).then(() => tasks)
}

/* ------------------------------ 执行 ------------------------------ */

/** 同时运行的任务数：默认 2，由「应用设置 → 任务并行数」通过 setConcurrency 调整 */
let concurrency = 2

/**
 * 设置并行上限。调大时如果还有排队任务，立刻唤醒调度补槽。
 * @param {number} value 期望并行数，夹在 1–4 之间
 * @returns {number} 实际生效的并行数
 */
export function setConcurrency(value) {
  const n = Math.min(4, Math.max(1, Math.round(Number(value) || 1)))
  concurrency = n
  if (getState().tasks.some((t) => t.status === 'pending')) run()
  return n
}

/** taskId -> 取消信号。取消时立刻 reject，不等进程真的被杀掉 */
const aborters = new Map()

/** 正在跑的任务 Promise 集合，run() 靠它判断还有没有空槽 */
const inflight = new Set()

/**
 * 建一个取消信号：cancel() 调用 fire() 后，所有 race 到它的 await 立即以
 * 「已取消」失败，不再依赖杀进程是否成功（宿主的 runFFmpeg 未必支持 kill）。
 * @param {string} taskId 任务 id
 * @returns {{signal: Promise<never>, fire: () => void}} signal 只 reject 不 resolve
 */
function createAborter(taskId) {
  let fire = () => {}
  const signal = new Promise((_, reject) => {
    fire = () => reject(Object.assign(new Error('已取消'), { canceled: true }))
  })
  // 没人 race 它的时候别变成 unhandledrejection
  signal.catch(() => {})
  const entry = { signal, fire }
  aborters.set(taskId, entry)
  return entry
}

/**
 * 起一个任务并登记到 inflight。
 * @param {object} task 任务快照
 * @returns {Promise<void>} 任务结束（成功/失败/取消）后 resolve
 */
function startTask(task) {
  const p = runTask(task).catch(() => {})
  inflight.add(p)
  p.then(() => inflight.delete(p))
  return p
}

/**
 * 队列主循环：最多 concurrency 个任务并行，槽位空出来就补下一个。
 * 注意只有「填槽」和「等最早结束的那个」两件事，具体执行都在 runTask 里。
 * @returns {Promise<void>} 队列清空后 resolve
 */
async function run() {
  if (running) return
  running = true
  setState({ running: true })
  try {
    for (;;) {
      while (inflight.size < concurrency) {
        const next = getState().tasks.find((t) => t.status === 'pending')
        if (!next) break
        // startTask 内部会同步把状态置成 running，所以下一轮不会重复取到它
        startTask(next)
      }
      if (!inflight.size) break
      await Promise.race([...inflight])
    }
  } finally {
    running = false
    setState({ running: false })
    summarize()
  }
}

/**
 * 队列跑空后给一次汇总提示；多文件时再发一条系统通知（窗口可能已被关掉）。
 * @returns {void} 无返回值
 */
function summarize() {
  const tasks = getState().tasks
  const done = tasks.filter((t) => t.status === 'done').length
  const failed = tasks.filter((t) => t.status === 'failed').length
  const canceled = tasks.filter((t) => t.status === 'canceled').length
  if (!done && !failed && !canceled) return
  const parts = []
  if (done) parts.push(`完成 ${done}`)
  if (failed) parts.push(`失败 ${failed}`)
  if (canceled) parts.push(`取消 ${canceled}`)
  toast(parts.join(' · '), failed ? 'error' : 'success')
  const api = svc()
  if (api && tasks.length > 1) {
    try {
      api.notify(`音频批量处理：${parts.join(' · ')}`)
    } catch (_) {}
  }
}

/**
 * 静音探测完成后，按探测到的切点动态展开成多个导出 op。
 * 之所以放在运行期：切点数量只有跑完第一遍才知道，build 阶段无法预知。
 * @param {object} task 当前任务（读 task.info.duration 与 task.plan）
 * @param {string} text silencedetect 的 stderr
 * @returns {object[]} 每个片段一个 ffmpeg op
 * @throws {Error} 没检测到静音、时长未知或切不出足够长的片段时抛出
 */
function buildSplitOps(task, text) {
  const api = svc()
  const p = task.plan || {}
  const duration = Number(task.info && task.info.duration) || 0
  const silences = parseSilence(text)
  if (!silences.length) {
    throw new Error('没检测到静音段：把「静音阈值」调高（如 -30dB）或缩短「最短静音」')
  }
  if (duration <= 0) throw new Error('时长未知，无法切分（可改用「按时长均分」）')

  const segs = planSegments(duration, silences, {
    minSegment: Number(p.minSegment) || 3,
    pad: Number(p.pad) || 0.15
  })
  if (!segs.length) throw new Error('切分后没有足够长的片段，试试调小「最短片段」或放宽阈值')

  const format = p.format || 'flac'
  return segs.map((seg, idx) => {
    const output = api.numberedOutput(task.input, idx + 1, {
      dir: p.outputDir || '',
      ext: A.outputExtOf(format),
      timeRange: `${clockTag(seg.start)}_${clockTag(seg.end)}`
    })
    return {
      type: 'ffmpeg',
      args: A.splitSegment({
        input: task.input,
        output,
        start: seg.start,
        duration: seg.end - seg.start,
        fadeIn: p.fadeIn,
        fadeOut: p.fadeOut,
        format,
        bitrate: p.bitrate,
        threadCount: p.threadCount
      }),
      output,
      weight: 1,
      label: `切分 #${idx + 1}`
    }
  })
}

/**
 * 执行单个任务：逐个 op 串行跑，按 weight 折算总进度。
 * 失败时会把本任务已经产出的文件删掉，不留半成品。
 * @param {object} task 任务快照
 * @returns {Promise<void>} 任务进入终态后 resolve（失败也 resolve，状态写在 store 里）
 */
async function runTask(task) {
  const api = svc()
  const ops = task.ops
  const outputs = []
  let totalWeight = ops.reduce((sum, op) => sum + (op.weight || 1), 0)
  let doneWeight = 0
  let measured = null
  let currentOp = null
  // 取消信号：与每个 await 赛跑，取消后不必等进程自己结束
  const { signal } = createAborter(task.id)

  patchTask(task.id, {
    status: 'running',
    startedAt: Date.now(),
    progress: 0,
    error: '',
    message: (ops[0] && ops[0].label) || '处理中'
  })

  const fail = (err) => {
    const cur = getState().tasks.find((t) => t.id === task.id)
    const canceled = Boolean((err && err.canceled) || (cur && cur.canceled))
    // 只删本任务自己产出的文件，别碰源文件
    if (currentOp && currentOp.output) api.removeFile(currentOp.output)
    for (const out of outputs) api.removeFile(out)
    const patch = canceled
      ? { status: 'canceled', message: '已取消', progress: 0 }
      : { status: 'failed', error: errorTail(err) || String((err && err.message) || err), message: '失败' }
    patchTask(task.id, patch)
    settle(task.id, { ...task, ...patch })
  }

  try {
    for (let i = 0; i < ops.length; i += 1) {
      const op = ops[i]
      currentOp = op
      if (getState().tasks.find((t) => t.id === task.id)?.canceled) {
        throw Object.assign(new Error('已取消'), { canceled: true })
      }

      patchTask(task.id, { message: op.label || '处理中' })

      if (op.capture) {
        // 探测类 op 不产出文件，按「拿到文本即成功」处理（-i 单输入必然非零退出）
        const res = await Promise.race([api.runCapture(task.id, op.args), signal])
        const text = res.text || ''
        if (!res.ok && !text.trim()) {
          throw res.error instanceof Error ? res.error : new Error('探测失败')
        }
        if (op.dynamic === 'splitSegments') {
          const extra = buildSplitOps(task, text)
          ops.push(...extra)
          totalWeight += extra.reduce((sum, e) => sum + (e.weight || 1), 0)
        } else if (op.parse === 'loudnorm') {
          measured = parseLoudnorm(text) || {}
        }
        doneWeight += op.weight || 1
        patchTask(task.id, { progress: Math.min(99, (doneWeight / totalWeight) * 100) })
        continue
      }

      // 两遍法第二遍：把第一遍测到的值注入
      if (op.rebuild && measured) op.args = op.rebuild(measured)

      const startedAt = Date.now()
      await Promise.race([
        api.run(task.id, op.args, {
          onProgress: (p) => {
            const frac = typeof p.percent === 'number' ? p.percent / 100 : 0
            const pct = Math.min(99.5, ((doneWeight + (op.weight || 1) * frac) / totalWeight) * 100)
            const speed = Number(String(p.speed || '').replace('x', '')) || 0
            const elapsed = (Date.now() - startedAt) / 1000
            const eta = pct > 1 ? Math.max(0, (elapsed / pct) * (100 - pct)) : 0
            patchTask(task.id, { progress: pct, speed, eta })
          }
        }),
        signal
      ])

      doneWeight += op.weight || 1
      if (op.output) {
        outputs.push(op.output)
      }
      patchTask(task.id, { progress: Math.min(99.5, (doneWeight / totalWeight) * 100) })
    }

    const finalOutput = outputs[outputs.length - 1] || task.output
    patchTask(task.id, {
      status: 'done',
      progress: 100,
      message: '完成',
      output: finalOutput,
      outputs,
      eta: 0
    })
    settle(task.id, { ...task, status: 'done', output: finalOutput, outputs })

    // 频谱图/波形图：生成完直接在界面里显示，省得去目录里找
    if (task.featureId === 'visualize' && finalOutput) {
      try {
        const dataUrl = api.coverDataUrl(finalOutput)
        if (dataUrl) {
          setState({
            preview: {
              path: finalOutput,
              dataUrl,
              name: finalOutput.split('/').pop(),
              file: task.input,
              kind: (task.plan && task.plan.kind) || 'spectrum',
              source: 'full'
            }
          })
        }
      } catch (_) {}
    }
  } catch (err) {
    fail(err)
  } finally {
    aborters.delete(task.id)
  }
}

/* ------------------------------ 控制 ------------------------------ */

/**
 * 取消任务：pending 直接标记已取消；running 立即发取消信号（任务马上收尾），
 * 同时请 preload 杀进程，双保险——宿主的 runFFmpeg 未必支持 kill。
 * @param {string} taskId 任务 id
 * @returns {boolean} 是否真的发起了取消
 */
export function cancel(taskId) {
  const task = getState().tasks.find((t) => t.id === taskId)
  if (!task) return false
  if (task.status === 'pending') {
    patchTask(taskId, { status: 'canceled', message: '已取消' })
    settle(taskId, { ...task, status: 'canceled' })
    return true
  }
  if (task.status === 'running') {
    patchTask(taskId, { canceled: true, message: '正在取消…' })
    const entry = aborters.get(taskId)
    if (entry) entry.fire()
    const api = svc()
    if (api) {
      try {
        api.cancelTask(taskId)
      } catch (_) {}
    }
    return true
  }
  return false
}

/**
 * 重试：用最初的 op 快照重建（避免带上上次动态展开的片段），再塞回队列。
 * @param {string} taskId 任务 id
 * @returns {boolean} 任务不存在或状态不允许重试时为 false
 */
export function retry(taskId) {
  const task = getState().tasks.find((t) => t.id === taskId)
  if (!task || (task.status !== 'failed' && task.status !== 'canceled')) return false
  const ops = (task.originOps || task.ops).map((op) => ({ ...op, args: op.args ? [...op.args] : op.args }))
  const waitPromise = deferred(task.id)
  setState({
    tasks: getState().tasks.map((t) =>
      t.id === taskId
        ? { ...t, ops, status: 'pending', progress: 0, error: '', canceled: false, message: '', eta: 0 }
        : t
    )
  })
  // deferred 已就位，回填到任务快照上供 waitFor 使用
  const updated = getState().tasks.find((t) => t.id === taskId)
  if (updated) updated.waitPromise = waitPromise
  run()
  return true
}

/**
 * 清掉已完成/失败/取消的任务记录，正在跑的不动。
 * @returns {void} 无返回值
 */
export function clearFinished() {
  setState({ tasks: getState().tasks.filter((t) => t.status === 'pending' || t.status === 'running') })
}

/**
 * @returns {boolean} 是否有任务在跑或排队
 */
export function isBusy() {
  return getState().tasks.some((t) => t.status === 'running' || t.status === 'pending')
}
