import { YouTubeInitializer } from "./YouTubeCaptionProvider.js";
import { YouTubeBackendProvider } from "./backendProvider.js";
import { isMatch } from "../libs/utils.js";
import { DEFAULT_API_SETTING } from "../config/api.js";
import { DEFAULT_SUBTITLE_SETTING } from "../config/setting.js";
import { logger } from "../libs/log.js";
import { injectJs, INJECTOR } from "../injectors/index.js";

// 各视频平台对应的字幕初始化拦截器配置
// 目前仅配置了 YouTube 的匹配规则 (pattern) 及其对应的初始化引导器 (YouTubeInitializer)
const providers = [
  { pattern: "https://www.youtube.com", start: YouTubeInitializer },
];

// 后端代理实例（单例）
let backendProvider = null;

/**
 * 运行双语字幕翻译服务的主入口。
 * 该函数根据当前网页的 href URL，匹配已注册的视频服务提供商列表。
 * 如果用户配置了 backendUrl，则使用后端代理模式（由 youtube-ingest 服务做字幕获取+断句+翻译）。
 * 否则执行底层的 XHR 拦截脚本注入（用于劫持平台字幕数据请求，如 YouTube 的 timedtext 接口），
 * 接着获取用户的字幕/翻译配置，并初始化启动对应平台的字幕翻译渲染引擎。
 *
 * @param {object} params - 引导参数对象
 * @param {string} params.href - 当前浏览器网页的完整链接 (document.location.href)
 * @param {object} params.setting - 全局用户配置选项，包括 subtitleSetting 和 transApis
 */
export function runSubtitle({ href, setting }) {
  try {
    // 获取字幕配置，若无则使用默认字幕配置
    const subtitleSetting = setting.subtitleSetting || DEFAULT_SUBTITLE_SETTING;

    // 如果用户在设置中关闭了视频双语字幕翻译功能，则不执行任何后续操作，直接返回
    if (!subtitleSetting.enabled) {
      return;
    }

    // ── 后端代理模式 ──
    if (subtitleSetting.backendUrl) {
      runBackendMode({ href, setting, subtitleSetting });
      return;
    }

    // ── 原始前端模式 ──
    // 根据当前网页 URL (href) 查找是否有匹配的字幕服务提供商（例如匹配 YouTube 网址）
    const provider = providers.find((item) => isMatch(href, item.pattern));
    if (provider) {
      // 1. 注入底层的劫持脚本 (INJECTOR.subtitle)
      // 该操作会在原生页面环境中动态注入一段 JS 脚本，用以劫持底层的 XHR (XMLHttpRequest) 请求。
      // 这对于拦截 YouTube 的 timedtext 异步字幕请求并将其回传给当前扩展至关重要。
      const id = "kiss-translator-inject-subtitle-js";
      injectJs(INJECTOR.subtitle, id);

      // 2. 获取当前字幕翻译所关联的翻译 API 配置 (apiSetting)
      const transApis = setting.transApis || [];
      const apiSetting =
        transApis.find((api) => api.apiSlug === subtitleSetting.apiSlug) ||
        DEFAULT_API_SETTING;

      // 3. 启动特定平台的字幕翻译与渲染引擎 (如 YouTubeCaptionProvider)
      // 将整理好的字幕配置、翻译 API 配置、所有已启用的 API 列表以及 UI 界面语言传递给对应的 provider
      provider.start({
        ...subtitleSetting,
        apiSetting,
        transApis,
        prompts: setting.prompts,
        uiLang: setting.uiLang,
      });
    }
  } catch (err) {
    logger.error("start subtitle provider failed", err);
  }
}

/**
 * 后端代理模式：由 youtube-ingest 服务完成字幕获取、分句和翻译，
 * 浏览器扩展只负责渲染。
 */
