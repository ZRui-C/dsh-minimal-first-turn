# DSH Minimal First Turn

[中文](#中文说明) | [Installation](#installation)

`dsh-minimal-first-turn` is a DeepSeek Harness Web plugin that makes an enabled
root session's first model request smaller and closer to the official Minimal
preset, without permanently giving up the selected agent preset.

It is inspired by the first-request conditioning work in
[`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard).
This project is independent, experimental, and not affiliated with DeepSeek.

## What It Does

For compatible presets, while **First-turn minimal** is enabled:

1. A new root session's first request uses the Minimal system prompt.
2. The model sees only the current official Minimal tool: persistent `bash`.
   DSH removed `str_replace_editor` from that preset in September 2026.
3. Automatic workspace-instruction and skill-catalog messages are removed from
   that request. Instruction messages are carried to the next pre-step so
   one-shot nested-directory updates are not lost. Deferred instructions are
   recorded in the session log and survive restart until committed to history.
4. The first durable `tool/call` or `assistant/message` restores the selected
   preset's original prompt and complete tool catalog.
5. After `compaction/end`, the next request enters the same controlled phase.

The composer contains a persistent **首轮精简** switch. It is global to the
current DSH home, not per-session. Disabling it removes this plugin's
agent-scoped Minimal tools before the next model request and stops filtering
for that request. An already assembled request and its tool batch finish with
the same provider, so toggling cannot unload a tool before it executes.

## Installation

This working version is validated with DSH Web **`0.2.0-rc.2` and
`0.2.1-alpha.1`**. Peer requirements explicitly allow these two versions, not
an untested continuous version range. The former `0.1.0-rc.6` is unsupported.

The repairs are available from GitHub; merging them does not publish a new npm
release. To install the GitHub version and keep the dependency registry separate:
A persistent Bash PTY is required, so the current release supports macOS and
Linux hosts; Windows is not supported yet.

```bash
dsh plugin --profile web add "github:ZRui-C/dsh-minimal-first-turn#main" --registry=https://registry.npmjs.org/
```

The GitHub address is the package spec; `--registry` is an npm registry, never
a GitHub repository URL. This flag applies only to this installation. Do not use
`allow-version` to bypass a version mismatch.

Restart the existing `dsh web` process, then open a conversation. The
**首轮精简** switch appears beside the composer controls.

The toggle state is stored at:

```text
$DSH_HOME/plugins/dsh-minimal-first-turn.json
```

When `DSH_HOME` is unset, the path is `~/.dsh/plugins/dsh-minimal-first-turn.json`.

## Development

```bash
pnpm install
pnpm check
npm pack --dry-run
```

For a local Web profile, add the package as a dependency and mount its
`cordis.patch.yml`, then restart `dsh web`. Host changes require a restart;
client-only changes require a page reload when the Web HMR watcher is not
running.

## Compatibility and Caveats

- The plugin changes model-visible first-request conditions. It does not
  guarantee a particular reasoning phrase or outcome.
- Its behavior is intentionally limited to root sessions; subagents keep their
  original catalog.
- The first-turn phase uses the current session-projection registry. Resume,
  compaction, and events recorded while the switch is off preserve it correctly.
- Custom complete system prompts are protected by current DSH. If their text
  differs from Minimal, the plugin leaves the entire request unchanged and logs
  a warning. It does not override that protection. The official Minimal complete
  prompt remains supported.
- PTC-only tool presentation and same-agent-scope Bash registration conflicts
  also fall back to the original request. A compatible native Bash catalog is
  required; no partial prompt/message filtering is applied after a failed mount.
- The temporary Bash provider is retained through its first tool batch, then
  removed before the next assembled request restores the preset's own Bash.
  Persistent shell state from the bootstrap shell is not transferred to the
  preset's shell; filesystem changes remain on disk.
- The toggle endpoint uses DSH Connection's Host/Origin checks and browser
  authentication. The browser route is document-relative for mounted Web URLs.
- `pnpm check` runs syntax/import validation and behavioral tests. Host tests use
  both pinned DSH/Cordis families, prompt/tool registries, official Bash registration,
  and each runtime's real plugin compatibility gate without exemptions;
  projection tests use the current Session and projection registry. Client tests
  use a lightweight hook harness. No live model request, PTY command, full browser,
  or Mac integration test is claimed.
- DeepSeek Harness is a developer preview. Pin the supported DSH package
  versions when using this in production.

## License

MIT. The implementation includes derivative work from the MIT-licensed
`dsh-anchored-standard` project and DeepSeek Harness packages; the required
attribution is included in [LICENSE](LICENSE).

## 中文说明

这是一个 DSH Web 插件。开启“首轮精简”后，新根会话的第一轮模型请求会使用
Minimal system prompt 与持久 `bash`（与当前官方 Minimal 一致），并移除自动注入的
工作区说明和技能目录。首次 `tool/call` 或 `assistant/message` 后，当前预设的
完整 prompt 与工具目录恢复；发生上下文压缩后，下一轮会再次进入首轮精简阶段。

它不保证模型输出固定的推理措辞，只控制模型可见的首轮条件。开关是全局持久设置，
而不是单个会话设置。

当前开发版本已验证 DSH `0.2.0-rc.2` 与 `0.2.1-alpha.1`，不支持旧的 `0.1.0-rc.6`。自定义完整
system prompt、PTC-only 工具模式或同一 agent scope 内的 Bash 冲突会保持原请求，
并记录警告。关闭开关从下一次请求组装生效，不会打断已经选定的工具调用。

### Testing the runtime matrix

The default lockfile tests `0.2.1-alpha.1`. CI also selects `0.2.0-rc.2` with
its matching frozen fixture lockfile and Cordis packages, on Node 22 and 24:

```bash
node scripts/select-test-runtime.mjs 0.2.0-rc.2
cp test/fixtures/pnpm-lock.rc2.yaml pnpm-lock.yaml
pnpm install --frozen-lockfile
DSH_TEST_VERSION=0.2.0-rc.2 pnpm check
```

Run the alternate selection in a disposable checkout. The selection script
changes development dependencies only; it never relaxes the published peer
requirements or the DSH compatibility guard.
