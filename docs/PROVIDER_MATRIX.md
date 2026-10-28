# 上游与模型矩阵

## 1. 国内官方 API / Coding Plan

| 厂商 | new-api 渠道 | Base URL / 特殊值 | 说明 |
|---|---|---|---|
| DeepSeek | 43 DeepSeek | `https://api.deepseek.com` | 官方按 token 计费 |
| Moonshot / Kimi | 25 Moonshot | `https://api.moonshot.cn`；Coding Plan 可用 `kimi-coding-plan` | 官方 API 或 Kimi Coding Plan |
| 智谱 GLM | 26 ZhipuV4 | `https://open.bigmodel.cn`；Coding Plan 用 `glm-coding-plan` / `glm-coding-plan-international` | Anthropic + OpenAI 双端点 |
| 阿里通义 / 百炼 | 17 Ali | `https://dashscope.aliyuncs.com` | 也承载 Wan/Qwen-Image 插件 |
| 火山方舟 / 豆包 | 45 VolcEngine | `https://ark.cn-beijing.volces.com`；Coding Plan 用 `doubao-coding-plan` | 也承载 Seedream 插件 |
| MiniMax | 35 MiniMax | `https://api.minimax.chat` | 官方 API |
| 百度千帆 | 46 BaiduV2 | `https://qianfan.baidubce.com` | 官方 API |
| 腾讯混元 | 23 Tencent | `https://hunyuan.tencentcloudapi.com` | 官方 API |
| 硅基流动 | 40 SiliconFlow | `https://api.siliconflow.cn` | 聚合国内开源模型 |
| xAI / Grok | 48 xAI | `https://api.x.ai` | 官方 API；视频插件 |

## 2. 订阅 / 账号类旁路

| 旁路 | Kiro | Antigravity | 其他 | new-api 接入 | 许可 |
|---|---|---|---|---|---|
| AIClient2API | ✅ | ✅ | 账号族（容器内源码为证）：OpenAI/Codex（`auth/codex-oauth.js`）、Claude（`providers/claude/`）、**Kiro**（`providers/claude/claude-kiro.js`、`auth/kiro-oauth.js`）、Gemini（`providers/gemini/gemini-core.js`、`auth/gemini-oauth.js`）、**Antigravity**（`providers/gemini/antigravity-core.js`）、**GitHub Copilot**（`providers/github/github-copilot-core.js`）、Grok（`auth/grok-auth.js`、`grok-cli-oauth.js`）、iFlow（`auth/iflow-oauth.js`）、Qwen（`auth/qwen-oauth.js`），另含 Kimi/MiniMax | 类型 1 / 14 指到 `http://aiclient2api:3000`（PoC 里 `verify-compat` 实测过的两种形状；58/59 也可用），账号在旁路自己的控制台选 | GPL-3.0 |
| CLIProxyAPI | ❌ 核心不含 | ✅ | Codex、Claude Code、Gemini、Kimi、Grok | 类型 58/60，`http://<host>:8317` | MIT |
| Sub2API | ❌ 核心不含 | ✅ | Claude、OpenAI、Gemini、Grok、账号池、计费 | 类型 59，`http://<host>:8080`；Antigravity 可用 `/antigravity` | LGPL-3.0 |
| Kiro-Go | ✅ | ❌ | Kiro 单点 | 类型 1/14，`http://<host>:8080` | MIT |

### 推荐组合

- **单容器最简**：AIClient2API
- **MIT/Go 长期可控**：CLIProxyAPI
- **账号池/运营/计费**：Sub2API
- **未来原生 Kiro 渠道**：参考 Kiro-Go 的 MIT 代码

## 3. 生图 / 视频

### 3.1 内置 Task Plugin

| 插件 | 渠道类型 | 图片模型 | 视频/其他 | 协议 |
|---|---|---|---|---|
| Alibaba Bailian | 17 | Wan 2.7/2.6/2.5/2.2、Wanx 2.1/2.0、Wan 2.5 i2i、Wanx imageedit、Qwen-Image/Plus/Max/2.0/3.0、Z-Image | Wan 视频 | `openai_image` / `openai_video` |
| Doubao | 45/54 | Seedream 5.0 Pro/Flash/Lite、5.0、4.5、4.0 | Seedance 视频 | `openai_image` / `openai_video` |
| Google Veo (Gemini) | 24 | — | Veo 3.x | `openai_video` |
| Google Veo (Vertex) | 41 | — | Veo 3.x | `openai_video` |
| Jimeng | 51 | — | 即梦视频 | `openai_video` |
| Kling | 50 | — | 可灵视频 | `openai_video` |
| Vidu | 52 | — | Vidu 视频 | `openai_video` |
| Hailuo | 35 | — | 海螺视频 | `openai_video` |
| Sora | 55/1 | — | Sora 视频 | `openai_video` |
| SunoAPI | 36 | 仅歌曲封面 | 音乐/歌词 | — |
| xAI | 48 | — | Grok Imagine 视频 | `openai_video` |

### 3.2 通用图片接口

| 上游 | 渠道 | 端点 | 说明 |
|---|---|---|---|
| OpenAI / GPT-Image | 1 | `/v1/images/generations`、`/v1/images/edits` | 任意 OpenAI 兼容图片服务 |
| Google Imagen | 24 | 原生 `:generateContent` | 仅 `imagen*` 模型 |
| AIClient2API | 58/59 | `/v1/images/generations`、`/v1/images/edits` | 取决于其 provider |
| Sub2API | 59 | `/v1/images/generations` | GPT-Image / Gemini 图片等 |

### 3.3 关键注意

- **阿里图片必须用插件声明的模型名**：Ali adaptor 对未声明模型直接 400，且跳过重试（`relay/channel/ali/adaptor.go`）。
- **插件调用路径**：Qwen-Image 同步调用 `POST /api/v1/services/aigc/multimodal-generation/generation`，读 `output.choices[].message.content[].image`。
- **豆包 Seedream**：走 Ark 图片接口，模型名必须与插件声明一致。
- **视频/音乐插件不等于通用生图**：不要把 Kling/Jimeng/Vidu/Hailuo/Sora/xAI 当作图片生成能力。

## 4. 选择建议

| 需求 | 建议 |
|---|---|
| 国内文本模型为主 | new-api 原生渠道 + 官方 Key / Coding Plan |
| 低价订阅账号共享 | Sub2API 或 AIClient2API |
| Kiro + Antigravity 同时要 | AIClient2API |
| 想要 MIT/Go、可控性最高 | CLIProxyAPI |
| 阿里/豆包生图 | new-api 内置 Alibaba / Doubao 插件 |
| GPT-Image / Gemini 图片 | 类型 1 / 24，或 Sub2API/AIClient2API |
