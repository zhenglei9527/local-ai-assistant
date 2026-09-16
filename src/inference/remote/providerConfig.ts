/**
 * Remote (cloud) provider configuration.
 *
 * WHY THIS EXISTS
 * ---------------
 * The app ships a local GGUF path as its headline: no account, no network
 * after the model download, nothing leaving the device. That stays the default.
 *
 * But a local-only app has a hard floor: a 5 GB download and ~4 GB of resident
 * memory before the user sees a single token. That floor loses the entire
 * low-end Android market, and it loses every user who will not commit 5 GB of
 * storage to an app they have not yet decided they like.
 *
 * So the cloud path is an explicitly-labelled OPTIONAL FALLBACK, not a peer:
 *
 *   - Local is the default and the product's selling point.
 *   - Cloud is opt-in, requires the user to enter a key, and the UI must state
 *     plainly that conversations leave the device when it is active.
 *   - The `INTERNET` permission comment in AndroidManifest says "Model
 *     downloads only". That comment becomes FALSE the moment a remote provider
 *     is configured, which is why {@link REMOTE_PRIVACY_NOTICE} exists and why
 *     the settings UI is required to surface it.
 *
 * Two wire protocols are supported. That is deliberately two and not one:
 * Anthropic's Messages API is not OpenAI-compatible in any useful way (system
 * prompt is a top-level field, `max_tokens` is required, streaming events have
 * a different shape), and doing OpenAI-only would mean telling Claude users to
 * use a translation proxy. Everything else — DeepSeek, 智谱, Kimi, 硅基流动,
 * 通义, Ollama, vLLM, LM Studio — speaks the OpenAI shape, so `openai` covers
 * them all with one implementation.
 */

/** Which wire protocol a provider speaks. */
export type RemoteProtocol = 'openai' | 'anthropic'

/**
 * A configured remote endpoint.
 *
 * `apiKey` is held in memory and persisted only via the platform keystore —
 * never in the model catalogue, never in a chat record, never in a log line.
 */
export interface RemoteProviderConfig {
  readonly id: string
  /** Shown in the provider list. */
  readonly label: string
  readonly protocol: RemoteProtocol
  /**
   * Base URL **without** the trailing path, e.g. `https://api.deepseek.com/v1`.
   * The request builder appends the protocol-specific suffix, so the user only
   * ever pastes what a provider's own docs call the "base URL".
   */
  readonly baseUrl: string
  /** Model identifier as the provider names it, e.g. `deepseek-chat`. */
  readonly model: string
  /** Bearer token (openai) or `x-api-key` (anthropic). */
  readonly apiKey: string
  /**
   * Region shim for Anthropic-compatible Chinese gateways. Unused for openai.
   * Kept explicit rather than inferred so the request path stays predictable.
   */
  readonly anthropicVersion?: string
}

/**
 * Preset endpoints offered in the settings UI.
 *
 * These are *suggestions*: the user can edit every field, and `custom` exists
 * because self-hosted endpoints (Ollama, vLLM, LM Studio on a LAN address) are
 * a first-class use case, not an edge case.
 *
 * Deliberately no API keys here — a preset is a URL and a protocol, nothing
 * more. Shipping a key in the binary would leak it on the first decompile.
 */
