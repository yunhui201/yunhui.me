# 默认模型官方来源核验

核验日期：2026-11-15。只以厂商当前官方 API 文档或其自己的公开模型接口作为默认 API ID 的证据；厂商展示名、另一家中转站的模型别名不能互相替代。

**本次结果：44 个供应商预设全部检查；20 家有公开证实的默认模型，共 51 条供应商模型项；云汇另有 8 条通过授权管理接口样本与原厂文档交叉核对的默认项；其余 23 家保留供应商配置入口，由账号或本地服务读取实际列表。** 云汇清单来源于用户授权的只读账号样本，不是对所有分组权限的保证。

公开目录证明模型 ID 已列出，不证明每个用户的账号有权限，也不代表已用用户密钥完成推理请求。预设更新仅影响新建供应商/云端可选目录，不覆盖用户已有配置、删除记录或自定义模型。

## API ID 与原文证据

### OpenAI（openai）

- `gpt-6.1-sol` — [官方来源](https://developers.openai.com/api/docs/models)。

> ar-Astra performance for complex work at a lower cost. Model ID gpt-6.1-sol Reasoning low medium high xhigh max Input price $2 / Input MTok Output price $10 / Output MTok Max output 128K tokens Context window 1.05M Knowledge cutoff Apr 30, 2026 Tools Functions, Web

- `gpt-6-astra` — [官方来源](https://developers.openai.com/api/docs/models)。

> ra Our most capable model for the most demanding work. Model ID gpt-6-astra Reasoning low medium high xhigh max Input price $10 / Input MTok Output price $50 / Output MTok Max output 128K tokens Context window 1.05M Knowledge cutoff Apr 30, 2026 Tools Functions, Web

- `gpt-6.1-terra` — [官方来源](https://developers.openai.com/api/docs/models)。

> ing, precise computer use, and clear, natural writing. Model ID gpt-6.1-terra Reasoning none low medium high xhigh max Input price $1 / Input MTok Output price $5 / Output MTok Max output 128K tokens Context window 1.05M Knowledge cutoff Jun 1, 2026 Tools Functions, W

- `gpt-6-luna` — [官方来源](https://developers.openai.com/api/docs/models)。

> r most efficient model for focused, high-volume tasks. Model ID gpt-6-luna Reasoning none low medium high xhigh max Input price $0.1 / Input MTok Output price $0.5 / Output MTok Max output 128K tokens Context window 1.05M Knowledge cutoff May 18, 2026 Tools Functio


### Anthropic Claude（anthropic）

- `claude-sonnet-5-5` — [官方来源](https://platform.claude.com/docs/en/models/overview.md)。

> \| Claude API ID \| `claude-fable-5-2` \| `claude-opus-5-5` \| `claude-sonnet-5-5` \| `claude-haiku-5-5` \|

- `claude-opus-5-5` — [官方来源](https://platform.claude.com/docs/en/models/overview.md)。

> \| Claude API ID \| `claude-fable-5-2` \| `claude-opus-5-5` \| `claude-sonnet-5-5` \| `claude-haiku-5-5` \|

- `claude-fable-5-2` — [官方来源](https://platform.claude.com/docs/en/models/overview.md)。

> \| Claude API ID \| `claude-fable-5-2` \| `claude-opus-5-5` \| `claude-sonnet-5-5` \| `claude-haiku-5-5` \|

- `claude-haiku-5-5` — [官方来源](https://platform.claude.com/docs/en/models/overview.md)。

> \| Claude API ID \| `claude-fable-5-2` \| `claude-opus-5-5` \| `claude-sonnet-5-5` \| `claude-haiku-5-5` \|


### Google Gemini（gemini）

- `gemini-4-hydrogen` — [官方来源](https://aistudio.google.com/docs/models)。

> %} {% section class="model-specs" %} * *Model code* **gemini-4-hydrogen** * *Context* **1M tokens** * *Max output* **64K / 1M tokens** * *Modalities* **Text, Image, Audio, Video, PDF** {% /section %} {% section class="card-actions" %} {% button href="https://aistudio.goo

- `gemini-4-carbon` — [官方来源](https://aistudio.google.com/docs/models)。

> %} {% section class="model-specs" %} * *Model code* **gemini-4-carbon** * *Context* **1M tokens** * *Max output* **64K / 1M tokens** * *Modalities* **Text, Image, Audio, Video, PDF** {% /section %} {% section class="card-actions" %} {% button href="https://aistudio.goo

- `gemini-4-argon` — [官方来源](https://aistudio.google.com/docs/models)。

> %} {% section class="model-specs" %} * *Model code* **gemini-4-argon** * *Context* **1M tokens** * *Max output* **64K / 1M tokens** * *Modalities* **Text, Image, Audio, Video, PDF** {% /section %} {% section class="card-actions" %} {% button href="https://aistudio.goo


### 深度求索（deepseek）

- `deepseek-flash` — [官方来源](https://api-docs.deepseek.com/quick_start/pricing/)。

> and output tokens by the model. Model Details ​ MODEL deepseek-flash (1) deepseek-v4-pro BASE URL (OpenAI Format) https://api.deepseek.com BASE URL (Anthropic Format) https://api.deepseek.com/anthropic MODEL VERSION DeepSeek-V4.1-Flash-1017 DeepSeek-V4-Pro-0813 THINKI

- `deepseek-v4-pro` — [官方来源](https://api-docs.deepseek.com/quick_start/pricing/)。

> by the model. Model Details ​ MODEL deepseek-flash (1) deepseek-v4-pro BASE URL (OpenAI Format) https://api.deepseek.com BASE URL (Anthropic Format) https://api.deepseek.com/anthropic MODEL VERSION DeepSeek-V4.1-Flash-1017 DeepSeek-V4-Pro-0813 THINKING MODE Supports bot


### 月之暗面（moonshot）

- `kimi-k3.1-pro` — [官方来源](https://platform.kimi.com/docs/get-api-key)。

> 1 Pro 开始；追求更高输出速度时可选择 Kimi K3.1 Pro 高速版。 Kimi K3.1 Pro kimi-k3.1-pro 是全新 K3.1 系列的首个旗舰模型——3 万亿级参数、1M token 上下文，代码、3D 创作、金融研究与建模能力显著提升。 Kimi K3.1 Pro 高速版 kimi-k3.1-pro-highspeed 是 Kimi K3.1 Pro 的高速版，能力相同、约为 2～3 倍速度，适合对输出速度要求更高的场景。 3 选择调用方式 Kimi API 兼容 OpenAI 与 Anthropic

- `kimi-k3.1-pro-highspeed` — [官方来源](https://platform.kimi.com/docs/get-api-key)。

> 1M token 上下文，代码、3D 创作、金融研究与建模能力显著提升。 Kimi K3.1 Pro 高速版 kimi-k3.1-pro-highspeed 是 Kimi K3.1 Pro 的高速版，能力相同、约为 2～3 倍速度，适合对输出速度要求更高的场景。 3 选择调用方式 Kimi API 兼容 OpenAI 与 Anthropic API 格式，你可以根据项目技术栈选择最合适的接入方式。 Chat Completions API OpenAI 兼容格式，支持 OpenAI SDK 与任意语言 HTTP 接入。 Responses API O


### 智谱 AI（zhipu）

- `glm-5.3` — [官方来源](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md)。

> 洞利用类基准测试中的得分达到 GLM-5.2 的两倍以上。 [技术报告](https://z.ai/blog/glm-5.3) ｜ [体验中心](https://bigmodel.cn/trialcenter/modeltrial/text?modelCode=glm-5.3) ## 功能变更 GLM-5.3 目前仅支持处理文本模态信息，支持 1M 上下文窗口，最大输出 Tokens 为 128K。\ GLM-5.3 会始终启用思考功能，支持三个思考强度级别：`low`、`high` 和 `max`，并不再支持禁用思考

- `glm-5.3-flash` — [官方来源](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash.md)。

> 200 tokens/s**，提供更快、更流畅的模型体验。 [技术报告](https://z.ai/blog/glm-5.3-flash)｜[体验中心](https://bigmodel.cn/trialcenter/modeltrial/visual) > [card] 输入模态 > > 视频、图像、文本、文件 > [card] 输出模态 > > 文本 > [card] 上下文窗口 > > 1M > [card] 最大输出 > > 128K ## 如何使用 #### **模型 API** **Model Code**：`glm-

- `glm-5.3-flashx` — [官方来源](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash.md)。

> # 如何使用 #### **模型 API** **Model Code**：`glm-5.3-flash`/`glm-5.3-flashx`/`glm-5.3-flashx-legal` \ **接口文档**：[Chat Completion API](https://docs.bigmodel.cn/api-reference/%e6%a8%a1%e5%9e%8b-api/%e5%af%b9%e8%af%9d%e8%a1%a5%e5%85%a8) \ **参数说明**：文本参数与 GLM-5.3 保持一致，支持 1M 上下文。\


### 通义千问 / 百炼（qwen）

- `qwen3.8-max` — [官方来源](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)。

> 时，会将其进行放大，直到总像素高于 min_pixels 。适用型号及取值见下方说明。 取值范围 输入图像： qwen3.8-max 、 qwen3.8-max-0902 、 qwen3.8-flash 、 qwen3.8-2.4t-a95b 、 qwen3.8-27b 、Qwen3.7、Qwen3.6、Qwen3.5、Qwen3-VL：默认值和最小值均为： 65536 qwen3.8-omni-flash 、Qwen3.5-Omni ：默认值和最小值均为： 24576 Qwen2.5-VL 开源系列及 QVQ 系列模型：默认

- `qwen3.8-flash` — [官方来源](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)。

> 号及取值见下方说明。 取值范围 输入图像： qwen3.8-max 、 qwen3.8-max-0902 、 qwen3.8-flash 、 qwen3.8-2.4t-a95b 、 qwen3.8-27b 、Qwen3.7、Qwen3.6、Qwen3.5、Qwen3-VL：默认值和最小值均为： 65536 qwen3.8-omni-flash 、Qwen3.5-Omni ：默认值和最小值均为： 24576 Qwen2.5-VL 开源系列及 QVQ 系列模型：默认值和最小值均为 3136 输入视频文件或图像列表： qwen3.8-m


### 稀宇科技（minimax）

- `MiniMax-M3.1-Flash` — [官方来源](https://platform.minimax.cn/docs/api-reference/text-openai-api.md)。

> AI() response = client.chat.completions.create( model="MiniMax-M3.1-Flash", reasoning_effort="max", messages=[ {"role": "system", "content": "You are a helpful assistant."}, {"role": "user", "content": "Hi, how are you?"}, ], ) print(f"Thinking:\n{response.choices[0].messa

- `MiniMax-M3` — [官方来源](https://platform.minimax.cn/docs/api-reference/text-openai-api.md)。

> AI() response = client.chat.completions.create( model="MiniMax-M3.1-Flash", reasoning_effort="max", messages=[ {"role": "system", "content": "You are a helpful assistant."}, {"role": "user", "content": "Hi, how are you?"}, ], ) print(f"Thinking:\n{response.choices[


### 火山方舟（volcengine）

- `doubao-seed-2-1-pro-260915` — [官方来源](https://docs.volcengine.com/docs/ark/model-list?lang=zh)。

> "insert":"doubao-seed-2-1-pro-260915"（官方模型列表的模型 ID 单元格）

- `doubao-seed-2-1-lite-260915` — [官方来源](https://docs.volcengine.com/docs/ark/model-list?lang=zh)。

> "insert":"doubao-seed-2-1-lite-260915"（官方模型列表的模型 ID 单元格）

- `deepseek-v4-1-flash-261017` — [官方来源](https://docs.volcengine.com/docs/ark/model-list?lang=zh)。

> "insert":"deepseek-v4-1-flash-261017"（官方模型列表的模型 ID 单元格）


### 阶跃星辰（stepfun）

- `step-5-preview` — [官方来源](https://platform.stepfun.com/docs/zh/guides/models/list)。

> 盖编程与专业知识工作，原生支持文本、图片与视频输入，可结合工具与文档持续推进多步骤任务。API 模型 ID： step-5-preview 。 知识工作 编程 Agent 图片与视频理解 开始使用 推理 / 多模态 Step 3.7 Flash 多模态推理旗舰 最大上下文 256K 阶跃星辰旗舰多模态推理模型。在 step-3.5-flash 的高速推理与工具调用能力基础上，新增 原生多模态输入能力 ，可直接理解图片和视频内容，无需借助视觉 MCP 或额外模型。支持三档推理强度（low/medium/high），是智能体、代码与多模


### xAI Grok（xai）

- `grok-4.7` — [官方来源](https://docs.x.ai/developers/models)。

> "name":"grok-4.7","version":"1.0","inputModalities":["TEXT","IMAGE"],"outputModalities":["TEXT"]


### Mistral AI（mistral）

- `mistral-large-4` — [官方来源](https://docs.mistral.ai/models/mistral-large-4-0)。

> and 1.05T total parameters, and a 1.6B vision encoder. mistral-large-4 +2 Speed Performance Modalities Context i 1M Price i USD EUR $0.7 Input /M Tokens $0.07 Cached input /M Tokens $2.1 Output /M Tokens Speed Performance Modalities Context 1M Price USD EUR $0.7 Input /


### Groq（groq）

- `openai/gpt-oss-120b` — [官方来源](https://console.groq.com/docs/models)。

> tact Sales Contact Sales 131,072 32,768 - GPT OSS 120B openai/gpt-oss-120b 500 $0.15 input $0.60 output 250K TPM 1K RPM 131,072 65,536 - GPT OSS 20B openai/gpt-oss-20b 1000 $0.075 input $0.30 output 250K TPM 1K RPM 131,072 65,536 - Whisper whisper-large-v3 - $0.111 per hour

- `openai/gpt-oss-20b` — [官方来源](https://console.groq.com/docs/models)。

> 60 output 250K TPM 1K RPM 131,072 65,536 - GPT OSS 20B openai/gpt-oss-20b 1000 $0.075 input $0.30 output 250K TPM 1K RPM 131,072 65,536 - Whisper whisper-large-v3 - $0.111 per hour 200K ASH 300 RPM - - 100 MB Whisper Large V3 Turbo whisper-large-v3-turbo - $0.04 per hour 4

- `qwen/qwen3.8-27b` — [官方来源](https://console.groq.com/docs/models)。

> tput 150K TPM 1K RPM 131,072 65,536 - Qwen/Qwen3.8-27B qwen/qwen3.8-27b 450 $0.80 input $4.00 output 250K TPM 1K RPM 131,072 16,384 20 MB Deprecated Models Deprecated models are models that are no longer supported or will no longer be supported in the future. See our dep


### Cerebras（cerebras）

- `gpt-oss-120b` — [官方来源](https://inference-docs.cerebras.ai/models/overview)。

> Context (free / paid) Speed (tokens/s) OpenAI GPT OSS gpt-oss-120b 120 billion 65k / 131k ~3000 Qwen 3.8 27B qwen-3.8-27b 27 billion 64k / 128k ~1850 Looking for more models? Many additional model families are available through Dedicated Inference . Model Compressio

- `qwen-3.8-27b` — [官方来源](https://inference-docs.cerebras.ai/models/overview)。

> gpt-oss-120b 120 billion 65k / 131k ~3000 Qwen 3.8 27B qwen-3.8-27b 27 billion 64k / 128k ~1850 Looking for more models? Many additional model families are available through Dedicated Inference . Model Compression This section provides transparency about the compress


### Cohere（cohere）

- `command-a-plus-05-2026` — [官方来源](https://docs.cohere.com/docs/models)。

> odality Context Length Maximum Output Tokens Endpoints command-a-plus-05-2026 Live Command A+ offers the last model in the Command A family, while being Cohere’s first Mixture of Experts model, simultaneously combining vision input support, agentic, reasoning, and world-class


### Fireworks AI（fireworks）

- `accounts/fireworks/models/deepseek-v4p1-flash-1017` — [官方来源](https://app.fireworks.ai/models/fireworks/deepseek-v4p1-flash-1017)。

> "name":"accounts/fireworks/models/deepseek-v4p1-flash-1017","displayName":"DeepSeek V4.1 Flash 1017"


### OpenRouter（openrouter）

- `openai/gpt-6.1-sol` — [官方来源](https://openrouter.ai/api/v1/models)。

> {"id": "openai/gpt-6.1-sol", "context_length": 1050000, "pricing": {"prompt": "0.000002", "completion": "0.00001", "web_search": "0.01", "input_cache_read": "0.0000001", "input_cache_write": "0.0000025", "overrides": [{"min_prompt_tokens": 272000, "prompt": "0.000004", "completion": "0.000015", "input_cache_read": "0.0000002", "input_cache_write": "0.000005"}]}}

- `anthropic/claude-sonnet-5.5` — [官方来源](https://openrouter.ai/api/v1/models)。

> {"id": "anthropic/claude-sonnet-5.5", "context_length": 1000000, "pricing": {"prompt": "0.000002", "completion": "0.00001", "web_search": "0.01", "input_cache_read": "0.0000001", "input_cache_write": "0.0000025", "input_cache_write_1h": "0.000004"}}

- `google/gemini-4-hydrogen` — [官方来源](https://openrouter.ai/api/v1/models)。

> {"id": "google/gemini-4-hydrogen", "context_length": 1048576, "pricing": {"prompt": "0.0000015", "completion": "0.0000075", "image": "0.0000015", "audio": "0.0000015", "input_audio_cache": "0.000000075", "web_search": "0.014", "internal_reasoning": "0.0000075", "input_cache_read": "0.000000075", "input_cache_write": "0.0000000833333333333333"}}

- `deepseek/deepseek-v4.1-flash-1017` — [官方来源](https://openrouter.ai/api/v1/models)。

> {"id": "deepseek/deepseek-v4.1-flash-1017", "context_length": 1048576, "pricing": {"prompt": "0.000000038", "completion": "0.0000005", "input_cache_read": "0.00000001"}}

- `moonshotai/kimi-k3.1-pro` — [官方来源](https://openrouter.ai/api/v1/models)。

> {"id": "moonshotai/kimi-k3.1-pro", "context_length": 1048576, "pricing": {"prompt": "0.000002", "completion": "0.00001", "input_cache_read": "0.0000002"}}

- `z-ai/glm-5.3` — [官方来源](https://openrouter.ai/api/v1/models)。

> {"id": "z-ai/glm-5.3", "context_length": 1048576, "pricing": {"prompt": "0.000000084", "completion": "0.0000036", "input_cache_read": "0.000000079"}}

- `minimax/minimax-m3.1-flash` — [官方来源](https://openrouter.ai/api/v1/models)。

> {"id": "minimax/minimax-m3.1-flash", "context_length": 1048576, "pricing": {"prompt": "0.000000075", "completion": "0.0000003", "input_cache_read": "0.0000000075", "overrides": [{"utc_start": 1500, "utc_end": 100, "prompt": "0.000000075", "completion": "0.0000003", "input_cache_read": "0.0000000075"}, {"utc_start": 100, "utc_end": 1500, "prompt": "0.00000015", "completion": "0.0000006", "input_cache_read": "0.000000015"}]}}


### DeepInfra（deepinfra）

- `moonshotai/Kimi-K3.1-Pro` — [官方来源](https://api.deepinfra.com/models/featured)。

> {"model_name": "moonshotai/Kimi-K3.1-Pro", "max_tokens": 1048576, "tags": ["openai", "cc-native", "json", "tools", "structured-output", "multimodal", "reasoning", "no-free-anon", "can-disable-reasoning", "priority", "flex", "featured"]}

- `deepseek-ai/DeepSeek-V4.1-Flash-1017` — [官方来源](https://api.deepinfra.com/models/featured)。

> {"model_name": "deepseek-ai/DeepSeek-V4.1-Flash-1017", "max_tokens": 1048576, "tags": ["multimodal", "reasoning", "priority", "openai", "can-disable-reasoning", "cc-native", "disable-penalty", "structured-output", "json", "flex", "tools", "featured"]}

- `zai-org/GLM-5.3` — [官方来源](https://api.deepinfra.com/models/featured)。

> {"model_name": "zai-org/GLM-5.3", "max_tokens": 1048576, "tags": ["openai", "cc-native", "tools", "json", "structured-output", "reasoning", "flex", "featured"]}


### 英伟达 NIM（nvidia）

- `deepseek-ai/deepseek-v4.1-flash` — [官方来源](https://integrate.api.nvidia.com/v1/models)。

> {"id": "deepseek-ai/deepseek-v4.1-flash", "object": "model", "created": 735790403, "owned_by": "deepseek-ai"}

- `stepfun-ai/step-5-preview` — [官方来源](https://integrate.api.nvidia.com/v1/models)。

> {"id": "stepfun-ai/step-5-preview", "object": "model", "created": 735790403, "owned_by": "stepfun-ai"}

- `z-ai/glm-5.3-flash` — [官方来源](https://integrate.api.nvidia.com/v1/models)。

> {"id": "z-ai/glm-5.3-flash", "object": "model", "created": 735790403, "owned_by": "z-ai"}


### Together AI（together）

- `deepseek-ai/DeepSeek-V4.1-Flash-1017` — [官方来源](https://docs.together.ai/docs/serverless/models)。

> DeepSeek \| DeepSeek V4.1 Flash 1017 \| deepseek-ai/DeepSeek-V4.1-Flash-1017 \| 1000000 \| $0.30 \| $0.006 \| $1.20 \| FP8 \| Yes \| Yes

- `MiniMaxAI/MiniMax-M3.1-Flash` — [官方来源](https://docs.together.ai/docs/serverless/models)。

> MiniMax \| MiniMax M3.1 Flash \| MiniMaxAI/MiniMax-M3.1-Flash \| 1048576 \| $0.15 \| $0.015 \| $0.60 \| NVFP4 \| Yes \| Yes

- `zai-org/GLM-5.3` — [官方来源](https://docs.together.ai/docs/serverless/models)。

> Z.ai \| GLM-5.3 \| zai-org/GLM-5.3 \| 1048575 \| $1.40 \| $0.26 \| $4.40 \| FP4 \| Yes \| Yes


### 云汇AI 官方中转（yunhui）

用户授权管理接口只读查询前 100 个账号，去重得到 50 个模型 ID；仅选择与原厂当前 API 文档交叉验证的 8 个通用会话模型。图像模型、auto-review 和旧别名未作为默认会话模型。每个会员分组的实际可用模型，仍以其自己的 API Key 调用 `/v1/models` 结果为准。

- `gpt-6.1-sol` — [云汇服务](https://api.yunhui.me)；[原厂 API ID 证明](https://developers.openai.com/api/docs/models)。样本原文 `"gpt-6.1-sol"`。
- `gpt-6-astra` — [云汇服务](https://api.yunhui.me)；[原厂 API ID 证明](https://developers.openai.com/api/docs/models)。样本原文 `"gpt-6-astra"`。
- `gpt-6-luna` — [云汇服务](https://api.yunhui.me)；[原厂 API ID 证明](https://developers.openai.com/api/docs/models)。样本原文 `"gpt-6-luna"`。
- `claude-sonnet-5-5` — [云汇服务](https://api.yunhui.me)；[原厂 API ID 证明](https://platform.claude.com/docs/en/models/overview.md)。样本原文 `"claude-sonnet-5-5"`。
- `claude-opus-5-5` — [云汇服务](https://api.yunhui.me)；[原厂 API ID 证明](https://platform.claude.com/docs/en/models/overview.md)。样本原文 `"claude-opus-5-5"`。
- `claude-haiku-5-5` — [云汇服务](https://api.yunhui.me)；[原厂 API ID 证明](https://platform.claude.com/docs/en/models/overview.md)。样本原文 `"claude-haiku-5-5"`。
- `claude-fable-5-2` — [云汇服务](https://api.yunhui.me)；[原厂 API ID 证明](https://platform.claude.com/docs/en/models/overview.md)。样本原文 `"claude-fable-5-2"`。
- `deepseek-flash` — [云汇服务](https://api.yunhui.me)；[原厂 API ID 证明](https://api-docs.deepseek.com/quick_start/pricing/)。样本原文 `"deepseek-flash"`。

云汇路由价格与上下文配额未由该样本证实，因此没有复制原厂目录价冒充云汇实收价。账号、API Key、管理密钥均未写入证据文档或仓库。

## 重要字段与协议核验

- OpenAI 官方页列出 GPT-6.1 Sol 的 `1,050,000 context window`、`128,000 max output tokens`；工具调用要求 Responses API，OpenAI 预设已使用该协议。参考 [具体模型页](https://developers.openai.com/api/docs/models/gpt-6.1-sol)。
- Claude 最新模型页明确：4.6 之后的模型不接受旧的 enabled + budget_tokens 手工 extended thinking 写法；应使用 adaptive thinking。Haiku 定价标注 From，未将起价硬写成所有请求的固定单价。
- DeepSeek 官方 pricing 页明确 `deepseek-flash` 对应 DeepSeek-V4.1-Flash-1017；旧 v4-flash 名称继续接受但背后模型已退休。预设使用新的推荐 ID。数值采用缓存未命中高峰美元价，非高峰半价与缓存价在备注中说明。
- Gemini 4 默认同步输出为 65,536；通过 long decode 可增加输出，不能把长输出专用上限假定成所有请求默认值。[Hydrogen 规格](https://aistudio.google.com/docs/models/gemini-4-hydrogen)。
- GLM-5.3 只支持文本且始终思考；GLM-5.3-Flash/FlashX 支持图片与视频。没有沿用旧 GLM-4-Flash 免费标签。
- MiniMax 当前国内 OpenAI 地址为 `https://api.minimax.cn/v1`。其国内报价为人民币且部分有上下文/服务档位差异，不未经汇率核验转换为美元。
- Qwen API 文档中可核对 `qwen3.8-max` / `qwen3.8-flash`；官网首页另列 Qwen4-max-preview 为 Token Plan。未把 Token Plan 模型直接放到通用按量地址的默认列表。
- Together 表格列顺序为 Input、Cached input、Output；预设分别保留 inputPrice、cacheReadPrice、outputPrice，不能把缓存价误当输出价。
- OpenRouter 与 NVIDIA 用自己的公开 `/models` ID；DeepInfra 用自己的 `model_name`。这些 ID 与原厂字符串不同，逐条保留原值。
- 没有证实的 contextWindow、maxOutput 或价格字段留空；留空不表示 128K 或免费。Cerebras 的免费/付费上下文不同，没有硬编码一个账号通用上限。

## 使用实际账号或本地目录的预设

| 预设 | 处理理由 |
|---|---|
| ChatGPT Plus / Pro (`chatgpt-subscription`) | 使用对应官方客户端的真实登录状态；模型访问权限由订阅账号与客户端决定。 |
| Claude 官方订阅 (`claude-subscription`) | 使用对应官方客户端的真实登录状态；模型访问权限由订阅账号与客户端决定。 |
| GitHub 模型 (`github-models`) | 该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。 |
| GitHub Copilot 订阅 (`copilot-subscription`) | 使用对应官方客户端的真实登录状态；模型访问权限由订阅账号与客户端决定。 |
| 硅基流动 (`siliconflow`) | 该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。 |
| 百度千帆 (`baidu-qianfan`) | 该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。 |
| 腾讯混元 (`hunyuan`) | 该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。 |
| 魔搭社区 (`modelscope`) | 该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。 |
| PPIO 派欧云 (`ppio`) | 该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。 |
| 商汤日日新 (`sensenova`) | 该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。 |
| 讯飞星火 (`iflytek`) | 该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。 |
| 零一万物 (`lingyi`) | 该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。 |
| 百川智能 (`baichuan`) | 该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。 |
| 华为云 ModelArts (`huawei-maas`) | 该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。 |
| 无问芯穹 (`infini`) | 该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。 |
| Perplexity (`perplexity`) | 该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。 |
| 微软 Azure (`azure-openai`) | 填写 Azure 资源地址及部署名称；请求的 model 必须匹配自己的部署，不是通用厂商展示名。 |
| Ollama 本地 (`ollama`) | 读取本机服务当前已安装或已加载模型；不同机器的模型 ID 和上下文配置不同。 |
| LM Studio 本地 (`lmstudio`) | 读取本机服务当前已安装或已加载模型；不同机器的模型 ID 和上下文配置不同。 |
| vLLM 自建 (`vllm`) | 读取本机服务当前已安装或已加载模型；不同机器的模型 ID 和上下文配置不同。 |
| 中转站（OpenAI 兼容） (`relay-openai`) | 填写中转服务地址和密钥后读取实际可用模型；不预置未经该站验证的模型 ID。 |
| 中转站（Claude 兼容） (`relay-anthropic`) | 填写中转服务地址和密钥后读取实际可用模型；不预置未经该站验证的模型 ID。 |
| 中转站（Gemini 兼容） (`relay-gemini`) | 填写中转服务地址和密钥后读取实际可用模型；不预置未经该站验证的模型 ID。 |

部分官方页面需登录、由脚本加载模型表，或当前公开文档只描述旧版接口。本轮没有借第三方搜索摘要替代这些服务的最新 API ID。对应旧的固定模型、示例 your-model/local-model，以及未经实际站点核验的中转模型均从新建预设中移除。

## 可复现数据生成

`scripts/make-catalog.mjs` 现在通过 esbuild 实际导入 TypeScript 预设模块，保留完整模型对象、可选价格、缓存价格、上下文、能力和空列表；不再使用正则粗解析构造假的默认值。

运行：`node scripts/make-catalog.mjs --out server/seed-catalog.json`。逐项证据与原始响应 SHA-256 在 [MODEL-SOURCES.json](MODEL-SOURCES.json)。原始下载页仅存本地 `.reference/model-docs/`，不包含用户 API Key。
