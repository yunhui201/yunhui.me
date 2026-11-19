/** Copy-only recipes. These never inspect or write a client's configuration. */
export const MANUAL_TOKEN_PLACEHOLDER = 'YOUR_YUNHUI_GATEWAY_TOKEN';
export type ManualGuideVariant = 'workbuddy' | 'codebuddy-cli' | 'codebuddy-ide' | 'opencode-v1' | 'opencode-v2';
export interface ManualGuideInput {
  agentId: string;
  protocol: string;
  platform: string;
  parameters: { baseUrl: string; model: string };
  contextWindow?: number;
  variant?: ManualGuideVariant;
}
export interface ManualGuide {
  title: string;
  protocolLabel: string;
  path?: string;
  pathNote?: string;
  steps: string[];
  notices: string[];
  fields: Array<{ id: 'baseUrl' | 'endpoint' | 'apiKey' | 'model'; label: string; value: string }>;
  document?: { label: string; language: string; content: string };
  command?: { label: string; content: string };
  docs: Array<{ label: string; url: string }>;
  blockingReason?: string;
}

export function manualGuideVariants(agentId: string): Array<{ value: ManualGuideVariant; label: string }> {
  if (agentId === 'workbuddy') return [
    { value: 'workbuddy', label: 'WorkBuddy 桌面版' },
    { value: 'codebuddy-cli', label: 'CodeBuddy CLI' },
    { value: 'codebuddy-ide', label: 'CodeBuddy IDE' },
  ];
  if (agentId === 'opencode') return [
    { value: 'opencode-v1', label: 'OpenCode V1 · provider 格式' },
    { value: 'opencode-v2', label: 'OpenCode V2 · providers 格式' },
  ];
  return [];
}

