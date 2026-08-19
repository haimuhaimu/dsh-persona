import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { builtinPersonas, defaultPersona } from './personas.js'

export const name = 'persona'

/** 依赖注入：`agents` 提供 pre-step 钩子，`tools` 提供工具注册。 */
export const inject = ['agents', 'tools']

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
 * 应用插件：注册人设切换/列举工具，并在每次 agent 请求前把当前人设
 * 作为持久上下文注入（每个人设每个 agent 实例只注入一次，切换后重新注入）。
 * @param ctx - Cordis 插件上下文。
 * @param config - cordis.patch.yml 的 config 块（activePersona / statePath / personas）。
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
  let activeId = loadActiveId(statePath, config.activePersona, personas)

  const availableText = () => [...personas.values()]
    .map((p) => `- ${p.id}（${p.name}）：${p.tagline || '无简介'}`)
    .join('\n')

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
      + "Call list_personas first to see the available ids, or pass 'default' to turn the persona off.",
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
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.persona === 'default'
          ? '已关闭人设，回到 DeepSeek Harness 默认助手。'
          : `已切换为人设「${value.name}」${value.tagline ? `——${value.tagline}` : ''}。`,
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
      }
    },
  }))

  // 每个人设每个 agent 实例只注入一次；切换后 activeId 变化会触发重新注入。
  const injectedForAgent = new WeakMap()

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    if (activeId === 'default') return decision
    if (injectedForAgent.get(agent) === activeId) return decision
    const prompt = personas.get(activeId)?.prompt
    if (!prompt) return decision
    injectedForAgent.set(agent, activeId)
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'plugin', plugin: name, form: 'instructions' },
        }),
      ],
    }
  })
}
