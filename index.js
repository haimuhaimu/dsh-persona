import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { builtinPersonas, defaultPersona } from './personas.js'

export const name = 'persona'

/** 依赖注入：`agents` 提供 pre-step 钩子，`tools` 提供工具注册。 */
export const inject = ['agents', 'tools']

/** 单个人设最多保留的记忆条数。 */
const MAX_NOTES = 100
/** 单条记忆的最大字符数（超出拒绝写入）。 */
const MAX_NOTE_CHARS = 400
/** 注入上下文时最多携带的最近记忆条数。 */
const INJECT_MAX_NOTES = 40

/** 解析 DSH 主目录（$DSH_HOME 或 ~/.dsh）。 */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 状态文件路径：config.statePath 优先，默认 ~/.dsh/persona-state.json。 */
function resolveStatePath(config) {
  return typeof config.statePath === 'string' && config.statePath.length > 0
    ? config.statePath
    : join(dshHome(), 'persona-state.json')
}

/** 记忆文件路径：config.memoryPath 优先，默认 ~/.dsh/persona-memory.json。 */
function resolveMemoryPath(config) {
  return typeof config.memoryPath === 'string' && config.memoryPath.length > 0
    ? config.memoryPath
    : join(dshHome(), 'persona-memory.json')
}

/**
 * 读取上次运行时切换的人设。
 * 优先级：持久化状态 > config.activePersona（首次运行默认）> 'default'。
 */
function loadActiveId(statePath, configDefault, personas) {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
    if (parsed && typeof parsed.activePersona === 'string' && personas.has(parsed.activePersona)) {
      return parsed.activePersona
    }
  } catch {
    // 状态文件不存在或损坏：回退到配置默认值。
  }
  if (typeof configDefault === 'string' && personas.has(configDefault)) return configDefault
  return 'default'
}

/** 持久化当前人设；写入失败不影响本次切换。 */
function persistActiveId(statePath, id) {
  try {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, JSON.stringify({ version: 1, activePersona: id }, null, 2) + '\n')
  } catch {
    // 只读文件系统下切换仍然生效，只是重启后不保留。
  }
}

/**
 * 从磁盘加载记忆，做轻量清洗：只保留结构合法的 note，截断到 MAX_NOTES 条。
 * 文件不存在或损坏时从空记忆开始。
 */
function loadMemory(path) {
  const store = Object.create(null)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const memories = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed.memories
      : undefined
    if (memories && typeof memories === 'object' && !Array.isArray(memories)) {
      for (const [personaId, notes] of Object.entries(memories)) {
        if (!Array.isArray(notes)) continue
        const clean = []
        for (const n of notes) {
          if (n && typeof n.text === 'string' && n.text.trim().length > 0) {
            clean.push({
              id: typeof n.id === 'string' ? n.id : randomUUID(),
              text: n.text.trim().slice(0, MAX_NOTE_CHARS),
              createdAt: typeof n.createdAt === 'number' ? n.createdAt : Date.now(),
            })
          }
        }
        if (clean.length > 0) store[personaId] = clean.slice(-MAX_NOTES)
      }
    }
  } catch {
    // 文件不存在或损坏：从空记忆开始。
  }
  return store
}

/** 持久化全部记忆；写入失败不影响本次会话内的记忆使用。 */
function persistMemory(path, store) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ version: 1, memories: store }, null, 2) + '\n')
  } catch {
    // 只读文件系统下记忆仍可用，只是重启后不保留。
  }
}

/**
 * 应用插件：注册人设切换/列举工具与跨会话记忆工具，并在每次 agent 请求前
 * 把「当前人设提示 + 该人设的跨会话记忆」作为持久上下文注入。
 * 注入按 `人设id@记忆版本` 去重：切换人设或记忆发生变化时重新注入。
 * @param ctx - Cordis 插件上下文。
 * @param config - cordis.patch.yml 的 config 块（activePersona / statePath / memoryPath / personas）。
 */
