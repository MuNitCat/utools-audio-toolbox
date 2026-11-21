/**
 * 任务队列引擎：串行执行（宿主每个 ffmpeg 都会吃满 CPU，并行只会互相拖慢）。
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

function nextId() {
  counter += 1
  return `t${Date.now().toString(36)}-${counter}`
}

function patchTask(id, patch) {
  setState({
    tasks: getState().tasks.map((t) => (t.id === id ? { ...t, ...patch } : t))
  })
}

function settle(id, result) {
  const fn = waiters.get(id)
  if (fn) {
    waiters.delete(id)
    fn(result)
  }
}

function deferred(id) {
  return new Promise((resolve) => waiters.set(id, resolve))
}

/* ------------------------------ 建任务 ------------------------------ */

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
 * 入队并开始执行
 * @returns {object[]} 任务快照
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

/** 等待这些任务全部结束（MCP 用） */
export function waitFor(tasks) {
  const pending = tasks.filter((t) => t.waitPromise).map((t) => t.waitPromise)
  if (!pending.length) return Promise.resolve(tasks)
  return Promise.all(pending).then(() => tasks)
}

/* ------------------------------ 执行 ------------------------------ */

async function run() {
  if (running) return
  running = true
  setState({ running: true })
  try {
    for (;;) {
      const next = getState().tasks.find((t) => t.status === 'pending')
      if (!next) break
      await runTask(next)
    }
  } finally {
    running = false
    setState({ running: false })
    summarize()
  }
}

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

async function runTask(task) {
  const api = svc()
  const ops = task.ops
  const outputs = []
  let totalWeight = ops.reduce((sum, op) => sum + (op.weight || 1), 0)
  let doneWeight = 0
  let measured = null
  let currentOp = null

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
        const res = await api.runCapture(task.id, op.args)
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
      await api.run(task.id, op.args, {
        onProgress: (p) => {
          const frac = typeof p.percent === 'number' ? p.percent / 100 : 0
          const pct = Math.min(99.5, ((doneWeight + (op.weight || 1) * frac) / totalWeight) * 100)
          const speed = Number(String(p.speed || '').replace('x', '')) || 0
          const elapsed = (Date.now() - startedAt) / 1000
          const eta = pct > 1 ? Math.max(0, (elapsed / pct) * (100 - pct)) : 0
          patchTask(task.id, { progress: pct, speed, eta })
        }
      })

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
  }
}

/* ------------------------------ 控制 ------------------------------ */

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
    const api = svc()
    return api ? api.cancelTask(taskId) : false
  }
  return false
}

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

export function clearFinished() {
  setState({ tasks: getState().tasks.filter((t) => t.status === 'pending' || t.status === 'running') })
}

export function isBusy() {
  return getState().tasks.some((t) => t.status === 'running' || t.status === 'pending')
}
