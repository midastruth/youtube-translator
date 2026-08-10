# YouTube Subtitle Translator — 极简扩展

只需后端 + 这个轻量扩展，YouTube 双语字幕即开即用。

```
minimal-extension/
├── public/
│   ├── manifest.json    # Chrome 扩展配置
│   ├── content.js       # 注入 YouTube 页面：调后端 → 渲染字幕
│   ├── options.html     # 设置页面：后端地址 / API key / 断句模式
│   ├── icon48.png
│   └── icon128.png
```

## 对比 kiss-translator

| | kiss-translator | 极简扩展 |
|---|---|---|
| 文件数 | 247 JS | 1 JS + 1 HTML |
| 代码量 | ~12000 行字幕模块 | ~180 行 |
| 功能 | 网页翻译/划词/弹窗/同步... | **只有 YouTube 字幕翻译** |
| 字幕源 | XHR 拦截 timedtext | 后端 API |
| 断句 | 3 种（浏览器跑） | 2 种（后端跑） |
| 翻译 | 20+ 服务 | 后端翻译 |
| 设置 | 复杂面板 | 一页搞定 |

## 安装

1. 打开 `chrome://extensions`
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择 `minimal-extension/public/`
4. 点击扩展图标 → 右键「选项」打开设置页

## 使用

1. 启动后端：`make start`（或 `docker compose up -d`）
2. 在设置页填入后端地址（默认 `http://localhost:8787`）
3. 可选：填入翻译 API key、选择断句模式
4. 打开 YouTube 视频 → 字幕自动双语显示
