# 发布

## 1. 发到 npm

```bash
npm login
npm publish
```

`dsh-agent-bench` 这个包名在 npm 上是空的，首次发布可以直接用。之后每次发版先改
`package.json` 的 `version`，再 `npm publish`。

发完核对一下：

```bash
npm view dsh-agent-bench version
```

`files` 里只放了 `lib`、`benchmarks`、`cordis.patch.yml`、`README.md`、`LICENSE`，
测试和开发脚本不会进包。`npm pack --dry-run` 可以先看清单。

## 2. 上架到 DSH 插件市场

市场的插件列表来自精选仓库 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，
不是 dshmarket 仓库本身。dshmarket 每次打开都实时拉 `awesome-dsh-plugin.com/plugins.json`，
所以那边收录后，市场里就能搜到。

流程：

1. fork `awesome-dsh-plugin`
2. 在列表里按相邻条目的格式加一行（具体语法看那里现有的写法）
3. 提 PR

需要的字段：

| 字段 | 值 |
|---|---|
| name | `dsh-agent-bench` |
| owner / url | `songrui111` / `https://github.com/songrui111/dsh-agent-bench` |
| npm | `dsh-agent-bench` |
| category | `dev` |
| install | `dsh plugin --profile web add dsh-agent-bench` |

描述（中英各一条）：

> en: Regression benchmark for DSH agents. Runs fixed cases in isolated sandboxes,
> scores them with deterministic assertions plus an optional LLM review, and diffs
> two scorecards so you can see what regressed.
>
> zh: DSH Agent 的回归基准。在隔离沙箱里跑固定用例，用确定性断言（可叠加 LLM 评审）
> 判分，再对比两次成绩卡，看是哪一条退化了。

## 3. 发布前自检

在一台没装过的机器上，或者新建一个 profile 上验证：

- [ ] `npm view dsh-agent-bench version` 能查到新版本
- [ ] `dsh plugin --profile web add dsh-agent-bench` 装完，重启后 `bench_suites` 有返回
- [ ] 工作区里没有 `benchmarks/` 时，`bench_suites` 报 `source: bundled`
- [ ] `bench_init` 能把内置套件复制到工作区
- [ ] `bench_run core` 至少跑通一次（会消耗额度）

## 4. 写插件时会遇到的几个坑

留个记录，省得下次再踩：

**必须在 `cordis.patch.yml` 里声明 inject。** 插件用了 `ctx.tools` 和 `ctx.commands`
却没写 `inject: [tools, commands]` 的话，整个条目不会激活，插件代码一行都不跑，
宿主只在启动时打一行 `1 entry did not activate`。工具列表里自然什么都没有。

**插件要物理装进 profile，不能用 `link:`。** 宿主解析 bundle 只认 profile 自己的
`node_modules`，符号链接会得到 `skipping profile bundle ... cannot resolve`，
同样只是 warning。

**核心包在 `app.asar` 里，磁盘上没有。** 插件自己 `import '@deepseek-ai/dsh-tools'`
时，需要目录内有一份同版本副本（`devDependencies` 里已经固定了版本）。

**改了服务端插件必须重启宿主。** `cordis.yml` 里的 HMR 只管客户端。

**`ctx.llm` 是流式的。** 没有 `complete()`，要用 `ctx.llm.stream()` 读
`text-delta` 和 `finish` 块；推理模型有时会把输出预算全花在思考上、正文一个字不出，
所以评审那边做了重试。
