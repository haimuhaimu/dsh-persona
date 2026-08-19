# dsh-persona

给 DeepSeek Harness 的 agent 装上一个**可切换、会记住的「人设」**——让 DSH 从工具变成有性格的伙伴。

Give your DeepSeek Harness agent a switchable, persistent **persona** — a voice and a stance, not just a tool.

## 特性

- **持久人设注入**：在每轮请求前把当前人设作为上下文注入，agent 全程以该身份回应（复用 DSH 官方 `agent/pre-step` 扩展点，与内置的 time-context / agent-instructions 同机制）。
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

## 配置

`cordis.patch.yml` 里的 `config`：

| 键 | 默认 | 说明 |
|----|------|------|
| `activePersona` | `"an-ruotong"` | 首次运行的默认人设 id；之后以运行时切换并持久化的选择为准 |
| `statePath` | `~/.dsh/persona-state.json` | 状态文件路径（保存当前人设） |
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

- 人设文本作为一条 `kind: 'plugin' / form: 'instructions'` 的用户消息注入，进入会话日志、跨轮可见。
- 每个人设在每个 agent 实例里只注入一次；`switch_persona` 会触发下一次请求重新注入新人设。
- **已知限制**：会话经历 compaction（上下文压缩）后，早期注入的人设可能被摘要掉，此时可再次 `switch_persona` 触发重注入。