export interface ProviderPreset {
  readonly id: string
  readonly label: string
  readonly protocol: RemoteProtocol
  readonly baseUrl: string
  /** Pre-filled model name; usually the provider's cheapest general model. */
  readonly suggestedModel: string
  /** One-line hint shown under the field. */
  readonly hint: string
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    suggestedModel: 'deepseek-chat',
    hint: '国内直连，OpenAI 兼容',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    suggestedModel: 'glm-4-flash',
    hint: '有免费额度，OpenAI 兼容',
  },
  {
    id: 'moonshot',
    label: 'Kimi (月之暗面)',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    suggestedModel: 'moonshot-v1-8k',
    hint: '国内直连，OpenAI 兼容',
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    suggestedModel: 'Qwen/Qwen2.5-7B-Instruct',
    hint: '聚合多模型，OpenAI 兼容',
  },
  {
    id: 'dashscope',
    label: '通义千问',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    suggestedModel: 'qwen-plus',
    hint: '阿里云，OpenAI 兼容模式',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    suggestedModel: 'gpt-4o-mini',
    hint: '需要海外网络',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    suggestedModel: 'claude-3-5-haiku-latest',
    hint: '需要海外网络；协议与 OpenAI 不同',
  },
  {
    id: 'ollama',
    label: 'Ollama (局域网)',
    protocol: 'openai',
    baseUrl: 'http://192.168.1.100:11434/v1',
    suggestedModel: 'qwen2.5:7b',
    hint: '把地址改成你电脑的局域网 IP',
  },
  {
    id: 'custom',
    label: '自定义',
    protocol: 'openai',
    baseUrl: '',
    suggestedModel: '',
    hint: '自建 vLLM / LM Studio / 中转站',
  },
]

/**
 * Shown wherever a remote provider is enabled.
 *
 * This is a product requirement, not decoration. The app's manifest declares
 * `INTERNET` with a comment saying it is for model downloads; once a remote
 * provider is configured that is no longer the whole truth, and a user who
 * chose this app *because* it is offline deserves to be told in plain words.
 */
export const REMOTE_PRIVACY_NOTICE =
  '云端模式下，你的对话内容会发送到第三方服务器。本地模型模式不会联网（下载模型除外）。'

/**
 * Validates a user-entered endpoint before it is saved.
 *
 * Returns a list of human-readable problems; empty means acceptable. Kept
 * pure and dependency-free so it is testable without a device.
 */
export function validateProviderConfig(
  config: Pick<RemoteProviderConfig, 'baseUrl' | 'model' | 'apiKey' | 'protocol'>,
): string[] {
  const problems: string[] = []

  const baseUrl = config.baseUrl.trim()
  if (baseUrl.length === 0) {
    problems.push('接口地址不能为空')
  } else if (!/^https?:\/\//i.test(baseUrl)) {
    // http is allowed on purpose: LAN endpoints (Ollama, LM Studio) are
    // plaintext, and refusing them would break a first-class use case.
    problems.push('接口地址必须以 http:// 或 https:// 开头')
  } else {
    try {
      // eslint-disable-next-line no-new
      new URL(baseUrl)
    } catch {
      problems.push('接口地址不是合法的 URL')
    }
  }

  if (config.model.trim().length === 0) {
    problems.push('模型名称不能为空')
  } else if (/\s/.test(config.model.trim())) {
    /**
     * A model name containing a SPACE is almost certainly a product name.
     *
     * Observed on device: the user typed "DeepSeek V4.1 Flash" — the label a
     * provider's website displays — while the API expects the id
     * `deepseek/deepseek-v4.1-flash`. The chat request then failed with a 400
     * the UI never showed, so the app simply appeared frozen.
     *
     * No mainstream provider puts spaces in model ids, so this is a safe
     * heuristic, and it catches the mistake while typing rather than at the
     * point of mysterious silence.
     */
    problems.push(
      '模型名称含空格，可能填成了产品名。API 需要“模型 ID”，例如 deepseek/deepseek-v4.1-flash',
    )
  }

  if (config.apiKey.trim().length === 0) {
    // LAN endpoints frequently need no key at all, so this is a warning-shaped
    // problem only for the providers that do. The caller decides whether to
    // hard-block; we report it and let the UI phrase it as a caution.
    problems.push('API Key 为空（自建服务可忽略）')
  }

  return problems
}

/**
 * Builds the absolute request URL for a provider.
 *
 * Trailing slashes are normalised away because users paste base URLs with and
 * without them, and `https://host/v1/` + `/chat/completions` producing `//` is
 * a 404 on some gateways and a silent redirect on others.
 */
export function buildRequestUrl(config: Pick<RemoteProviderConfig, 'baseUrl' | 'protocol'>): string {
  const base = config.baseUrl.trim().replace(/\/+$/, '')
  return config.protocol === 'anthropic'
    ? `${base}/messages`
    : `${base}/chat/completions`
}
