# dsh-plugin-zen-runtime

让 DSH 能用 **OpenCode ZEN 免费模型**的运行时补丁插件——**不修改磁盘上任何文件**。

```sh
node test/runtime.spec.mjs        # 18 项自检，零依赖、不联网
```

## 为什么需要它

DSH 内置的 `requestHeaders()` 会先剔除与 attribution 头同名的 provider 头，再把
attribution 依次覆盖上去。结果是：**provider 里配的 `User-Agent` 永远发不出去**，
请求只能以 `deepseek-harness/...` 的身份出网，ZEN 网关遂以
`403 FreeTierError`（"free tier can only be used from within OpenCode"）拒绝。

社区已有的 `dsh-plugin-zen-useragent` 靠**改写磁盘文件**解决（替换
`dsh-llm-pi-ai/lib/index.js` 的 `requestHeaders`、替换 pi-ai 的
`openai-completions.js`）。这在 **DSH 桌面应用里无法工作**：桌面版把所有包放在
签名且逐文件校验 SHA-256 的 `app.asar` 内，只读，改不动。

本插件改在**运行时**拦截：启动时包装一次 `globalThis.fetch`，只对 URL 含
`opencode` 的请求补上身份与工具，其余请求原样透传。不读、不写、不打补丁，
因此 **DSH 升级后依然有效**。

## 网关到底校验什么（实测，非推测）

以下结论是把真实 OpenCode 1.18.23 客户端的请求**逐字节抓到**后，在
`https://opencode.ai/zen/v1/chat/completions` 上**单变量剥离**得到的。被拒时网关返回：

```
403 {"type":"error","error":{"type":"FreeTierError",
     "message":"OpenCode's free tier can only be used from within OpenCode"}}
```

| 条件 | 结果 |
| --- | --- |
| `User-Agent` 含 `opencode/<版本>`（如 `opencode/1.18.18`） | **必需**；用 DSH 的 attribution UA 一定 403 |
| `x-opencode-session` = `ses_` + **12 位小写十六进制** + 14 位字母数字 | **必需**；26 位 base32 随机串会 403 |
| `body.tools` 同时含 `bash` 与 `read` | **必需**；只有 `read`（DSH 原生如此）403，只有 `bash` 也 403 |
| `x-opencode-client` / `x-opencode-project` / `x-opencode-request` | 非必需（实测去掉仍 200），但真实客户端会发，本插件照样补上 |
| 系统提示词的内容与长度 | **完全无关**：删掉 64 KB 的 OpenCode 提示词、或压到 18 字符，仍 200 |

> 注意两个常见误判：真实客户端发的头是 `x-opencode-request`，**不存在**
> `x-opencode-request-id`；而 `x-opencode-ticket` / `x-opencode-directory` /
> `x-opencode-workspace` 是 opencode **本地服务**用的头，与 ZEN 网关无关。

## 端到端证据

同一个请求（DSH 的 attribution UA + DSH 那套缺 `bash` 的工具集），装/不装本插件：

```
BEFORE — 未加载插件     403  FreeTierError
AFTER  — 钩子生效       200  OK(stream)     <- 真实流式回复
```

## 装配（以 DSH 桌面应用的 `desktop` profile 为例）

桌面应用的 profile **不能由 `dsh` CLI 管理**（`rejectElectronProfile`），因此手工接线，
三处改动：

1. 包放进 profile 的 `node_modules`（软链即可，改源码后重启生效）：

   ```sh
   ln -sfn /path/to/dsh-plugin-zen-runtime \
     ~/.dsh/profiles/desktop/node_modules/dsh-plugin-zen-runtime
   ```

2. `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 声明它：

   ```json
   { "dsh-plugin-zen-runtime": "link:/path/to/dsh-plugin-zen-runtime" }
   ```

3. `~/.dsh/profiles/desktop/cordis.patch.yml` 插一行（本包**不声明
   `dsh.bundle`**，故意不参与 bundle 叠加，避免被 plugin-manager 对账后出现重复行）：

   ```yaml
   - insert:
       - id: zen-runtime
         name: dsh-plugin-zen-runtime
   ```

**必须重启 DSH**：bundle 列表与 Loader 行都在进程启动时定格。重启后终端/日志应出现
`[zen-runtime] fetch hook active — ...`；没有这行就说明行没挂上。

## provider 配置

ZEN 的 API key 放 DSH 凭据存储（`apiKeyEnv` 指向的名字即可）：

```yaml
- id: llm-pi-ai
  config:
    providers:
      opencodezen:
        displayName: OpenCode ZEN (free)
        apiKeyEnv: OPENCODEZEN_API_KEY
        api: openai-completions
        baseURL: https://opencode.ai/zen/v1
        models:
          - id: ling-3.0-flash-fin-free
            name: ling-3.0-flash-fin-free
```

**provider 里不用配 headers**：配了 `User-Agent` 也会被 `requestHeaders()` 剥掉，
身份由本插件在 fetch 层补齐——那一层之后没有任何东西会覆盖它。

## 行配置（可选）

`cordis.patch.yml` 里的行 `config` 可覆盖以下键；patch 会整体替换 `config`，
保留哪些键就要重新写全。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `userAgent` | `opencode/1.18.18` | 发往 opencode 请求的 `user-agent` |
| `referer` | `https://opencode.ai` | 仅在请求没有该头时补 |
| `project` | `global` | `x-opencode-project`；置空字符串则不发送 |
| `ensureTools` | `true` | 是否补齐网关要求的 `bash` 与 `read` |

## 已知边界

- 只对 URL 含 `opencode` 的请求生效；其余请求的原参数原样转发。
- 免费额度是按账号/按 IP 计的**每日**限制，与本插件无关；用尽后网关同样会拒绝，
  等到额度重置即可。
- `x-opencode-session` 每个进程生成一次并复用，`x-opencode-request` 每请求一条——
  与真实客户端一致。
