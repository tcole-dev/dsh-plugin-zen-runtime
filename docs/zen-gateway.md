# OpenCode ZEN 免费额度的客户端校验：实测记录

这份文档记录一件事：**OpenCode ZEN 网关凭什么判断"这个请求来自 OpenCode 客户端"**。
结论全部来自抓包与单变量剥离，不是推测，也不来自任何未经验证的二手说法。

写下来是因为流传的说法里至少有两处是错的，而按错的去做会一直在错的方向上调试。

---

## 1. 现象

用 OpenCode ZEN 的 API key 在第三方 harness 里请求免费模型（`*-free`），网关返回：

```http
HTTP/1.1 403
```

```json
{"type":"error","error":{
  "type":"FreeTierError",
  "message":"OpenCode's free tier can only be used from within OpenCode"
}}
```

同一把 key、同一个模型，用官方 `opencode` CLI 请求则正常返回。所以差异不在凭据，
而在请求本身。

## 2. 测量方法

### 2.1 抓取真实客户端的请求

让官方 CLI 把请求发到本地抓包服务器（覆盖 provider 的 `baseURL`），逐字节落盘：

```sh
OPENCODE_CONFIG_CONTENT='{"provider":{"opencode":{"options":{"baseURL":"http://127.0.0.1:19400/v1"}}}}' \
  opencode run --model opencode/ling-3.0-flash-fin-free "reply ok"
```

> 注意：opencode 启动时还会为 `gpt-5.4-nano` 发一次内部 `/v1/responses` 请求。
> 抓到的多条记录要按 body 里的 `model` 字段过滤，否则会拿错样本。

抓到的样本：15 个工具、64725 字符的系统提示词、95648 字节 body。

### 2.2 单变量剥离

以抓到的原始请求为基准，**每次只改一个变量**发回真实网关，观察 403/200。

> 踩过的坑：id 一旦换成自己生成的格式，成功率会变化。所以头相关的实验必须固定使用
> 抓到的原 id，或使用**格式正确**的新 id（见 §3.2），否则会把 id 格式的问题误判成
> 头的问题——这一步混淆曾让我得出过错误结论。

## 3. 必需项

三项任一缺失都是 403。

### 3.1 `User-Agent` 必须含 `opencode/<版本>`

| User-Agent | 结果 |
| --- | --- |
| `opencode/1.18.18` | **200** |
| `opencode/1.18.23 ai-sdk/... runtime/bun/1.3.14`（官方原值） | **200** |
| `deepseek-harness/0.1.7-rc.2`（其余全部正确） | **403** |

**这是最容易漏掉的一项。** 很多 harness 会把 provider 配置里的 `User-Agent` 覆盖掉，
于是不管怎么补 `x-opencode-*` 头都仍然 403。

### 3.2 `x-opencode-session` 必须是 `ses_` + 12 位小写十六进制 + 14 位字母数字

| `x-opencode-session` 取值 | 结果 |
| --- | --- |
| 抓到的原值 | **200** |
| 新生成，`ses_` + 12 位小写 hex + 14 位 base62 | **200** |
| 新生成，`ses_` + 12 位小写 hex + 14 位 Crockford base32 | **200** |
| 新生成，`ses_` + 26 位 Crockford base32 | **403** |
| 新生成，`ses_` + 26 位 base62 | **403** |

被校验的是**前 12 位必须是十六进制**。把整个 id 从更宽的字母表随机生成会静默失败——
这类 bug 看起来像"网关不认头"，实际是 id 格式不对。

### 3.3 `body.tools` 必须同时含 `bash` 与 `read`

| 工具集 | 结果 |
| --- | --- |
| 完整 11 个 OpenCode 工具 | **200** |
| `read` + `bash`（只要这两个） | **200** |
| 仅 `bash` | **403** |
| 仅 `read` | **403** |
| `edit` `glob` `grep` `read` `skill` `write`（无 `bash`） | **403** |
| 11 个减去 `bash` | **403** |
| 11 个减去 `webfetch` / 减去 `websearch` | **200** |

