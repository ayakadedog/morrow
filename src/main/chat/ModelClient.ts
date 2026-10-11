import { ChatOpenAICompletions, ChatOpenAIResponses } from '@langchain/openai';
import { ChatDeepSeek } from '@langchain/deepseek';
import { SystemMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ModelOptions } from '../../shared/contracts';

export interface ModelMessage { role: 'system' | 'user' | 'assistant'; content: string; images?: { url: string; byteLength: number }[] }
export interface ModelConnection extends Partial<ModelOptions> { purpose?: 'memory' | 'summary'; baseUrl: string; model: string; apiKey: string; streaming?: boolean }
export interface ModelTelemetry { model: string; attempts?: number; inputTokens?: number; outputTokens?: number; totalTokens?: number; reasoningTokens?: number; finishReason?: string; elapsedMs: number; firstReasoningMs?: number; firstAnswerMs?: number }
export type Generate = (connection: ModelConnection, messages: ModelMessage[], signal: AbortSignal, onDelta: (text: string) => void, onReasoning?: (text: string) => void, onTelemetry?: (value: ModelTelemetry) => void) => Promise<string>;
export class ModelCallError extends Error {
  attempts?: number;
  constructor(message: string, readonly errorCode = 'INVALID_REPLY', readonly httpStatus?: number, readonly transportCode?: string) { super(message); }
}

// Desktop conversations go only to the explicitly configured model endpoint.
process.env.LANGSMITH_TRACING = 'false';
process.env.LANGCHAIN_TRACING_V2 = 'false';
process.env.LANGCHAIN_TRACING = 'false';
process.env.LANGCHAIN_VERBOSE = 'false';

function safeError(error: unknown): ModelCallError {
  const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
  const cause = typeof error === 'object' && error !== null && 'cause' in error ? error.cause : undefined;
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
  const transportCode = typeof code === 'string' && ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code) ? code : undefined;
  return new ModelCallError(status === 401 || status === 403 ? '模型认证失败，请检查密钥和权限'
    : status === 402 ? '模型余额不足，请检查账户额度'
    : status === 429 ? '模型额度或频率受限，请稍后重试'
    : typeof status === 'number' ? `模型服务暂不可用（HTTP ${status}）`
    : '模型连接失败，请检查网络与服务地址后重试', typeof status === 'number' ? `HTTP_${status}` : 'CONNECTION_FAILED', typeof status === 'number' ? status : undefined, transportCode);
}
function checkFinish(reason: unknown) {
  if (reason === 'length' || reason === 'content_filter' || reason === 'incomplete') throw new ModelCallError('模型回复被截断或拒绝，请提高输出预算或检查模型设置后重试');
  if (reason !== 'stop' && reason !== 'completed') throw new ModelCallError('模型没有正常结束文字回复，请检查服务兼容性后重试');
}
function returnedReasoning(message: BaseMessage): string {
  // Only server-returned public reasoning/summary fields, never fabricate a chain or read encrypted items.
  if (typeof message.additional_kwargs.reasoning_content === 'string') return message.additional_kwargs.reasoning_content;
  const blocks = message.contentBlocks.filter(block => block.type === 'reasoning');
  return blocks.map(block => 'reasoning' in block && typeof block.reasoning === 'string' ? block.reasoning : '').join('');
}