function validText(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label}无效，请重新预览连接参数。`);
  return value;
}
function normalizeBaseUrl(value: string): string {
  validText(value, 'API 地址');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('API 地址无效，请重新预览连接参数。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('手动指南需要不含账号、查询参数或片段的 HTTP(S) 地址。');
  return url.toString().replace(/\/+$/, '');
}
export function manualChatEndpoint(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
}
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
// JSON's string escapes are TOML basic-string escapes for the accepted input range.
const toml = (value: string) => JSON.stringify(value);
const homePath = (platform: string, path: string) => platform === 'win32' ? `%USERPROFILE%\\${path.replace(/\//g, '\\')}` : `~/${path}`;

/** apiKey is supplied only inside an explicit desktop clipboard action. Default output is public. */
export function buildManualGuide(input: ManualGuideInput, apiKey = MANUAL_TOKEN_PLACEHOLDER): ManualGuide {
  if (input.protocol !== 'openai-chat') throw new Error('此指南仅适用于 OpenAI Chat Completions，请重新选择兼容协议。');
  const baseUrl = normalizeBaseUrl(input.parameters.baseUrl);
  const model = validText(input.parameters.model, '模型 ID');
  validText(apiKey, '访问令牌');
  const variants = manualGuideVariants(input.agentId);
  const variant = input.variant ?? variants[0]?.value;
  if (input.variant && !variants.some(item => item.value === input.variant)) throw new Error('客户端指南版本不匹配，请重新选择。');
  const guide: ManualGuide = {
    title: '手动配置', protocolLabel: 'OpenAI Chat Completions',
    fields: [{ id: 'baseUrl', label: 'API 基础地址', value: baseUrl }, { id: 'model', label: '模型 ID', value: model }, { id: 'apiKey', label: 'API Key / 访问令牌', value: apiKey }],
    steps: [], notices: ['保留模型 ID 的完整前缀，它用于将请求交给所选供应商。使用期间请保持云汇与本地网关运行。'], docs: [],
  };
  if (input.agentId === 'workbuddy') {
    const endpoint = manualChatEndpoint(baseUrl);
    guide.fields[0] = { id: 'endpoint', label: '完整接口 URL', value: endpoint };
    if (variant === 'workbuddy') {
      guide.title = 'WorkBuddy · 自定义模型';
      guide.steps = ['在 WorkBuddy 模型选择器进入自定义模型配置，点击添加，供应商选择“自定义 / Custom”。', '分别填写下面的完整 URL、模型 ID 和 API Key。标准聊天路径保持“自定义协议”关闭；能力开关按供应商实际支持填写。', '保存后，在对话的自定义模型分组中选中该模型，新建对话验证。'];
      guide.notices.push('WorkBuddy 各版本的配置目录存在差异，本指南使用客户端可视化入口。CodeBuddy CLI / IDE 请在上方切换对应指南。');
      guide.docs = [{ label: 'WorkBuddy 官方模型配置', url: 'https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model' }];
    } else {
      const cli = variant === 'codebuddy-cli';
      guide.title = cli ? 'CodeBuddy CLI · 自定义模型' : 'CodeBuddy IDE · 自定义模型';
      guide.path = homePath(input.platform, '.codebuddy/models.json');
      guide.pathNote = '项目中的 .codebuddy/models.json 优先于用户配置；请核对实际工作目录。';
      guide.steps = ['先备份已有 models.json，再将示例中的模型条目合并到 models 数组，保留其他模型和设置。', '如果已有非空 availableModels，将下面的完整模型 ID 加入原列表；项目级列表会覆盖用户级列表。', cli ? '重新打开 CodeBuddy CLI，用 /model 选择新增模型，再发起一条对话。' : '重新打开 CodeBuddy IDE，在模型选择器中选择新增模型，再发起一条对话。'];
      guide.document = { label: 'models.json 配置示例', language: 'JSON', content: json({ models: [{ id: model, name: `云汇 · ${model}`, vendor: 'OpenAI', url: endpoint, apiKey }] }) };
      guide.docs = [{ label: cli ? 'CodeBuddy CLI 官方配置' : 'CodeBuddy IDE 官方配置', url: cli ? 'https://www.codebuddy.cn/docs/cli/models' : 'https://www.codebuddy.cn/docs/ide/Features/models' }];
      if (cli) guide.command = { label: '启动命令', content: 'codebuddy' };
    }
  } else if (input.agentId === 'kimi-code') {
    guide.title = 'Kimi CLI · 独立配置';
    guide.path = homePath(input.platform, '.kimi/yunhui.toml');
    guide.pathNote = `这是单独保存的云汇配置。Kimi 默认读取 ${homePath(input.platform, '.kimi/config.toml')}；使用下方命令指定本文件。`;
    guide.steps = ['核对所选模型实际支持的上下文 Token 数，将配置保存为下面的 yunhui.toml 文件。', '使用下方命令启动 Kimi，显式指定这份配置；普通 kimi 命令仍使用原默认配置。', '在 Kimi 中用 /model 检查已选择 yunhui，再发起一条对话。'];
    guide.notices.push('Chat Completions 使用 openai_legacy；openai_responses 是另一种协议。/login 或 /setup 的内置平台登录不能替代自定义网关配置。', 'Kimi Code 平台专属工具可能要求官方服务授权，普通模型接入不等于支持全部专属工具。');
    if (!Number.isSafeInteger(input.contextWindow) || input.contextWindow! <= 0) {
      guide.blockingReason = 'Kimi 要求 max_context_size。请填写供应商确认的上下文 Token 数，再复制配置；这里不会猜测模型容量。';
    } else {
      guide.document = { label: 'yunhui.toml 配置', language: 'TOML', content: `default_model = "yunhui"\n\n[providers.yunhui]\ntype = "openai_legacy"\nbase_url = ${toml(baseUrl)}\napi_key = ${toml(apiKey)}\n\n[models.yunhui]\nprovider = "yunhui"\nmodel = ${toml(model)}\nmax_context_size = ${input.contextWindow}\n` };
      if (input.contextWindow! <= 50000) guide.notices.push('此模型窗口不超过 Kimi 默认预留的 50,000 Token。请按官方文档调整 loop_control.reserved_context_size，使其小于实际窗口，否则可能过早压缩或无法正常对话。');
    }
    guide.command = { label: input.platform === 'win32' ? 'PowerShell 启动命令' : '终端启动命令', content: input.platform === 'win32' ? 'kimi --config-file "$env:USERPROFILE\\.kimi\\yunhui.toml"' : 'kimi --config-file "$HOME/.kimi/yunhui.toml"' };
    guide.docs = [{ label: 'Kimi 官方配置格式', url: 'https://moonshotai.github.io/kimi-cli/en/configuration/config-files.html' }, { label: '供应商与协议', url: 'https://moonshotai.github.io/kimi-cli/en/configuration/providers.html' }];
  } else if (input.agentId === 'opencode') {
    const v2 = variant === 'opencode-v2';
    guide.title = `OpenCode ${v2 ? 'V2' : 'V1'} · 自定义供应商`;
    guide.path = homePath(input.platform, '.config/opencode/opencode.json');
    guide.pathNote = '也支持 opencode.jsonc。自定义配置目录、项目中的 opencode.json 或 .opencode/opencode.json 可能覆盖用户设置。';
    guide.steps = ['先运行 opencode --version，并在上方选择匹配的 V1 / V2 格式。', `备份已有配置，再合并示例中的 ${v2 ? 'providers' : 'provider'} 和 model 设置。若已有 yunhui 供应商，请核对后合并，保留其他设置。`, '重新启动 OpenCode，在 /models 中选择“云汇”下的模型，再发起一条对话。'];
    guide.document = { label: 'opencode.json 配置示例', language: 'JSON', content: json({
      $schema: 'https://opencode.ai/config.json', model: 'yunhui/current',
      ...(v2 ? { providers: { yunhui: { name: '云汇', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: baseUrl, apiKey }, models: { current: { name: model, modelID: model } } } } }
        : { provider: { yunhui: { name: '云汇', npm: '@ai-sdk/openai-compatible', options: { baseURL: baseUrl, apiKey }, models: { current: { name: model, id: model } } } } }),
    }) };
    guide.notices.push('yunhui/current 是 OpenCode 内的选择名称；配置里的实际模型 ID 保留完整供应商前缀。V1 与 V2 字段不能混用。');
    guide.command = { label: '启动命令', content: 'opencode' };
    guide.docs = [{ label: 'OpenCode 官方供应商说明', url: 'https://opencode.ai/docs/providers/' }, { label: '配置文件位置', url: 'https://opencode.ai/docs/config/' }];
  } else if (input.agentId === 'qwen-code') {
    guide.title = 'Qwen Code · 自定义模型';
    guide.path = homePath(input.platform, '.qwen/settings.json');
    guide.pathNote = '合并到用户级配置，保留已有模型、其他 env 项和安全设置。';
    guide.steps = ['先备份 settings.json，再将示例中的模型条目、令牌和所选模型合并到已有设置。', '确认认证方式为 OpenAI；如仍使用旧账号，可在 Qwen Code 的 /auth 中核对。', '重新启动 qwen，通过 /model 选择下面的模型，再发起一条对话。'];
    guide.document = { label: 'settings.json 配置示例', language: 'JSON', content: json({ modelProviders: { openai: [{ id: model, name: `云汇 · ${model}`, envKey: 'YUNHUI_API_KEY', baseUrl, wireApi: 'chat-completions' }] }, env: { YUNHUI_API_KEY: apiKey }, security: { auth: { selectedType: 'openai' } }, model: { name: model } }) };
    guide.notices.push('终端环境变量和 .env 可覆盖 settings.json 中同名令牌。若仍连接旧服务，请核对当前终端与项目的配置来源。');
    guide.command = { label: '启动命令', content: 'qwen' };
    guide.docs = [{ label: 'Qwen Code 官方认证配置', url: 'https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/auth.md' }];
  } else {
    guide.title = '兼容客户端 · 手动填写';
    guide.steps = ['在目标应用中找到自定义 API 或自定义供应商入口，选择 OpenAI Chat Completions。', '按字段填写下面的 API 基础地址、完整模型 ID 和访问令牌。若应用明确要求完整请求地址，在基础地址后加 /chat/completions。', '保存后选择该模型，新建对话验证。没有自定义 API 入口的应用无法使用这份配置。'];
    guide.notices.push(input.agentId === 'deepseek' ? 'DeepSeek 是模型服务；这份参数不会替换 DeepSeek 官方网页或 App 的模型。' : '此客户端的配置文件格式尚未验证，请以它的自定义 API 设置为准。');
  }
  return guide;
}

export function manualGuideParameters(guide: ManualGuide): string {
  return [`协议: ${guide.protocolLabel}`, ...guide.fields.map(field => `${field.label}: ${field.value}`)].join('\n');
}
