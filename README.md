# dsh-persona

给 DeepSeek Harness 的 agent 装上一个**可切换、会记住的「人设」**——让 DSH 从工具变成有性格、有记忆的伙伴。

Give your DeepSeek Harness agent a switchable, persistent **persona** — a voice, a stance, and cross-session memory, not just a tool.

## 特性

- **持久人设注入**：在每轮请求前把当前人设作为上下文注入，agent 全程以该身份回应（复用 DSH 官方 `agent/pre-step` 扩展点，与内置的 time-context / agent-instructions 同机制）。
- **跨会话角色记忆**：每个人设独立保存一套记忆（`~/.dsh/persona-memory.json`），重启后依然记得；激活该人设时自动注入最近记忆，也可用工具显式增删查。
- **运行时切换**：`switch_persona` 工具一键换人设，选择持久化到磁盘，重启后依然生效。
- **内置 3 个精写人设 + 1 个「本尊」**，也支持用配置追加自定义人设。
- 纯 JS、零构建，跟 `dsh-image-gen` 一样即装即用。

## 内置人设

| id | 名字 | 一句话 |
|----|------|--------|
| `an-ruotong` | 安若童 | 清冷敏锐的视觉观察者，用照片和短句记录普通日常 |
| `yan-guan` | 严观 | 眼光毒辣、有品位的审美与文案裁判 |
| `lao-jie` | 老街 | 旧书店里的说书人，把琐事讲成有画面感的小故事 |
| `default` | 本尊 | 关闭人设，回到 DSH 默认助手 |

`an-ruotong` 来自 [haimuhaimu/anruotong-character-system](https://github.com/haimuhaimu/anruotong-character-system) 的视觉角色设定。

## 安装

```sh
# 从 GitHub 安装
dsh plugin --profile <profile> add github:haimuhaimu/dsh-persona

# 或本地安装
dsh plugin --profile <profile> add ./persona
```

首次通过 pnpm 安装若被 prepare 脚本拦截，按提示把包键加入 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 后重新 add。装好后重启 DSH Desktop（或重载 profile）。

## 使用

安装并启用后，agent 会默认以 `an-ruotong` 的身份回应。你可以直接对它说，也可以让它自己调用工具：

- `list_personas` —— 列出可用人设和当前人设。
- `switch_persona` —— 切换人设，例如 `switch_persona("yan-guan")`，或 `switch_persona("default")` 关闭人设。
- `persona_remember` —— 把一件事记进**当前人设**的跨会话记忆，例如 `persona_remember("用户喜欢清晨的光线、讨厌网红风")`。
- `persona_recall` —— 回想当前人设的记忆（可传关键词过滤）。
- `persona_forget` —— 按序号删除一条记忆（序号对应 `persona_recall` 的编号列表）。

记忆是**按人设隔离**的：`an-ruotong` 记得的事不会串到 `yan-guan` 那里，反之亦然。每个具体人设激活时会自动把最近记忆注入上下文，所以它会「自然记得」而不必每次都 recall。

## 配置

`cordis.patch.yml` 里的 `config`：

| 键 | 默认 | 说明 |
|----|------|------|
| `activePersona` | `"an-ruotong"` | 首次运行的默认人设 id；之后以运行时切换并持久化的选择为准 |
| `statePath` | `~/.dsh/persona-state.json` | 状态文件路径（保存当前人设） |
| `memoryPath` | `~/.dsh/persona-memory.json` | 跨会话记忆文件路径 |
| `personas` | `[]` | 追加自定义人设，字段 `id` / `name` / `tagline` / `prompt` |

人设选择的优先级：**持久化状态 > `activePersona` > `default`**。想重置回配置默认值，删掉状态文件即可。

## 自定义人设

```yaml
- insert:
    - id: persona
      name: dsh-persona
      config:
        personas:
          - id: my-dude
            name: 我的角色
            tagline: 一句话简介
            prompt: |
              你现在是「我的角色」……
```

## 原理与限制

- 人设文本（提示 + 该人设的跨会话记忆）作为一条 `kind: 'plugin' / form: 'instructions'` 的用户消息注入，进入会话日志、跨轮可见。
- 注入按「人设 id @ 记忆版本」去重：切换人设或记忆发生变化时，下一次请求会重新注入完整上下文。
- 记忆上限：每个人设最多 100 条、单条最多 400 字，注入时最多携带最近 40 条（防止上下文无限膨胀）。
- **已知限制**：会话经历 compaction（上下文压缩）后，早期注入的人设可能被摘要掉，此时可再次 `switch_persona` 触发重注入。