网关只检查**工具名是否存在**，不看描述与 schema。所以补两个名字正确的桩工具即可。

## 4. 非必需项

以下实测去掉仍是 200。本插件照样发送，只因为官方客户端会发，对齐它没有代价：

| 项 | 实测 |
| --- | --- |
| `x-opencode-client` | 去掉仍 200 |
| `x-opencode-project` | 去掉仍 200 |
| `x-opencode-request` | 去掉仍 200 |
| `Referer` | 未参与判定 |
| 系统提示词 | **完全无关**：删掉 64 KB 的官方提示词、或压到 18 字符，都仍 200 |
| 精确的 UA 字符串 | `opencode/1.18.18` 与官方长 UA 都是 200，只要含 `opencode/<semver>` |

## 5. 官方客户端实际发出的完整头部

抓包所得（provider id 以 `opencode` 开头时）：

```http
User-Agent: opencode/1.18.23 ai-sdk/provider-utils/<ver> runtime/bun/1.3.14
x-opencode-client: cli
x-opencode-project: <project id>
x-opencode-session: ses_<12 hex><14 alnum>
x-opencode-request: msg_<12 hex><14 alnum>
```

`x-opencode-client` 的取值来自 `OPENCODE_CLIENT` 环境变量，默认 `cli`。

## 6. 两处常见误判

1. **不存在 `x-opencode-request-id`。** 官方客户端发的是 `x-opencode-request`。
   服务端事件元数据里出现的 `x-opencode-request-id` 是它内部归一化后的字段名，
   不是线上头名。按错的名字补头不会生效。
2. **`x-opencode-ticket` / `x-opencode-directory` / `x-opencode-workspace` /
   `x-opencode-sync` / `x-opencode-title` 与 ZEN 网关无关**——它们是 opencode
   **本地服务**（`opencode serve` / API / PTY）用的头。

另外，`x-opencode-project` 在真实客户端里是**条件发送**的：`InstanceState.context`
里有 project id 才带。子代理场景还会带 `x-parent-session-id`。

## 7. 复现实验

任何 HTTP 客户端都可以。最小可用形状（把 `$KEY` 换成自己的 key）：

```sh
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://opencode.ai/zen/v1/chat/completions \
  -H "authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -H "user-agent: opencode/1.18.18" \
  -H "x-opencode-client: cli" \
  -H "x-opencode-session: ses_$(openssl rand -hex 6)$(openssl rand -hex 7)" \
  -d '{"model":"ling-3.0-flash-fin-free","stream":true,
       "messages":[{"role":"user","content":"reply ok"}],
       "tools":[{"type":"function","function":{"name":"bash","parameters":{"type":"object","properties":{}}}},
                {"type":"function","function":{"name":"read","parameters":{"type":"object","properties":{}}}}]}'
```

要依次验证哪一项必需，就用上面的基准**每次只改一处**：把 UA 换成别串、把
`x-opencode-session` 去掉、把一个工具去掉。三处各会得到 403。

## 8. 边界与风险

- **免费额度是按账号/按 IP 计的每日限额**，与本插件无关。额度用尽时网关同样会拒绝，
  等额度重置即可。这与本文描述的客户端校验是两个独立机制。
- **上游随时可能改变校验策略。** 本文记录的是测量当时的行为；那之后网关若收紧
  （换校验字段、上更强的指纹、把这项检查移到边缘节点），本插件可能失效。
- **本插件不提供、不绕过任何付费内容。** 它只作用于 ZEN 目录里 `cost.input == 0`
  的免费模型，凭据仍是你自己的 OpenCode key，额度与计费规则不受影响。
- **网关加客户端校验的用意就是把这部分免费额度限制在 OpenCode 内。** 本插件让请求
  看起来来自该客户端。是否使用请自行判断，并自行承担上游封禁或策略变更的风险。
- 请勿把 key 写进仓库、issue 或聊天记录。

## 9. 变更记录

- 2026-09：初版。基于 opencode 1.18.23（`/opt/homebrew` 安装）与 ZEN
  `/zen/v1/chat/completions` 的实测。
