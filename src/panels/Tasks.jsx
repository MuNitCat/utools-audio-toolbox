import { cancel, clearFinished, retry } from '../core/queue.js'
import { useStore } from '../core/store.js'
import { formatClock } from '../core/format.js'
import Icon from '../components/Icon.jsx'

const STATE_TEXT = {
  pending: '等待中',
  running: '处理中',
  done: '完成',
  failed: '失败',
  canceled: '已取消',
  skipped: '跳过'
}

/**
 * 单条任务：跑动中显示百分比、速度、剩余时间；结束后显示产出文件名。
 * 「打开」按钮只对已完成的输出生效，避免指向半成品。
 * @param {{task: object}} props 任务快照
 * @returns {JSX.Element}
 */
function TaskRow({ task }) {
  const api = typeof window !== 'undefined' ? window.audioServices : null
  const name = task.input.split('/').pop()
  const stateText = task.status === 'running' && task.message ? task.message : STATE_TEXT[task.status] || task.status
  const pct = Math.max(0, Math.min(100, task.progress || 0))

  return (
    <div className="task">
      <div className="task-head">
        <span className="name" title={task.input}>
          {name}
        </span>
        {(task.status === 'running' || task.status === 'pending') && (
          <button className="link-btn" onClick={() => cancel(task.id)}>
            取消
          </button>
        )}
        {(task.status === 'failed' || task.status === 'canceled') && (
          <button className="link-btn" onClick={() => retry(task.id)}>
            重试
          </button>
        )}
        {task.status === 'done' && task.output && (
          <button
            className="icon-btn task-open"
            title="打开所在文件夹"
            aria-label="打开所在文件夹"
            onClick={() => api && api.openInFolder(task.output)}
          >
            <Icon name="folder" size={18} />
          </button>
        )}
        <span className={`state ${task.status}`}>
          {task.status === 'running' ? `${stateText} ${pct.toFixed(0)}%` : stateText}
        </span>
      </div>

      {(task.status === 'running' || task.status === 'pending') && (
        <div className="bar">
          <i style={{ width: `${pct}%` }} />
        </div>
      )}

      <div className="task-foot">
        <span>{task.featureName}</span>
        {task.status === 'running' && task.speed > 0 && <span>{task.speed.toFixed(1)}x</span>}
        {task.status === 'running' && task.eta > 0 && <span>剩 {formatClock(task.eta, false)}</span>}
        {task.status === 'done' && task.outputs && task.outputs.length > 1 && <span>{task.outputs.length} 个输出</span>}
        {task.status === 'done' && task.output && <span>{task.output.split('/').pop()}</span>}
      </div>

      {task.error && <div className="task-error">{task.error}</div>}
    </div>
  )
}

/**
 * 任务区：只渲染最近 30 条，避免长时间批量处理后 DOM 过大。
 * @returns {JSX.Element|null} 没有任务时返回 null
 */
export default function Tasks() {
  const tasks = useStore((s) => s.tasks)
  if (!tasks.length) return null

  const active = tasks.filter((t) => t.status === 'running' || t.status === 'pending').length
  const done = tasks.filter((t) => t.status === 'done').length

  return (
    <div className="tasks">
      <div className="tasks-head">
        任务
        <span style={{ marginLeft: 'auto', letterSpacing: 0, textTransform: 'none' }}>
          {active ? `${active} 进行中` : `${done}/${tasks.length} 完成`}
        </span>
        {!active && (
          <button className="link-btn" style={{ marginLeft: 6 }} onClick={clearFinished}>
            清除
          </button>
        )}
      </div>
      {tasks.slice(-30).map((task) => (
        <TaskRow key={task.id} task={task} />
      ))}
    </div>
  )
}
