/*!
 * dsh-desktop-upgrade — client half (browser bundle).
 *
 * Registers a "DSH 升级" page in the Web settings' settings.section slot:
 * current vs official version, a manual re-check, and one-click hand-off to the
 * official installer download. All version/upgrade work happens on the Host
 * through the plugin's own /dsh-desktop-upgrade routes, so the browser half
 * never touches Electron APIs.
 *
 * Bundle format: the official DSH client-bundle shape — a lazy-CJS closure
 * registered with window.__ModuleLoader__.load({ id, factory }); react is an
 * external resolved from the shell's module table at runtime.
 */
window.__ModuleLoader__.load({
  id: "dsh-desktop-upgrade",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    "use strict";

    var React = require("react");

    /** Locale namespace owned by this settings page. */
    var NS = "dsh-desktop-upgrade";
    /** Host bridge routes. */
    var STATUS_URL = "/dsh-desktop-upgrade/status";
    var UPGRADE_URL = "/dsh-desktop-upgrade/upgrade";
    /** Manual fallback when the app cannot download installers itself. */
    var MANUAL_DOWNLOAD_URL = "https://www.dshdesktop.cn";

    var zh = {
      nav: "DSH 升级",
      title: "DSH Desktop 升级",
      description:
        "检查 DSH Desktop 官方版本，并一键下载官方安装包。升级走桌面版自己的更新通道，不会改动 resources/app 里的内核文件。",
      currentVersion: "当前版本",
      latestVersion: "官方最新",
      channel: "更新通道",
      checking: "正在检查官方版本…",
      check: "检查更新",
      recheck: "重新检查",
      upToDate: "已是最新版本。",
      updateAvailable: "发现新版本 {latest}，可以升级。",
      downloadAndInstall: "下载并安装",
      downloading: "正在下载安装包…",
      manualDownload: "到官网手动下载",
      upgradeStarted: "已把安装包交给系统下载；完成后会自动打开安装向导。",
      unknown: "未知"
    };

    var en = {
      nav: "DSH Upgrade",
      title: "DSH Desktop upgrade",
      description:
        "Check the official DSH Desktop release and download its installer. Upgrading uses the desktop's own update channel and never patches the bundled harness in resources/app.",
      currentVersion: "Installed",
      latestVersion: "Latest",
      channel: "Channel",
      checking: "Checking the official release…",
      check: "Check for updates",
      recheck: "Check again",
      upToDate: "You are on the latest version.",
      updateAvailable: "Version {latest} is available.",
      downloadAndInstall: "Download and install",
      downloading: "Downloading the installer…",
      manualDownload: "Download manually",
      upgradeStarted: "The installer was handed to the system; the setup wizard opens when it finishes downloading.",
      unknown: "unknown"
    };

    /** Render one error as a single line of text. */
    function formatError(cause) {
      if (cause === null || cause === undefined) return "unknown error";
      var message = cause instanceof Error ? cause.message : String(cause);
      return message === "" ? "unknown error" : message;
    }

    /** Call one bridge route and unwrap { ok, result } / { ok, error }. */
    function requestJson(url, method) {
      return fetch(url, {
        method: method || "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin"
      }).then(function (response) {
        return response
          .json()
          .catch(function () {
            return null;
          })
          .then(function (payload) {
            if (payload !== null && payload !== undefined && payload.ok === true) return payload.result;
            var detail =
              payload !== null && payload !== undefined && payload.error && payload.error.message
                ? payload.error.message
                : "HTTP " + String(response.status);
            throw new Error(detail);
          });
      });
    }

    var styles = {
      root: { display: "flex", flexDirection: "column", gap: "12px", fontSize: "13px", lineHeight: 1.6, minWidth: 0 },
      title: { fontSize: "15px", fontWeight: 600, margin: 0 },
      description: { margin: 0, color: "var(--dsw-alias-label-secondary, #8b90a0)" },
      card: {
        border: "1px solid var(--dsw-alias-line-regular, rgba(127, 127, 127, 0.22))",
        borderRadius: "10px",
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: "8px"
      },
      row: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px", minWidth: 0 },
      rowLabel: { color: "var(--dsw-alias-label-secondary, #8b90a0)", flex: "none" },
      rowValue: { fontVariantNumeric: "tabular-nums", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      status: { margin: 0, fontWeight: 500 },
      actions: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
      button: {
        appearance: "none",
        border: "1px solid var(--dsw-alias-line-regular, rgba(127, 127, 127, 0.28))",
        background: "transparent",
        color: "inherit",
        borderRadius: "8px",
        padding: "6px 14px",
        fontSize: "13px",
        cursor: "pointer"
      },
      primaryButton: {
        appearance: "none",
        border: "1px solid transparent",
        background: "var(--dsw-alias-brand-primary, #4c8dff)",
        color: "#fff",
        borderRadius: "8px",
        padding: "6px 14px",
        fontSize: "13px",
        cursor: "pointer"
      },
      link: { color: "var(--dsw-alias-link-normal, #4c8dff)", textDecoration: "none" },
      muted: { color: "var(--dsw-alias-label-secondary, #8b90a0)" }
    };

    /** One label/value line. */
    function detailRow(key, label, value) {
      return React.createElement(
        "div",
        { key: key, style: styles.row },
        React.createElement("span", { style: styles.rowLabel }, label),
        React.createElement("span", { style: styles.rowValue, title: value }, value)
      );
    }

    /** ReactNode: the settings section. Props = injected { t }. */
    function DesktopUpgradeSection(props) {
      var t = typeof props.t === "function" ? props.t : function (key) { return key; };
      var statePair = React.useState({ phase: "loading", result: null, error: "" });
      var state = statePair[0];
      var setState = statePair[1];
      var busyPair = React.useState(false);
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var feedbackPair = React.useState("");
      var feedback = feedbackPair[0];
      var setFeedback = feedbackPair[1];

      var refresh = React.useCallback(function () {
        setState({ phase: "loading", result: null, error: "" });
        setFeedback("");
        return requestJson(STATUS_URL)
          .then(function (result) {
            setState({ phase: "ready", result: result, error: "" });
          })
          .catch(function (cause) {
            setState({ phase: "error", result: null, error: formatError(cause) });
          });
      }, []);

      React.useEffect(function () {
        refresh();
      }, [refresh]);

      var upgrade = React.useCallback(function () {
        setBusy(true);
        setFeedback("");
        return requestJson(UPGRADE_URL, "POST")
          .then(function (result) {
            setFeedback(result && result.message ? result.message : t("upgradeStarted"));
          })
          .catch(function (cause) {
            setFeedback(formatError(cause));
          })
          .then(function () {
            setBusy(false);
            return refresh();
          });
      }, [refresh, t]);

      var result = state.result;
      var status = result === null ? "" : result.status;
      var latest = result !== null && result.latestVersion ? result.latestVersion : t("unknown");
      var current = result !== null && result.currentVersion ? result.currentVersion : t("unknown");
      var channel = result !== null && result.channel ? result.channel : "stable";
      var canDownload = result !== null && result.canDownload === true;

      var headline = t("checking");
      var headlineStyle = styles.muted;
      if (state.phase === "error") {
        headline = state.error;
        headlineStyle = { margin: 0, fontWeight: 500, color: "var(--dsw-alias-label-error, #d94f4f)" };
      } else if (state.phase === "ready") {
        if (status === "update-available") {
          headline = t("updateAvailable").replace("{latest}", String(latest));
          headlineStyle = { margin: 0, fontWeight: 500, color: "var(--dsw-alias-brand-primary, #4c8dff)" };
        } else if (status === "unavailable") {
          headline = result.message ? String(result.message) : t("upToDate");
          headlineStyle = styles.muted;
        } else {
          headline = t("upToDate");
        }
      }

      var manualUrl = result !== null && result.manualUrl ? String(result.manualUrl) : MANUAL_DOWNLOAD_URL;
      var children = [
        React.createElement("h3", { key: "title", style: styles.title }, t("title")),
        React.createElement("p", { key: "description", style: styles.description }, t("description")),
        React.createElement(
          "div",
          { key: "card", style: styles.card },
          detailRow("current", t("currentVersion"), String(current)),
          detailRow("latest", t("latestVersion"), String(latest)),
          detailRow("channel", t("channel"), String(channel)),
          React.createElement("p", { key: "status", style: headlineStyle }, headline)
        )
      ];

      var actions = [
        React.createElement(
          "button",
          {
            key: "check",
            type: "button",
            style: Object.assign({}, styles.button, state.phase === "loading" || busy ? { opacity: 0.6, cursor: "default" } : {}),
            disabled: state.phase === "loading" || busy,
            onClick: function () {
              if (state.phase === "loading" || busy) return;
              refresh();
            }
          },
          state.phase === "ready" ? t("recheck") : t("check")
        )
      ];
      if (status === "update-available") {
        if (canDownload) {
          actions.push(
            React.createElement(
              "button",
              {
                key: "upgrade",
                type: "button",
                style: Object.assign({}, styles.primaryButton, busy ? { opacity: 0.6, cursor: "default" } : {}),
                disabled: busy,
                onClick: function () {
                  if (busy) return;
                  upgrade();
                }
              },
              busy ? t("downloading") : t("downloadAndInstall")
            )
          );
        } else {
          actions.push(
            React.createElement("a", { key: "manual", href: manualUrl, target: "_blank", rel: "noreferrer", style: styles.link }, t("manualDownload"))
          );
        }
      }
      children.push(React.createElement("div", { key: "actions", style: styles.actions }, actions));
      if (feedback !== "") {
        children.push(React.createElement("p", { key: "feedback", style: styles.muted }, feedback));
      }

      return React.createElement("div", { style: styles.root }, children);
    }

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "dsh-desktop-upgrade: browser dictionaries");
      var t = ctx.locale.bind(NS);
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          {
            name: "settings.section",
            id: "desktop-upgrade",
            order: 101,
            label: function () {
              return t("nav");
            },
            locale: NS,
            inject: function () {
              return { t: t };
            }
          },
          DesktopUpgradeSection
        );
      });
    }

    module.exports = { inject: ["slots", "locale"], apply: apply };
    return module.exports;
  }
});
