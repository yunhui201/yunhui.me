import type { ProtocolName } from '../types.js';
import type { ProviderModel } from '../store/types.js';

export interface ProviderPreset {
  id: string;
  name: string;
  /** 中文名 */
  nameZh: string;
  vendor: string;
  region: 'cn' | 'global' | 'local' | 'relay' | 'subscription';
  format: ProtocolName;
  baseUrl: string;
  color: string;
  icon: string;
  docs?: string;
  /** 是否需要用户自己填 baseUrl */
  customBaseUrl?: boolean;
  official?: boolean;
  note?: string;
  models: ProviderModel[];
}

/**
 * 2026-11-15 官方目录核对；每个默认 API ID 的来源见 docs/MODEL-SOURCES.md。
 * 仅给公开证实的模型填入 ID 与元数据，无法核实的账号/本地目录保持空列表。
 * 缺省价格表示待确认，不能当作免费；预设不会覆盖用户已有供应商及删改的模型。
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'yunhui',
    name: 'YunHui',
    nameZh: '云汇AI 官方中转',
    vendor: '云汇AI',
    region: 'relay',
    format: 'openai-responses',
    baseUrl: 'https://api.yunhui.me',
    color: '#6d8cff',
    icon: '🌉',
    docs: 'https://api.yunhui.me',
    note: "云汇AI 官方中转 · 登录后查看会员活动与账号实际可用模型。",
    models: [
      {
        "id": "gpt-6.1-sol"
      },
      {
        "id": "gpt-6-astra"
      },
      {
        "id": "gpt-6-luna"
      },
      {
        "id": "claude-sonnet-5-5"
      },
      {
        "id": "claude-opus-5-5"
      },
      {
        "id": "claude-haiku-5-5"
      },
      {
        "id": "claude-fable-5-2"
      },
      {
        "id": "deepseek-flash"
      }
    ],
  },
  /* ------------------------------ 国内 ------------------------------ */
  {
    id: 'deepseek',
    name: 'DeepSeek',
    nameZh: '深度求索',
    vendor: '深度求索',
    region: 'cn',
    format: 'openai-chat',
    baseUrl: 'https://api.deepseek.com',
    color: '#4d6bfe',
    icon: '🐳',
    docs: 'https://platform.deepseek.com',
    note: "deepseek-flash 对应 V4.1-Flash-1017，默认支持思考。显示缓存未命中高峰价，非高峰另有优惠。",
    models: [
      {
        "id": "deepseek-flash",
        "contextWindow": 1000000,
        "inputPrice": 0.3,
        "outputPrice": 1.2,
        "maxOutput": 384000,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      },
      {
        "id": "deepseek-v4-pro",
        "contextWindow": 1000000,
        "inputPrice": 1.32,
        "outputPrice": 3.96,
        "maxOutput": 384000,
        "capabilities": {
          "tools": true,
          "vision": false,
          "thinking": true
        }
      }
    ],
  },
  {
    id: 'moonshot',
    name: 'Kimi',
    nameZh: '月之暗面',
    vendor: '月之暗面',
    region: 'cn',
    format: 'openai-chat',
    baseUrl: 'https://api.moonshot.cn/v1',
    color: '#0f172a',
    icon: '🌙',
    docs: "https://platform.kimi.com/docs/get-api-key",
    note: "官方当前推荐 Kimi K3.1 Pro；高速版能力相同、输出速度更高；国内定价以人民币账单为准。",
    models: [
      {
        "id": "kimi-k3.1-pro",
        "contextWindow": 1000000,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      },
      {
        "id": "kimi-k3.1-pro-highspeed",
        "contextWindow": 1000000,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      }
    ],
  },
  {
    id: 'zhipu',
    name: 'GLM',
    nameZh: '智谱 AI',
    vendor: '智谱',
    region: 'cn',
    format: 'openai-chat',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    color: '#2f6bff',
    icon: '🔷',
    docs: 'https://open.bigmodel.cn',
    note: "GLM-5.3 为文本模型且始终启用思考；Flash/FlashX 支持图像与视频，不能按旧 GLM-4-Flash 的免费价格估算。",
    models: [
      {
        "id": "glm-5.3",
        "contextWindow": 1000000,
        "maxOutput": 128000,
        "capabilities": {
          "tools": true,
          "vision": false,
          "thinking": true
        }
      },
      {
        "id": "glm-5.3-flash",
        "contextWindow": 1000000,
        "maxOutput": 128000,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      },
      {
        "id": "glm-5.3-flashx",
        "contextWindow": 1000000,
        "maxOutput": 128000,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      }
    ],
  },
  {
    id: 'qwen',
    name: 'Qwen',
    nameZh: '通义千问 / 百炼',
    vendor: '阿里云',
    region: 'cn',
    format: 'openai-chat',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    color: '#615ced',
    icon: '☁️',
    docs: 'https://bailian.console.aliyun.com',
    note: "按官方 API 文档核对 Qwen 3.8 模型 ID；不同区域、输入长度与思考模式有不同定价。Qwen4-max-preview 属于 Token Plan，需对应开通与地址。",
    models: [
      {
        "id": "qwen3.8-max",
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      },
      {
        "id": "qwen3.8-flash",
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      }
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    nameZh: '稀宇科技',
    vendor: 'MiniMax',
    region: 'cn',
    format: 'openai-chat',
    baseUrl: "https://api.minimax.cn/v1",
    color: '#ff5c35',
    icon: '🔺',
    docs: "https://platform.minimax.cn/docs/api-reference/text-openai-api",
    note: "已更新官方国内 OpenAI 兼容地址；M3 系列原生多模态，价格按人民币与上下文档位计费。",
    models: [
      {
        "id": "MiniMax-M3.1-Flash",
        "contextWindow": 1000000,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      },
      {
        "id": "MiniMax-M3",
        "contextWindow": 1000000,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      }
    ],
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    nameZh: '硅基流动',
    vendor: 'SiliconFlow',
    region: 'cn',
    format: 'openai-chat',
    baseUrl: 'https://api.siliconflow.cn/v1',
    color: '#7c3aed',
    icon: '🧪',
    docs: 'https://siliconflow.cn',
    note: "该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。",
    models: [],
  },
  {
    id: 'volcengine',
    name: 'Volcengine Ark',
    nameZh: '火山方舟',
    vendor: '字节跳动',
    region: 'cn',
    format: 'openai-chat',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    color: '#1664ff',
    icon: '🌋',
    docs: "https://docs.volcengine.com/docs/ark/model-list?lang=zh",
    note: "使用官方模型目录中的精确模型 ID；须先开通，也可填写自己的推理接入点 ID。",
    models: [
      {
        "id": "doubao-seed-2-1-pro-260915"
      },
      {
        "id": "doubao-seed-2-1-lite-260915"
      },
      {
        "id": "deepseek-v4-1-flash-261017"
      }
    ],
  },
  {
    id: 'stepfun',
    name: 'StepFun',
    nameZh: '阶跃星辰',
    vendor: '阶跃星辰',
    region: 'cn',
    format: 'openai-chat',
    baseUrl: 'https://api.stepfun.com/v1',
    color: '#00a3ff',
    icon: '🪜',
    docs: "https://platform.stepfun.com/docs/zh/guides/models/list",
    note: "官方明确的 Step 5 Preview API ID；预览模型可用范围与价格以账号控制台为准。",
    models: [
      {
        "id": "step-5-preview",
        "contextWindow": 1000000,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      }
    ],
  },
  {
    id: 'baidu-qianfan',
    name: 'Qianfan',
    nameZh: '百度千帆',
    vendor: '百度',
    region: 'cn',
    format: 'openai-chat',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    color: '#2932e1',
    icon: '🐾',
    docs: 'https://qianfan.cloud.baidu.com',
    note: "该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。",
    models: [],
  },
  {
    id: 'hunyuan',
    name: 'Hunyuan',
    nameZh: '腾讯混元',
    vendor: '腾讯云',
    region: 'cn',
    format: 'openai-chat',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    color: '#00a4ff',
    icon: '🐧',
    docs: 'https://cloud.tencent.com/product/hunyuan',
    note: "该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。",
    models: [],
  },
  {
    id: 'modelscope',
    name: 'ModelScope',
    nameZh: '魔搭社区',
    vendor: '阿里云',
    region: 'cn',
    format: 'openai-chat',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    color: '#8b5cf6',
    icon: '🏔️',
    note: "该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。",
    models: [],
  },
  {
    id: 'ppio',
    name: 'PPIO',
    nameZh: 'PPIO 派欧云',
    vendor: 'PPIO',
    region: 'cn',
    format: 'openai-chat',
    baseUrl: 'https://api.ppio.com/openai',
    color: '#f97316',
    icon: '⚡',
    note: "该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。",
    models: [],
  },
  {
    id: 'sensenova',
    name: 'SenseNova',
    nameZh: '商汤日日新',
    vendor: '商汤',
    region: 'cn',
    format: 'openai-chat',
    baseUrl: 'https://api.sensenova.cn/compatible-mode/v1',
    color: '#e11d48',
    icon: '🎋',
    note: "该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。",
    models: [],
  },
  {
    id: 'iflytek',
    name: 'Spark',
    nameZh: '讯飞星火',
    vendor: '科大讯飞',
    region: 'cn',
    format: 'openai-chat',
    baseUrl: 'https://spark-api-open.xf-yun.com/v1',
    color: '#0ea5e9',
    icon: '✦',
    note: "该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。",
    models: [],
  },
  {
    id: 'lingyi',
    name: 'Yi',
    nameZh: '零一万物',
    vendor: '零一万物',
    region: 'cn',
    format: 'openai-chat',
    baseUrl: 'https://api.lingyiwanwu.com/v1',
    color: '#22c55e',
    icon: '🌱',
    note: "该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。",
    models: [],
  },
  {
    id: 'baichuan',
    name: 'Baichuan',
    nameZh: '百川智能',
    vendor: '百川',
    region: 'cn',
    format: 'openai-chat',
    baseUrl: 'https://api.baichuan-ai.com/v1',
    color: '#f59e0b',
    icon: '🌊',
    note: "该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。",
    models: [],
  },
  {
    id: 'huawei-maas',
    name: 'Huawei MaaS',
    nameZh: '华为云 ModelArts',
    vendor: '华为云',
    region: 'cn',
    format: 'openai-chat',
    baseUrl: 'https://api.modelarts-maas.com/v1',
    color: '#cf0a2c',
    icon: '🌸',
    note: "该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。",
    models: [],
  },
  {
    id: 'infini',
    name: 'Infini',
    nameZh: '无问芯穹',
    vendor: '无问芯穹',
    region: 'cn',
    format: 'openai-chat',
    baseUrl: 'https://cloud.infini-ai.com/maas/v1',
    color: '#06b6d4',
    icon: '∞',
    note: "该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。",
    models: [],
  },

  /* ------------------------------ 国外 ------------------------------ */
  {
    id: 'openai',
    name: 'OpenAI',
    nameZh: 'OpenAI',
    vendor: 'OpenAI',
    region: 'global',
    format: "openai-responses",
    baseUrl: 'https://api.openai.com/v1',
    color: '#10a37f',
    icon: '◍',
    docs: 'https://platform.openai.com',
    note: "已核对官方 GPT-6 模型；工具调用使用 Responses API。目录价格为标准输入/输出，不含缓存与工具费用。",
    models: [
      {
        "id": "gpt-6.1-sol",
        "contextWindow": 1050000,
        "inputPrice": 2,
        "outputPrice": 10,
        "maxOutput": 128000,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      },
      {
        "id": "gpt-6-astra",
        "contextWindow": 1050000,
        "inputPrice": 10,
        "outputPrice": 50,
        "maxOutput": 128000,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      },
      {
        "id": "gpt-6.1-terra",
        "contextWindow": 1050000,
        "inputPrice": 1,
        "outputPrice": 5,
        "maxOutput": 128000,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      },
      {
        "id": "gpt-6-luna",
        "contextWindow": 1050000,
        "inputPrice": 0.1,
        "outputPrice": 0.5,
        "maxOutput": 128000,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      }
    ],
  },
  {
    id: 'anthropic',
    name: 'Claude',
    nameZh: 'Anthropic Claude',
    vendor: 'Anthropic',
    region: 'global',
    format: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    color: '#d97757',
    icon: '✳',
    docs: 'https://console.anthropic.com',
    note: "官方当前模型，使用 adaptive thinking；Haiku 为分档起价，按实际账单计费。",
    models: [
      {
        "id": "claude-sonnet-5-5",
        "contextWindow": 1000000,
        "inputPrice": 2,
        "outputPrice": 10,
        "maxOutput": 128000,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      },
      {
        "id": "claude-opus-5-5",
        "contextWindow": 1000000,
        "inputPrice": 4,
        "outputPrice": 20,
        "maxOutput": 128000,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      },
      {
        "id": "claude-fable-5-2",
        "contextWindow": 1000000,
        "inputPrice": 8,
        "outputPrice": 40,
        "maxOutput": 128000,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      },
      {
        "id": "claude-haiku-5-5",
        "contextWindow": 1000000,
        "maxOutput": 128000,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      }
    ],
  },
  {
    id: 'gemini',
    name: 'Gemini',
    nameZh: 'Google Gemini',
    vendor: 'Google',
    region: 'global',
    format: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    color: '#4285f4',
    icon: '✦',
    docs: 'https://aistudio.google.com',
    note: "官方 Gemini 4 系列；长输出模式、地区和账号访问范围以官方控制台为准。",
    models: [
      {
        "id": "gemini-4-hydrogen",
        "contextWindow": 1048576,
        "maxOutput": 65536,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      },
      {
        "id": "gemini-4-carbon",
        "contextWindow": 1048576,
        "maxOutput": 65536,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      },
      {
        "id": "gemini-4-argon",
        "contextWindow": 1048576,
        "maxOutput": 65536,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      }
    ],
  },
  {
    id: 'xai',
    name: 'Grok',
    nameZh: 'xAI Grok',
    vendor: 'xAI',
    region: 'global',
    format: 'openai-chat',
    baseUrl: 'https://api.x.ai/v1',
    color: '#111827',
    icon: '𝕏',
    docs: "https://docs.x.ai/developers/models",
    note: "官方模型服务清单中核对 Grok 4.7，访问权限与地区以账号为准。",
    models: [
      {
        "id": "grok-4.7",
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      }
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    nameZh: 'Mistral AI',
    vendor: 'Mistral',
    region: 'global',
    format: 'openai-chat',
    baseUrl: 'https://api.mistral.ai/v1',
    color: '#ff7000',
    icon: '🌬️',
    docs: "https://docs.mistral.ai/models/mistral-large-4-0",
    models: [
      {
        "id": "mistral-large-4",
        "contextWindow": 1000000,
        "inputPrice": 0.7,
        "outputPrice": 2.1,
        "capabilities": {
          "tools": true,
          "vision": true
        }
      }
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    nameZh: 'Groq',
    vendor: 'Groq',
    region: 'global',
    format: 'openai-chat',
    baseUrl: 'https://api.groq.com/openai/v1',
    color: '#f55036',
    icon: '⚙️',
    note: "官方 Production / Preview 模型列表；Qwen 3.8 27B 属于 Preview，可用性与限额随账号变化。",
    models: [
      {
        "id": "openai/gpt-oss-120b",
        "contextWindow": 131072,
        "inputPrice": 0.15,
        "outputPrice": 0.6,
        "maxOutput": 65536,
        "capabilities": {
          "tools": true,
          "vision": false,
          "thinking": true
        }
      },
      {
        "id": "openai/gpt-oss-20b",
        "contextWindow": 131072,
        "inputPrice": 0.075,
        "outputPrice": 0.3,
        "maxOutput": 65536,
        "capabilities": {
          "tools": true,
          "vision": false,
          "thinking": true
        }
      },
      {
        "id": "qwen/qwen3.8-27b",
        "contextWindow": 131072,
        "inputPrice": 0.8,
        "outputPrice": 4.0,
        "maxOutput": 16384,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      }
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    nameZh: 'OpenRouter',
    vendor: 'OpenRouter',
    region: 'relay',
    format: 'openai-chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    color: '#6366f1',
    icon: '🔀',
    note: "模型 ID、上下文和价格来自 OpenRouter 官方公开 models API；具体路由商与账号权限可能不同。",
    models: [
      {
        "id": "openai/gpt-6.1-sol",
        "contextWindow": 1050000,
        "maxOutput": 128000,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        },
        "inputPrice": 2.0,
        "outputPrice": 10.0
      },
      {
        "id": "anthropic/claude-sonnet-5.5",
        "contextWindow": 1000000,
        "maxOutput": 128000,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        },
        "inputPrice": 2.0,
        "outputPrice": 10.0
      },
      {
        "id": "google/gemini-4-hydrogen",
        "contextWindow": 1048576,
        "maxOutput": 943718,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        },
        "inputPrice": 1.5,
        "outputPrice": 7.5
      },
      {
        "id": "deepseek/deepseek-v4.1-flash-1017",
        "contextWindow": 1048576,
        "maxOutput": 943718,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        },
        "inputPrice": 0.038,
        "outputPrice": 0.5
      },
      {
        "id": "moonshotai/kimi-k3.1-pro",
        "contextWindow": 1048576,
        "maxOutput": 943718,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        },
        "inputPrice": 2.0,
        "outputPrice": 10.0
      },
      {
        "id": "z-ai/glm-5.3",
        "contextWindow": 1048576,
        "maxOutput": 943718,
        "capabilities": {
          "tools": true,
          "vision": false,
          "thinking": true
        },
        "inputPrice": 0.084,
        "outputPrice": 3.6
      },
      {
        "id": "minimax/minimax-m3.1-flash",
        "contextWindow": 1048576,
        "maxOutput": 524288,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        },
        "inputPrice": 0.075,
        "outputPrice": 0.3
      }
    ],
  },
  {
    id: 'together',
    name: 'Together',
    nameZh: 'Together AI',
    vendor: 'Together',
    region: 'global',
    format: 'openai-chat',
    baseUrl: 'https://api.together.xyz/v1',
    color: '#0f6fff',
    icon: '🤝',
    note: "模型 ID、上下文与价格来自 Together 官方 Serverless 表格。",
    models: [
      {
        "id": "deepseek-ai/DeepSeek-V4.1-Flash-1017",
        "contextWindow": 1000000,
        "inputPrice": 0.3,
        "outputPrice": 1.2,
        "cacheReadPrice": 0.006,
        "capabilities": {
          "tools": true
        }
      },
      {
        "id": "MiniMaxAI/MiniMax-M3.1-Flash",
        "contextWindow": 1048576,
        "inputPrice": 0.15,
        "outputPrice": 0.6,
        "cacheReadPrice": 0.015,
        "capabilities": {
          "tools": true
        }
      },
      {
        "id": "zai-org/GLM-5.3",
        "contextWindow": 1048575,
        "inputPrice": 1.4,
        "outputPrice": 4.4,
        "cacheReadPrice": 0.26,
        "capabilities": {
          "tools": true
        }
      }
    ],
  },
  {
    id: 'fireworks',
    name: 'Fireworks',
    nameZh: 'Fireworks AI',
    vendor: 'Fireworks',
    region: 'global',
    format: 'openai-chat',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    color: '#ef4444',
    icon: '🎆',
    docs: "https://app.fireworks.ai/models/fireworks/deepseek-v4p1-flash-1017",
    models: [
      {
        "id": "accounts/fireworks/models/deepseek-v4p1-flash-1017"
      }
    ],
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    nameZh: 'DeepInfra',
    vendor: 'DeepInfra',
    region: 'global',
    format: 'openai-chat',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    color: '#0ea5e9',
    icon: '🧊',
    note: "默认 ID 与上下文来自官方 featured API；服务档位与折扣价格请同步账号。",
    models: [
      {
        "id": "moonshotai/Kimi-K3.1-Pro",
        "contextWindow": 1048576,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      },
      {
        "id": "deepseek-ai/DeepSeek-V4.1-Flash-1017",
        "contextWindow": 1048576,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      },
      {
        "id": "zai-org/GLM-5.3",
        "contextWindow": 1048576,
        "capabilities": {
          "tools": true,
          "vision": false,
          "thinking": true
        }
      }
    ],
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    nameZh: 'Cerebras',
    vendor: 'Cerebras',
    region: 'global',
    format: 'openai-chat',
    baseUrl: 'https://api.cerebras.ai/v1',
    color: '#f59e0b',
    icon: '🧠',
    note: "官方 Shared Inference 当前模型；免费与付费账号上下文上限不同，请同步账号目录。",
    models: [
      {
        "id": "gpt-oss-120b"
      },
      {
        "id": "qwen-3.8-27b"
      }
    ],
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    nameZh: '英伟达 NIM',
    vendor: 'NVIDIA',
    region: 'global',
    format: 'openai-chat',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    color: '#76b900',
    icon: '🟩',
    note: "ID 来自 NVIDIA 官方 models API；不把试用额度等同于永久免费。",
    models: [
      {
        "id": "deepseek-ai/deepseek-v4.1-flash"
      },
      {
        "id": "stepfun-ai/step-5-preview"
      },
      {
        "id": "z-ai/glm-5.3-flash"
      }
    ],
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    nameZh: 'Perplexity',
    vendor: 'Perplexity',
    region: 'global',
    format: 'openai-chat',
    baseUrl: 'https://api.perplexity.ai',
    color: '#20808d',
    icon: '🔍',
    note: "该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。",
    models: [],
  },
  {
    id: 'cohere',
    name: 'Cohere',
    nameZh: 'Cohere',
    vendor: 'Cohere',
    region: 'global',
    format: 'openai-chat',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    color: '#39594d',
    icon: 'ⓒ',
    docs: "https://docs.cohere.com/docs/models",
    models: [
      {
        "id": "command-a-plus-05-2026",
        "contextWindow": 128000,
        "maxOutput": 64000,
        "capabilities": {
          "tools": true,
          "vision": true,
          "thinking": true
        }
      }
    ],
  },
  {
    id: 'github-models',
    name: 'GitHub Models',
    nameZh: 'GitHub 模型',
    vendor: 'GitHub',
    region: 'global',
    format: 'openai-chat',
    baseUrl: 'https://models.inference.ai.azure.com',
    color: '#24292f',
    icon: '🐙',
    note: "该服务的当前模型列表需结合账号或控制台确认；添加密钥后读取模型，避免使用过期或未开通的固定 ID。",
    models: [],
  },
  {
    id: 'azure-openai',
    name: 'Azure OpenAI',
    nameZh: '微软 Azure',
    vendor: 'Microsoft',
    region: 'global',
    format: 'openai-chat',
    baseUrl: '',
    color: '#0078d4',
    icon: '🅰️',
    customBaseUrl: true,
    note: "填写 Azure 资源地址及部署名称；请求的 model 必须匹配自己的部署，不是通用厂商展示名。",
    models: [],
  },

  /* ------------------------------ 本地 ------------------------------ */
  {
    id: 'ollama',
    name: 'Ollama',
    nameZh: 'Ollama 本地',
    vendor: 'Ollama',
    region: 'local',
    format: 'openai-chat',
    baseUrl: 'http://127.0.0.1:11434/v1',
    color: '#111827',
    icon: '🦙',
    note: "读取本机服务当前已安装或已加载模型；不同机器的模型 ID 和上下文配置不同。",
    models: [],
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    nameZh: 'LM Studio 本地',
    vendor: 'LM Studio',
    region: 'local',
    format: 'openai-chat',
    baseUrl: 'http://127.0.0.1:1234/v1',
    color: '#7c3aed',
    icon: '🎛️',
    note: "读取本机服务当前已安装或已加载模型；不同机器的模型 ID 和上下文配置不同。",
    models: [],
  },
  {
    id: 'vllm',
    name: 'vLLM',
    nameZh: 'vLLM 自建',
    vendor: 'vLLM',
    region: 'local',
    format: 'openai-chat',
    baseUrl: 'http://127.0.0.1:8000/v1',
    color: '#0f766e',
    icon: '🚀',
    note: "读取本机服务当前已安装或已加载模型；不同机器的模型 ID 和上下文配置不同。",
    models: [],
  },

  /* ------------------------------ 中转 / 自定义 ------------------------------ */
  {
    id: 'relay-openai',
    name: '自定义 OpenAI 兼容',
    nameZh: '中转站（OpenAI 兼容）',
    vendor: '自定义',
    region: 'relay',
    format: 'openai-chat',
    baseUrl: '',
    color: '#64748b',
    icon: '🔌',
    customBaseUrl: true,
    note: "填写中转服务地址和密钥后读取实际可用模型；不预置未经该站验证的模型 ID。",
    models: [],
  },
  {
    id: 'relay-anthropic',
    name: '自定义 Anthropic 兼容',
    nameZh: '中转站（Claude 兼容）',
    vendor: '自定义',
    region: 'relay',
    format: 'anthropic',
    baseUrl: '',
    color: '#b45309',
    icon: '🧷',
    customBaseUrl: true,
    note: "填写中转服务地址和密钥后读取实际可用模型；不预置未经该站验证的模型 ID。",
    models: [],
  },
  {
    id: 'relay-gemini',
    name: '自定义 Gemini 兼容',
    nameZh: '中转站（Gemini 兼容）',
    vendor: '自定义',
    region: 'relay',
    format: 'gemini',
    baseUrl: '',
    color: '#1d4ed8',
    icon: '🔗',
    customBaseUrl: true,
    note: "填写中转服务地址和密钥后读取实际可用模型；不预置未经该站验证的模型 ID。",
    models: [],
  },

  /* ------------------------------ 订阅通道 ------------------------------ */
  {
    id: 'claude-subscription',
    name: 'Claude 订阅',
    nameZh: 'Claude 官方订阅',
    vendor: 'Anthropic',
    region: 'subscription',
    format: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    color: '#d97757',
    icon: '✳',
    official: true,
    note: "使用对应官方客户端的真实登录状态；模型访问权限由订阅账号与客户端决定。",
    models: [],
  },
  {
    id: 'chatgpt-subscription',
    name: 'ChatGPT 订阅',
    nameZh: 'ChatGPT Plus / Pro',
    vendor: 'OpenAI',
    region: 'subscription',
    format: 'openai-responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    color: '#10a37f',
    icon: '◍',
    official: true,
    note: "使用对应官方客户端的真实登录状态；模型访问权限由订阅账号与客户端决定。",
    models: [],
  },
  {
    id: 'copilot-subscription',
    name: 'GitHub Copilot',
    nameZh: 'GitHub Copilot 订阅',
    vendor: 'GitHub',
    region: 'subscription',
    format: 'openai-chat',
    baseUrl: 'https://api.githubcopilot.com',
    color: '#24292f',
    icon: '🐙',
    official: true,
    note: "使用对应官方客户端的真实登录状态；模型访问权限由订阅账号与客户端决定。",
    models: [],
  },
];

export function findPreset(id?: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

export const PRESET_REGIONS: Record<string, string> = {
  cn: '国内直连',
  global: '海外直连',
  local: '本地部署',
  relay: '中转 / 自定义',
  subscription: '订阅通道',
};

/**
 * 推荐顺序：客户端视角的默认序 —— ChatGPT 系(OpenAI/Codex) 最前，
 * 其次 Claude，再次 DeepSeek，然后才是其它国内/海外/本地。
 * 云汇AI 官方中转在中转服务组内优先展示。
 */
const PRESET_RANK: Record<string, number> = {
  yunhui: 0,
  openai: 10,
  'chatgpt-subscription': 11,
  codex: 12,
  anthropic: 20,
  'claude-subscription': 21,
  deepseek: 30,
  'github-models': 40,
  'copilot-subscription': 41,
  gemini: 50,
  xai: 60,
};

PROVIDER_PRESETS.sort((a, b) => {
  const ra = PRESET_RANK[a.id] ?? 100;
  const rb = PRESET_RANK[b.id] ?? 100;
  return ra - rb;
});
