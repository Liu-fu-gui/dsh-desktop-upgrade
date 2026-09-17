# dsh-desktop-upgrade

给 **DSH Desktop** 补上一个它自己缺的「升级 DSH」入口。不改任何内核文件。

## 为什么需要它

- DSH Desktop 的 Web 设置页**没有**检查更新按钮：`client.js` 里 `api.checkForUpdates()` 和中文文案「检查更新」都定义了，但那个组件从来没渲染它。
- 官方入口只藏在**系统托盘**「检查更新…」（后台也会每 6 小时自动查一次并发系统通知）。
- 桌面版内核在 `<安装目录>\resources\app\node_modules\@deepseek-ai\dsh`，profile 里看到的 `~/.dsh/profiles/node_modules/@deepseek-ai/*` **全是指向它的 Junction**。所以任何"npm/pnpm 一键升级 dsh 本体"的第三方插件在这里都改不动内核，真正的升级只能靠官方安装包。

本插件做的就是把官方那条链路补到可点的地方，并让模型也能调用：

1. **托盘菜单**新增「升级 DSH…」：查官方版本服务 → 有新版时弹原生确认框（下载 / 稍后）→ 下载官方安装包并打开。用的是桌面版自己的 `desktopRuntime.updates` 适配器，和官方托盘项完全同一条路径。
2. **模型工具 `dsh_upgrade`**：`status`（只报版本，不弹窗）/ `check`（只检查）/ `upgrade`（确认后下载安装包）。

## 它放在哪

三层的职责不同，别混：

| 层 | 位置 | 谁管 |
|---|---|---|
| 桌面版本体（含内核） | `D:\ruanjian\DSH Desktop\`（`resources\app`） | 官方安装包 / 桌面版自带更新通道 |
| **插件包安装位置** | `C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-desktop-upgrade` | `dsh plugin`（= 在 profile 目录跑 pnpm） |
| **插件登记位置** | `C:\Users\Administrator\.dsh\profiles\desktop\package.json` 的 `dependencies` + `dsh.profile.bundles` | 同上，装完自动登记 |

也就是说：**源码放哪都行**（现在在 `D:\trea\tmp\dsh-desktop-upgrade`），真正生效的位置是 profile 的 `node_modules` + `package.json`。别手动拷进 profile，用官方命令装，它会顺带把 `dsh.profile.bundles` 对平。

## 安装

仓库已发布：<https://github.com/Liu-fu-gui/dsh-desktop-upgrade>（带 `dsh-plugin` topic，会被插件市场扫到）

在 **DSH 终端**（设置 → 打开 DSH 终端）或任何 PATH 里有桌面版 `dsh` 的终端里执行：

```powershell
# 方式一：从 GitHub 安装（推荐）
dsh plugin add github:Liu-fu-gui/dsh-desktop-upgrade

# 方式二：本地开发态安装，改完代码重启即生效
dsh plugin add link:D:\trea\tmp\dsh-desktop-upgrade

# 装完确认
dsh plugin list
```

> npm 目前**没有**发布：本机 `npm whoami` 未登录，且默认源是只读镜像 `registry.npmmirror.com`。
> 想走 npm 需要先 `npm login`（或配 `//registry.npmjs.org/:_authToken`），再用
> `npm publish --registry https://registry.npmjs.org`；届时把 `package.json` 里的 `"private": true` 去掉即可。

`dsh plugin` 会自动补上 `--profile desktop`（桌面版 shim 的行为），实际就是在该 profile 目录跑 pnpm、然后把依赖对平进 `dsh.profile.bundles`。

> 建议先备份 profile：
> `Copy-Item C:\Users\Administrator\.dsh\profiles\desktop\package.json C:\Users\Administrator\.dsh\profiles\desktop\package.json.bak-dsh-desktop-upgrade`
> （以及 `pnpm-lock.yaml`）。目录里已有的 `package.json.bak-*` 说明这套流程以前用过。

**装完必须重启 DSH Desktop**（profile 组合变化不会热生效）。重启会中断当前会话 —— 从托盘菜单退出再开，或设置里「重启」。

## 使用

- 托盘图标右键 → **「升级 DSH…」**：有新版会弹确认框，确认后下载官方安装包并自动打开，跑完安装向导即完成升级。
- 对话里让 agent 调 `dsh_upgrade`：例如"查一下 DSH 有没有新版本"（`status` / `check`），或"升级 DSH"（`upgrade`，同样会在屏幕上弹确认框，需要你点同意）。

## 卸载

```powershell
dsh plugin remove dsh-desktop-upgrade
```

然后重启 DSH Desktop。

## 验证过的行为（本机 2026 实测）

- `dsh-plugin-desktop@2.0.10` / stable 通道：官方最新 = `2.0.10` → `status` 返回 `up-to-date`。
- beta 通道：官方最新 = `2.0.10-beta.1`，按 SemVer 比较低于稳定版 `2.0.10` → 也判为 `up-to-date`（不会把你劝去降级）。
- SemVer 比较与预发布规则有一组用例，见 `D:\trea\tmp\plugin-test\test.mjs`（含一次真实的版本服务调用）。

## 已知边界

- 只在 **DSH Desktop 发行版**里可用：`desktopRuntime` 服务不存在时，插件不注册托盘项，`dsh_upgrade` 返回 `unavailable`。
- 非打包模式（`isPackaged === false`）不注册托盘项。
- 它**不**做应用内静默自更新，也**不**替换 `resources\app` 里的内核 —— 那属于改安装目录，会被下次官方更新覆盖。它只驱动官方安装包通道。
- 该插件不改动、也不依赖任何内核文件；只用公开的 Cordis 服务（`tools`、`desktopRuntime`）与官方版本/下载端点。