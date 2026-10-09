# TypeScript extension compatibility-01 构建结果保留浏览器加载入口
# TypeScript extension compatibility-02 已存设置与请求参数兼容
# TypeScript extension compatibility-03 字幕显示与 VTT 导出兼容
# TypeScript extension compatibility-04 页面翻译开关仍默认关闭
# TypeScript extension compatibility-05 MAIN world 字幕兜底协议兼容
Feature: TypeScript extension compatibility
  Background:
    Given 已按锁文件安装依赖并从 TS 源码构建扩展
    And 扩展测试使用受控播放器、浏览器 API 和后端响应边界

  Scenario Outline: TypeScript extension compatibility-01 构建结果保留浏览器加载入口
    When 从不含生成 JS 的 checkout 运行 make build-extension
    Then "<browser>" 的现有加载入口 "<entry>" 包含完整可加载扩展
    And manifest 与 options.html 引用的全部 JS、HTML 和图标均存在
    And background、bridge、content、options 的执行入口为生成的 JavaScript
    And 脚本不残留 TS 语法、未解析的模块引用或 Node 专用 API
    And bridge 仍在 document_start 的 MAIN world 加载且 content 仍在 document_end 加载

    Examples:
      | browser      | entry                                    |
      | Chrome 121+  | minimal-extension/public/                |
      | Firefox 128+ | minimal-extension/public/manifest.json   |

  Scenario Outline: TypeScript extension compatibility-02 已存设置与请求参数兼容
    Given chrome.storage.local 的 ytsSettings 已含 positionY 为 18 且含旧翻译配置
    When 在生成的设置页中将后端地址设为 "<backend_input>"、翻译引擎设为 "<engine>" 并保存
    Then ytsSettings 的 backendUrl 为 "<backend_url>" 且 translateEngine 为 "<engine>"
    And positionY 仍为 18 且存储键未改名
    And 重载设置页仍显示保存值
    When 在生成的 content 脚本中开启当前视频翻译
    Then 请求发往 "<backend_url>" 的 /api/subtitle/stream
    And 请求中的 translate_engine 为 "<engine>" 且 translate_to、segmentation、模型配置与已存设置一致

    Examples:
      | backend_input             | backend_url           | engine |
      | http://localhost:8791///  | http://localhost:8791 | agent  |
      | http://localhost:8787/    | http://localhost:8787 | legacy |

  Scenario Outline: TypeScript extension compatibility-03 字幕显示与 VTT 导出兼容
    Given 当前视频已开启翻译且后端流包含 index 为 0 的原字幕 "<text>"、start 为 <start>、end 为 <end>
    When 真实 content 脚本依次接收 source_cue、译文为 "<translation>" 的 cue、同一 cue 的重复事件和成功 done
    Then 播放时间位于该字幕区间时只显示一条原文 "<text>" 和一条译文 "<translation>"
    When 通过生成的 background 脚本点击扩展图标发送 downloadVtt 消息
    Then content 脚本返回 ok 为 true 且 count 为 1
    And 下载文件为 WebVTT 且包含 "<vtt_time>"、原文 "<text>" 和译文 "<translation>"

    Examples:
      | start | end  | text    | translation | vtt_time                |
      | 1000  | 2500 | Hello   | 你好        | 00:01.000 --> 00:02.500 |
      | 5000  | 6750 | Goodbye | 再见        | 00:05.000 --> 00:06.750 |

  Scenario Outline: TypeScript extension compatibility-04 页面翻译开关仍默认关闭
    Given 存储中残留 enabled 为 true 的旧设置
    And 页面在事件前的状态为 "<previous_state>"
    When 生成的 content 脚本经历 "<page_event>"
    Then 当前视频的翻译开关为关闭且不自动请求后端字幕
    And 页面不显示上一视频的字幕且忽略上一请求迟到的事件
    And 用户手动开启后才发送当前视频的请求

    Examples:
      | previous_state   | page_event         |
      | 尚未加载脚本     | 首次加载视频页面   |
      | 已开启且有字幕   | yt-navigate-finish |

  Scenario Outline: TypeScript extension compatibility-05 MAIN world 字幕兜底协议兼容
    Given 后端轨道接口响应 400 且当前视频的播放器提供 "<payload>" 字幕
    When 生成的 bridge 和 content 脚本处理当前视频的字幕兜底
    Then yts-request-subtitles 与 yts-browser-subtitles 仍通过 JSON 字符串 detail 跨 world 通信
    And /api/subtitle/stream 请求包含 "<field>" 且字幕正文与播放器来源一致
    And 请求的 source_video_id、source_language 与当前视频字幕一致
    And json3 逐词偏移或源 cue 毫秒时间轴不被迁移改变
    And 请求不包含浏览器 Cookie

    Examples:
      | payload | field         |
      | json3   | source_events |
      | XML     | source_cues   |