function runBackendMode({ href, setting, subtitleSetting }) {
  if (!isMatch(href, "https://www.youtube.com")) return;

  const videoEl = document.querySelector("video");
  if (!videoEl) return;

  // 销毁旧实例（切换视频时重用）
  if (backendProvider) {
    backendProvider.destroy();
    backendProvider = null;
  }

  // 动态导入渲染模块（避免顶层循环依赖）
  Promise.all([
    import("./BilingualSubtitleManager.js"),
    import("./YouTubeSubtitleList.js"),
    import("./youtubePlayerUi.js"),
  ]).then(([mgr, list, ui]) => {
    backendProvider = new YouTubeBackendProvider({
      backendUrl: subtitleSetting.backendUrl,
      videoEl,
      setting: {
        autoTranslate: subtitleSetting.autoTranslate,
        segmentation: subtitleSetting.useAlgorithmBreaker || "rule",
        toLang: subtitleSetting.toLang || "zh-CN",
        languages: subtitleSetting.languages || ["en", "zh-Hans", "zh-Hant", "zh"],
        translateApiKey: subtitleSetting.translateApiKey || "",
        translateBaseUrl: subtitleSetting.translateBaseUrl || "",
        translateModel: subtitleSetting.translateModel || "",
        translateWhole: subtitleSetting.translateWhole || false,
        isBilingual: subtitleSetting.isBilingual,
        displayOrder: subtitleSetting.displayOrder,
        blurTranslation: subtitleSetting.blurTranslation,
        originStyle: subtitleSetting.originStyle,
        translationStyle: subtitleSetting.translationStyle,
        hoverLookupMode: subtitleSetting.hoverLookupMode,
        autoFavWord: subtitleSetting.autoFavWord,
        showList: subtitleSetting.showList,
      },
      // kiss-translator 渲染模块
      BilingualSubtitleManager: mgr.BilingualSubtitleManager,
      YouTubeSubtitleList: list.YouTubeSubtitleList,
      YouTubePlayerUi: ui.YouTubePlayerUi,
    });

    backendProvider.initialize();
  });

  // 监听 yt-navigate-finish 事件，切换视频时重新初始化
  window.addEventListener("yt-navigate-finish", () => {
    if (backendProvider) {
      backendProvider.destroy();
      backendProvider = null;
    }
    // 短暂延迟等待 DOM 更新
    setTimeout(() => {
      const newVideoEl = document.querySelector("video");
      if (!newVideoEl) return;

      Promise.all([
        import("./BilingualSubtitleManager.js"),
        import("./YouTubeSubtitleList.js"),
        import("./youtubePlayerUi.js"),
      ]).then(([mgr, list, ui]) => {
        backendProvider = new YouTubeBackendProvider({
          backendUrl: subtitleSetting.backendUrl,
          videoEl: newVideoEl,
          setting: {
            autoTranslate: subtitleSetting.autoTranslate,
            segmentation: subtitleSetting.useAlgorithmBreaker || "rule",
            toLang: subtitleSetting.toLang || "zh-CN",
            languages: subtitleSetting.languages || ["en", "zh-Hans", "zh-Hant", "zh"],
            translateApiKey: subtitleSetting.translateApiKey || "",
            translateBaseUrl: subtitleSetting.translateBaseUrl || "",
            translateModel: subtitleSetting.translateModel || "",
            translateWhole: subtitleSetting.translateWhole || false,
            isBilingual: subtitleSetting.isBilingual,
            displayOrder: subtitleSetting.displayOrder,
            blurTranslation: subtitleSetting.blurTranslation,
            originStyle: subtitleSetting.originStyle,
            translationStyle: subtitleSetting.translationStyle,
            hoverLookupMode: subtitleSetting.hoverLookupMode,
            autoFavWord: subtitleSetting.autoFavWord,
            showList: subtitleSetting.showList,
          },
          BilingualSubtitleManager: mgr.BilingualSubtitleManager,
          YouTubeSubtitleList: list.YouTubeSubtitleList,
          YouTubePlayerUi: ui.YouTubePlayerUi,
        });

        backendProvider.initialize();
      });
    }, 500);
  });
}
