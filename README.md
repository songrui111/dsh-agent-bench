# dsh-agent-bench

给 DSH 里的 agent 做回归测试用的。换模型、改系统提示词、升级 DSH 之后，跑一遍就能知道
它是不是变差了，差在哪一条。

## 装

```bash
npm i -g @deepseek-ai/dsh          # 跑真实 agent 需要 dsh CLI
dsh plugin --profile web add dsh-agent-bench
```

要求 DSH ≥ 0.2.0-rc.2、Node ≥ 22.19，并且已经登录 DeepSeek 账号（或者设了
`DEEPSEEK_API_KEY`）。装完在工作区里让我调用 `bench_suites` 就能用，首次运行会自动
准备一套隔离环境，不用手工配路径。

命令行安装需要本机 PATH 上有 `pnpm`（`dsh plugin` 内部会调用它）。桌面版的 pnpm
打包在运行时目录里、没加进 PATH，所以从开始菜单启动的用户如果只用命令行装，可能
要先自己装一个 pnpm；通过插件市场安装则不受影响，市场自己会处理。

## 它测什么

一条用例 = 一份起始文件 + 一句任务 + 一组判分规则。比如内置的这条：

```
benchmarks/core/fix-bug-keep-tests/
  case.json          "calc.js 里 add() 写成了减法，修好它，别动 test.js"
  fixture/calc.js    有 bug 的实现
  fixture/test.js    测试（跑起来是红的）
  expect/test.js     测试文件的逐字节副本，用来锁死它
```

跑的时候把 `fixture/` 复制到一个空目录，agent 在里面干活，干完按 `case.json` 里的
规则判分。所以每次的起点都完全一样，两次运行之间的差别只可能来自模型或宿主。

判分只认确定性的东西：

| 断言 | 作用 |
|---|---|
| `file-exists` / `file-absent` | 文件在不在 |
| `file-contains` / `file-not-contains` | 有没有某个字符串 |
| `file-matches` | 正则匹配 |
| `file-equals-expect` | 和 `expect/` 下的文件逐字节比对 |
| `command` | 在沙箱里执行命令，比对退出码 |

断言里的路径都被限制在沙箱内，写 `../` 会直接报错。

用例可以额外写一段 `llmReview`，让模型按标准打个分。这个分数**不参与回归判定**，
只作为参考记在成绩卡里——评审模型的心情变化不该被当成能力退化。对比两次运行时，
如果评审结论变了但断言没变，会单独列成「漂移」。

## 跑一次看看

```
> bench_run core

✅ 4/4 条用例通过（100%）
   套件 core  ·  运行 20261026010837-896ec37d  ·  1分01秒

   ✅ fix-bug-keep-tests     31.4s   评审 1.0
   ✅ fix-off-by-one          9.7s   评审 1.0
   ✅ rename-across-files    10.0s   评审 1.0
   ✅ write-fizzbuzz         10.0s   评审 1.0

下一步：换模型 / 改提示词 / 升级 DSH 之后重跑同一套件，再对比两次运行。
成绩卡：…\.agent-bench\runs\20261026010837-896ec37d\core.json
可读报告：…\.agent-bench\runs\20261026010837-896ec37d\core.md
```

失败会直接指出是哪条断言挂的：

```
   ❌ write-fizzbuzz        9.1s
      └ command: exit 1 (want 0): FAIL Fizz
```

换成别的模型或版本之后再跑一次，然后：

```
> bench_compare core

🔴 回归     通过率 100% → 75%（-25%）
## 回归用例
- fix-off-by-one — command: exit 1 (want 0)
```

每次运行会在 `.agent-bench/runs/<runId>/` 下留一份 JSON 和一份 Markdown。JSON 给
`bench_compare` 做机器对比，Markdown 是给人看的，可以直接贴进 issue。

## 命令

| 工具 | 做什么 |
|---|---|
| `bench_suites` | 列出套件和用例数 |
| `bench_init` | 把内置套件复制到工作区，之后随便改 |
| `bench_run` | 跑套件 |
| `bench_compare` | 对比两次运行 |
| `bench_history` | 看跑过的记录 |

也支持 `/bench list`、`/bench runs`、`/bench compare <套件>`。

## 内置套件

`core` 和 `workflow` 各 4 条，一装上就有东西能跑：

- **core**：修 off-by-one、修 bug 但不许改测试、跨文件重命名、从零实现 fizzbuzz
- **workflow**：只改该改的文件、补边界用例、照规格实现、抽取重复代码

这些只是示例。真正有用的是把你自己工作流里的规矩写成用例，比如「改完代码要自己跑
测试」「重构后测试要全绿」。

## 隔离

基准要真跑 agent，就得有模型凭据，但不能动你现有的配置。插件在
`<workspace>/.agent-bench/home` 建一个独立的 `DSH_HOME`：

- 把真实 home 的 `.credentials.yaml` 复制进去（已存在就不覆盖，只读）
- 检测到账号授权时，自动挂上 account provider；否则沿用环境里的 API key
- 会话、存储、profile 都在这个目录里，跑完不影响你平时的东西

CLI 的位置按 `cliPath` 配置 → `DSH_BENCH_CLI` 环境变量 → `PATH` 上的 `dsh` 依次查找。

## 配置

都有默认值。机器相关的路径建议写在 profile 的 `cordis.patch.yml` 里：

| 键 | 默认 | 说明 |
|---|---|---|
| `suitesRoot` | `benchmarks` | 用例目录（相对工作区） |
| `scorecardRoot` | `.agent-bench` | 成绩卡目录 |
| `sandboxRoot` | `.agent-bench/sandboxes` | 沙箱目录 |
| `caseTimeoutMs` | `300000` | 单条用例超时 |
| `keepSandboxes` | `false` | 跑完保留沙箱，方便排查 |
| `llmReviewEnabled` | `true` | 评审总开关，用例里还得声明 `llmReview` |
| `maxArtifactBytes` | `262144` | 单个产物读取上限 |
| `cliPath` | `''` | dsh CLI 入口，空则自动找 |
| `dshHome` | `''` | 隔离 home，空则用 `.agent-bench/home` |
| `cliArgs` | `["--profile","headless"]` | 启动参数，空则用自举结果 |
| `llmProvider` / `llmModel` | `''` | 评审用哪个模型，空则用宿主当前选中的 |
| `language` | `zh` | 输出语言，`zh` 或 `en` |

## 开发

要改插件本身的话：

```bash
node --test test/*.test.js        # 65 个单测，不需要模型
node scripts/negative-control.mjs # 确认好坏 agent 判分不同
node scripts/vacuity-check.mjs    # 确认空转 agent 每条都失败
node scripts/run-suite.mjs core   # 真跑一个套件（要 DSH_BENCH_CLI）
node scripts/preview-report.mjs   # 用已有成绩卡预览输出格式
```

改完代码记得重启 DSH。`cordis.yml` 里的 HMR 只管客户端，服务端插件不会热重载。

## 已知问题

- 每条用例都是一次真实的模型调用。8 条全跑大概 2–4 分钟，会消耗额度。
- 串行跑是故意的。并发会让耗时和成本在版本之间没法比。
- 只在 Windows 上完整跑通过。代码里路径处理是按跨平台写的，但没实测。
- 评审偶尔会返回空文本（模型把预算全花在推理上）。现在会重试三次，仍失败就把错误
  记在成绩卡里，不影响判分。

## License

MIT