export function apply(ctx, config = {}) {
  const personas = new Map()
  for (const p of builtinPersonas) personas.set(p.id, p)
  for (const p of Array.isArray(config.personas) ? config.personas : []) {
    if (p && typeof p.id === 'string' && typeof p.prompt === 'string') {
      personas.set(p.id, {
        id: p.id,
        name: typeof p.name === 'string' ? p.name : p.id,
        tagline: typeof p.tagline === 'string' ? p.tagline : '',
        prompt: p.prompt,
      })
    }
  }
  if (!personas.has('default')) personas.set('default', defaultPersona)

  const statePath = resolveStatePath(config)
  const memoryPath = resolveMemoryPath(config)
  let activeId = loadActiveId(statePath, config.activePersona, personas)
  const memoryStore = loadMemory(memoryPath)
  let memoryVersion = 0

  const personaName = (id) => personas.get(id)?.name ?? id

  /** 记忆功能只对具体人设开放；未激活时给出明确引导。 */
  function requireActivePersona() {
    if (activeId === 'default') {
      throw new Error('当前没有激活具体人设；请先 switch_persona 到某个角色（如 an-ruotong），再使用记忆功能。')
    }
    return { id: activeId, name: personaName(activeId) }
  }

  /** 组装注入文本：人设提示 + 该人设的跨会话记忆（越靠后越新）。 */
  function buildContextText() {
    const persona = personas.get(activeId)
    if (!persona || !persona.prompt) return ''
    const notes = memoryStore[activeId] ?? []
    const parts = [persona.prompt, '']
    if (notes.length === 0) {
      parts.push('（你可以用 persona_remember 记下值得长期保留的事；这些记忆只属于当前人设，跨会话保留。）')
    } else {
      const shown = notes.slice(-INJECT_MAX_NOTES)
      parts.push('【跨会话记忆 · 越靠后越新】')
      for (const n of shown) parts.push(`- ${n.text}`)
      if (notes.length > shown.length) parts.push(`…（共 ${notes.length} 条，仅显示最近 ${shown.length} 条）`)
      parts.push('', '（可用 persona_remember / persona_recall / persona_forget 管理记忆。）')
    }
    return parts.join('\n')
  }

  ctx.tools.register(defineTool({
    name: 'list_personas',
    description:
      'List the available assistant personas (人设) the user can switch to, each with its id and one-line tagline.',
    parameters: {},
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          active: { type: 'string', required: true },
          personas: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                tagline: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '当前人设：' + value.active + '\n可用人设：\n'
          + value.personas.map((p) => `- ${p.id}（${p.name}）：${p.tagline || ''}`).join('\n'),
      }],
    },
    async execute() {
      return {
        active: activeId,
        personas: [...personas.values()].map((p) => ({
          id: p.id,
          name: p.name,
          ...p.tagline ? { tagline: p.tagline } : {},
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'switch_persona',
    description:
      'Switch the assistant to a different persona (人设) by id, changing its voice and stance for the rest of the conversation. '
      + "Call list_personas first to see the available ids, or pass 'default' to turn the persona off. "
      + 'Each persona keeps its own cross-session memory, which is restored automatically after switching.',
    parameters: {
      persona: {
        type: 'string',
        required: true,
        description: 'Persona id to adopt, e.g. an-ruotong / yan-guan / lao-jie / default.',
      },
    },
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          persona: { type: 'string', required: true },
          name: { type: 'string', required: true },
          tagline: { type: 'string' },
          memoryCount: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.persona === 'default'
          ? '已关闭人设，回到 DeepSeek Harness 默认助手。'
          : `已切换为人设「${value.name}」${value.tagline ? `——${value.tagline}` : ''}` +
            `（已载入 ${value.memoryCount} 条跨会话记忆）。`,
      }],
    },
    async execute(args) {
      const target = personas.get(args.persona)
      if (!target) {
        throw new Error(`没有名为「${args.persona}」的人设。可用：${[...personas.keys()].join('、')}`)
      }
      activeId = target.id
      persistActiveId(statePath, target.id)
      return {
        persona: target.id,
        name: target.name,
        ...target.tagline ? { tagline: target.tagline } : {},
        memoryCount: (memoryStore[target.id] ?? []).length,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'persona_remember',
    description:
      'Record one durable fact/note into the CURRENT persona\'s cross-session memory. Use this for things worth keeping '
      + 'across sessions (e.g. user preferences, names, ongoing projects). Memory is scoped to the active persona only.',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'The note to remember (a concise, self-contained sentence).',
      },
    },
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          persona: { type: 'string', required: true },
          name: { type: 'string', required: true },
          text: { type: 'string', required: true },
          count: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已记住（${value.name} · 共 ${value.count} 条）：${value.text}`,
      }],
    },
    async execute(args) {
      const current = requireActivePersona()
      const text = String(args.text).trim()
      if (text.length === 0) throw new Error('要记住的内容不能为空。')
      if (text.length > MAX_NOTE_CHARS) throw new Error(`单条记忆不能超过 ${MAX_NOTE_CHARS} 字。`)
      const notes = memoryStore[current.id] ?? (memoryStore[current.id] = [])
      notes.push({ id: randomUUID(), text, createdAt: Date.now() })
      if (notes.length > MAX_NOTES) notes.splice(0, notes.length - MAX_NOTES)
      persistMemory(memoryPath, memoryStore)
      memoryVersion++
      return { persona: current.id, name: current.name, text, count: notes.length }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'persona_recall',
    description:
      'Recall the CURRENT persona\'s cross-session memories, newest last. Pass an optional query keyword to return only matching notes.',
    parameters: {
      query: {
        type: 'string',
        description: 'Optional keyword; only notes containing it are returned.',
      },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          persona: { type: 'string', required: true },
          name: { type: 'string', required: true },
          notes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                text: { type: 'string', required: true },
                createdAt: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.notes.length === 0
          ? `（${value.name} 目前没有记住任何事）`
          : `${value.name} 记得这些：\n` + value.notes.map((n, i) => `${i + 1}. ${n.text}`).join('\n'),
      }],
    },
    async execute(args) {
      const current = requireActivePersona()
      let notes = memoryStore[current.id] ?? []
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (query.length > 0) notes = notes.filter((n) => n.text.includes(query))
      return {
        persona: current.id,
        name: current.name,
        notes: notes.map((n) => ({ id: n.id, text: n.text, createdAt: n.createdAt })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'persona_forget',
    description:
      'Delete one note from the CURRENT persona\'s cross-session memory by its 1-based index (as shown by persona_recall).',
    parameters: {
      index: {
        type: 'number',
        required: true,
        description: '1-based index of the note to delete, matching the numbered list from persona_recall.',
      },
    },
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          persona: { type: 'string', required: true },
          name: { type: 'string', required: true },
          removed: { type: 'string', required: true },
          count: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已忘记（${value.name} · 剩余 ${value.count} 条）：${value.removed}`,
      }],
    },
    async execute(args) {
      const current = requireActivePersona()
      const notes = memoryStore[current.id] ?? []
      const i = Number(args.index) - 1
      if (!Number.isInteger(i) || i < 0 || i >= notes.length) {
        throw new Error(`记忆序号 ${args.index} 不存在（${current.name} 当前有 ${notes.length} 条）。`)
      }
      const [removed] = notes.splice(i, 1)
      persistMemory(memoryPath, memoryStore)
      memoryVersion++
      return { persona: current.id, name: current.name, removed: removed.text, count: notes.length }
    },
  }))

  // 按「人设id@记忆版本」去重：切换人设或记忆变化时重新注入完整上下文。
  const injectedRevision = new WeakMap()

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    if (activeId === 'default') return decision
    const revision = `${activeId}@${memoryVersion}`
    if (injectedRevision.get(agent) === revision) return decision
    const text = buildContextText()
    if (!text) return decision
    injectedRevision.set(agent, revision)
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: name, form: 'instructions' },
        }),
      ],
    }
  })
}
