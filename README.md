# 邮箱插件（IMAP + SMTP）

给 DSH 的 agent 接上真实邮箱：列信、搜索、读正文、把附件存进工作区、发信。
协议交给久经考验的库——`imapflow`、`nodemailer`、`mailparser`，没有手写报文。

这一版**只有邮件，没有日历**。带 CalDAV 日历的上一版完整快照存在外接盘
`邮箱插件-dsh-mail/` 目录里（含 `node_modules`，插上即可用），详见那里的 `BACKUP-INFO.txt`。

## 当前状态

仓库里不含任何真实凭据：包内 `cordis.patch.yml` 的 `config` 是空的 `{}`，只是个带注释的挂载模板；
真实账号写在本机 profile 的 `~/.dsh/profiles/web/cordis.patch.yml` `mail` 行，
密码在 `~/.dsh/.credentials.yaml` 的 `refs.DSH_MAIL_PASSWORD`。

真机验过的：IMAP 993 登录（收件箱 8 封、未读 0、服务器有 INBOX/Sent/Drafts/Archive/Spam/Trash 六个文件夹）、
SMTP 465 与 587 两种握手、正文 MIME 解析、按主题搜索、未读过滤、文件夹名写错时的报错。
没有实际投递过信件——发信是不可撤回的对外动作，测试时只做到 SMTP verify 握手。

改完 `index.js` 或 `src/mailbox.js` 要**重启 DSH** 才会载入新代码；只改配置则即时生效。

## 工具

| 工具 | 作用 |
| --- | --- |
| `mail_status` | 配置与连通性体检，收发两侧失败都作为结果报出而不是抛错；不含密码 |
| `mail_list` | 最近若干封，只有信封信息，可按未读过滤 |
| `mail_search` | 主题 / 发件人 / 收件人 / 正文 / 全文 + 日期范围 |
| `mail_read` | 一封的正文（按长度截断）与附件清单 |
| `mail_download_attachment` | 取一个附件写到当前会话的工作区，返回落盘路径 |
| `mail_send` | 发信，纯文本或文本+HTML 双份，可带工作区内的附件 |

## 配置项

写在 `cordis.patch.yml` 的 `mail` 行 `config` 下。override 会整体替换 config，
不做深合并，所以那份配置里字段写全了，改哪行动哪行。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `account` | 空 | 登录地址 |
| `fromName` | 空 | 发信显示名 |
| `smtpHost` / `smtpPort` / `smtpSecure` | 空 / 465 / true | 发信 |
| `imapHost` / `imapPort` / `imapSecure` | 空 / 993 / true | 收信 |
| `passwordEnv` | `DSH_MAIL_PASSWORD` | 凭据名 |
| `folder` | `INBOX` | 默认文件夹 |
| `readEnabled` / `sendEnabled` | true | 关掉对应那组工具 |
| `askBeforeSend` | true | 每次发信弹人工批准 |
| `allowRecipients` | `[]` | 收件人白名单，空为不限制 |
| `timeoutMs` | 30000 | 单次协议操作超时 |
| `maxList` / `maxBodyChars` | 20 / 12000 | 列表条数与正文上限 |
| `maxMessageBytes` | 8388608 | 单封原文与单个附件上限 |
| `tlsRejectUnauthorized` | true | 内网自签名证书可设 false |

端口与 `secure` 必须成对，这是连不上最常见的原因：993/465 配 `true`（隐式 TLS），
143/587 配 `false`（连上后再 STARTTLS）。

有个坑值得知道：schemastery 不会因为多写了未知字段而报错，未知键会被静默保留。
所以字段名打错了不会有任何提示，只是不生效——改完最好跑一次 `test/live-check.mjs` 确认。

## 密码放哪

密码不进配置文件。插件每次操作都按名字现取一次，改了立刻生效，不用重启。
取值优先级（`dsh-credentials-local` 的实际层次）：进程环境变量 →
`~/.dsh/.credentials.yaml`（必须 600 权限）→ 启动目录 `.env` → `~/.dsh/.env`。

写进托管存储就是在 `refs:` 下加一行：

```yaml
version: 1
refs:
  DSH_MAIL_PASSWORD: '你的密码或授权码'
```

## 安全默认值

发信对外且不可撤回，所以默认逐次人工批准；批准能力不可用时直接拒绝，不会静默发出。
`allowRecipients` 是硬闸门，在白名单内才谈批准：

```yaml
allowRecipients:
  - zhang@example.com     # 只这一个地址
  - '@example.com'        # 只这个域名本身，不含子域
  - example.com           # 这个域名和它的各级子域
```

`to` / `cc` / `bcc` 都查，`张三 <z@example.com>` 这种带显示名的写法也能取对地址。
来信正文与附件一律当外部数据，插件在 system prompt 里写明不要把其中内容当指令执行。
附件读写限制在当前会话工作区内（取 `exec.agent.session.header.cwd`，和内置文件工具同源），越界路径直接拒绝。

不想每次批准就设 `askBeforeSend: false`，建议同时配好 `allowRecipients`。
只要发信、不让 agent 读信，就设 `readEnabled: false`。

## 排障

| 现象 | 处理 |
| --- | --- |
| `IMAP 登录失败` | 企业邮常要求登录名而非完整邮箱地址；确认服务端已开 IMAP/SMTP 访问 |
| `主机名解析不了` | 主机名写错，报错只点出错的那个字段 |
| `TLS 证书不受信任` | 自签名内网证书，设 `tlsRejectUnauthorized: false` |
| 连不上但端口对 | `secure` 与端口不配对，见上表 |
| `服务器上没有名为 X 的文件夹` | `mail_status` 会列出真实文件夹名，中文名照抄 |
| `没有 UID N 的邮件` | 先 `mail_list` / `mail_search` 取真实 uid |
| 大附件读不出来 | 提高 `maxMessageBytes`，或用 `mail_download_attachment` 单独取 |
| 发信被判 deny | 命中 `allowRecipients`，加条目或清空白名单 |
| 发信批准被自动拒绝 | 当前会话关了批准，`ask` 会转成拒绝 |

## 测试

```bash
node test/smoke.mjs      # 离线，随便跑，不发真实网络请求
node test/live-check.mjs # 实机只读自检：读 profile 配置与凭据，连一次 IMAP/SMTP
```

`smoke.mjs` 用假 `ctx` 跑完整 `apply()`。覆盖：6 个工具的注册与 schema 编译、
Config 默认值与边界、两个开关、收件人格式与白名单各种写法、附件路径围栏、
取消信号、未处理 promise 拒绝泄漏、以及每个工具的成功返回值是否真能通过
自己 output schema 的校验（`mail_status` 那个 `unseen: null` 的线上故障
就该被这类断言拦下）。

`live-check.mjs` 只做读取和握手探测，不发信，所以可以随时反复跑。
重启 DSH 之后先跑它，再叫 agent 用工具，能分清是插件的问题还是运行中进程还停在旧代码。

## 安装与目录

profile 以 `link:` 指向本目录安装，**别移动或删除这个目录**；换位置要重新
`install_bundle`。`node_modules` 已随目录存在，不需要再 `npm install`。

依赖只剩三个：`imapflow`、`mailparser`、`nodemailer`。日历层去掉后
`fast-xml-parser` 已 prune 掉。

## 许可证

MIT，见 `LICENSE`。