// Only application policy lives here. LangChain and its provider SDK own HTTP, SSE and UTF-8 decoding.
export const generate: Generate = async (connection, messages, signal, onDelta, onReasoning, onTelemetry) => {
  const cleanup = new AbortController(), requestSignal = AbortSignal.any([signal, cleanup.signal]);
  const started = performance.now(), telemetry: ModelTelemetry = { model: connection.model, elapsedMs: 0, attempts: 0 };
  try {
    requestSignal.throwIfAborted();
    const responses = connection.protocol === 'responses';
    const deepseek = connection.provider === 'deepseek';
    if (deepseek && responses) throw new ModelCallError('DeepSeek 专用适配目前使用 Chat Completions 协议');
    const effort = connection.reasoningEffort ?? 'default';
    const thinking = connection.thinking === 'disabled' || effort === 'none' ? 'disabled' : connection.thinking ?? 'default';
    const reasoning = { ...(effort !== 'default' ? { effort } : {}), ...(responses && connection.reasoningSummary !== false ? { summary: 'auto' } : {}) };
    const modelKwargs = deepseek ? { ...(thinking !== 'default' ? { thinking: { type: thinking } } : {}),
      ...(thinking !== 'disabled' && effort !== 'default' ? { reasoning_effort: effort } : {}) }
      : responses ? { store: false, ...(Object.keys(reasoning).length ? { reasoning } : {}) }
      : effort !== 'default' ? { reasoning_effort: effort } : {};
    const fields = {
      model: connection.model, apiKey: connection.apiKey || 'local-no-key',
      maxTokens: connection.maxOutputTokens ?? 12288, maxRetries: 0, timeout: (connection.timeoutSeconds ?? 120) * 1000,
      // Explicit settings must also reach compatible services with non-OpenAI model names.
      modelKwargs,
      streaming: connection.streaming !== false, streamUsage: false, verbose: false,
      // The provider SDK retries transient connection/HTTP failures once, before delivering a stream.
      // LangChain retries remain disabled, so a partial answer is never replayed by our outer layer.
      configuration: { baseURL: connection.baseUrl, maxRetries: 1, logLevel: 'off' as const,
        // Keep redirect/credential policy; the SDK constructs and parses requests.
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          telemetry.attempts!++;
          const headers = new Headers(init?.headers);
          headers.delete('openai-organization'); headers.delete('openai-project');
          if (!connection.apiKey) headers.delete('authorization');
          const transportSignal = init?.signal ? AbortSignal.any([requestSignal, init.signal]) : requestSignal;
          return fetch(input, { ...init, headers, redirect: 'manual', signal: transportSignal });
        }
      }
    };
    const model = deepseek ? new ChatDeepSeek(fields) : responses ? new ChatOpenAIResponses(fields) : new ChatOpenAICompletions(fields);
    const input = messages.map(m => m.role === 'system' ? new SystemMessage(m.content)
      : m.role === 'user' ? new HumanMessage(m.images?.length ? { content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...m.images.map(image => ({ type: 'image_url', image_url: { url: image.url } }))] } : m.content) : new AIMessage(m.content));
    const callOptions = { signal: requestSignal, ...(deepseek ? { response_format: { type: 'json_object' as const } } : {}) };
    let text = '', finish: unknown, reasoningLength = 0;
    const collect = (message: BaseMessage, terminalSnapshot = false) => {
      requestSignal.throwIfAborted();
      // Responses terminal metadata repeats the full summary already delivered as deltas.
      const reasoning = (terminalSnapshot && reasoningLength ? '' : returnedReasoning(message)).slice(0, Math.max(0, 192000 - reasoningLength));
      reasoningLength += reasoning.length;
      if (reasoning) { telemetry.firstReasoningMs ??= Math.round(performance.now() - started); onReasoning?.(reasoning); }
      const delta = message.text;
      requestSignal.throwIfAborted(); text += delta;
      if (text.length > (connection.purpose ? (connection.maxOutputTokens ?? 12288) * 12 : 36000)) throw new ModelCallError('模型回复过长');
      if (delta) { telemetry.firstAnswerMs ??= Math.round(performance.now() - started); onDelta(delta); }
      if ('usage_metadata' in message && message.usage_metadata && typeof message.usage_metadata === 'object') {
        const usage = message.usage_metadata as { input_tokens?: number; output_tokens?: number; total_tokens?: number; output_token_details?: { reasoning?: number } };
        for (const [target, value] of [['inputTokens', usage.input_tokens], ['outputTokens', usage.output_tokens], ['totalTokens', usage.total_tokens], ['reasoningTokens', usage.output_token_details?.reasoning]] as const) if (typeof value === 'number') telemetry[target] = value;
      }
    };
    if (connection.streaming === false) {
      const reply = await model.invoke(input, callOptions);
      finish = responses ? reply.response_metadata.status : reply.response_metadata.finish_reason; checkFinish(finish); collect(reply);
    } else {
      const stream = await model.stream(input, callOptions);
      for await (const chunk of stream) {
        requestSignal.throwIfAborted(); collect(chunk, responses && Boolean(chunk.response_metadata.status));
        finish = (responses ? chunk.response_metadata.status : chunk.response_metadata.finish_reason) ?? finish;
        if (finish === 'length' || finish === 'content_filter' || finish === 'incomplete' || finish === 'failed') checkFinish(finish);
      }
      checkFinish(finish);
    }
    requestSignal.throwIfAborted();
    if (!text.trim()) throw new ModelCallError(reasoningLength ? '模型只返回了推理内容，没有最终回答；请检查输出预算与模型设置' : '模型没有返回文字内容');
    telemetry.finishReason = String(finish); telemetry.elapsedMs = Math.round(performance.now() - started); onTelemetry?.(telemetry);
    return text;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    const safe = error instanceof ModelCallError ? error : safeError(error); safe.attempts = telemetry.attempts; throw safe;
  } finally { cleanup.abort(); }
};
