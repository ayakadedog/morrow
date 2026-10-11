import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { generate, type ModelConnection } from '../../src/main/chat/ModelClient';
import { parseReply, visibleDraft } from '../../src/main/chat/ContextBuilder';
import { loadPack } from '../../src/main/characters/PackLoader';
import { resolve } from 'node:path';

const servers: Server[] = [];
async function endpoint(handle: (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void) {
  const requests: { path: string; auth?: string; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ path: req.url!, auth: req.headers.authorization, body }); handle(req, res, body);
    });
  });
  servers.push(server); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  const connection: ModelConnection = { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fixture-model', apiKey: 'fixture-only-secret' };
  return { connection, requests };
}
const event = (content: string, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: finish }] })}\r\n\r\n`;
const signal = () => new AbortController().signal;
const reasoningEvent = (text: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: null, reasoning_content: text }, finish_reason: null }] })}\n\n`;
const responseFixture = (status = 'completed') => ({ id: 'resp_fixture', object: 'response', created_at: 1, status, model: 'fixture-model',
  output: [{ type: 'reasoning', id: 'rs_fixture', summary: [{ type: 'summary_text', text: '公开推理摘要' }] },
    { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"text":"最终回答"}', annotations: [] }] }],
  ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
  usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, output_tokens_details: { reasoning_tokens: 15 } } });
afterEach(async () => { await Promise.all(servers.splice(0).map(server => { server.closeAllConnections(); return new Promise<void>(done => server.close(() => done())); })); });

describe('LangChain provider adapter with real local HTTP', () => {
  it.each(['openai-compatible', 'deepseek', 'responses'])('serializes actual pixels using the SDK vision content blocks (%s)', async provider => {
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    const { connection, requests } = await endpoint((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(provider === 'responses' ? responseFixture() : { id: 'chat_image', object: 'chat.completion', model: 'fixture-model', choices: [{ index: 0, message: { role: 'assistant', content: '{"text":"图片回答"}' }, finish_reason: 'stop' }] }));
    });
    await generate({ ...connection, provider: provider === 'deepseek' ? 'deepseek' : 'openai-compatible', protocol: provider === 'responses' ? 'responses' : 'chat-completions', streaming: false }, [{ role: 'system', content: 'Return JSON' }, { role: 'user', content: '看看图片', images: [{ url: image, byteLength: 8 }] }], signal(), () => {});
    if (provider === 'responses') {
      const input = requests[0].body.input as { role: string; content: unknown }[];
      expect(input.at(-1)?.content).toEqual([{ type: 'input_text', text: '看看图片' }, { type: 'input_image', image_url: image }]);
    } else {
      const input = requests[0].body.messages as { role: string; content: unknown }[];
      expect(input.at(-1)?.content).toEqual([{ type: 'text', text: '看看图片' }, { type: 'image_url', image_url: { url: image } }]);
    }
  });
  it.each([true, false])('uses the DeepSeek provider with explicit thinking and SDK token metadata (stream=%s)', async streaming => {
    const { connection, requests } = await endpoint((_req, res) => {
      if (streaming) res.writeHead(200, { 'content-type': 'text/event-stream' }).end(reasoningEvent('真实字段') + event('最终台词', 'stop') + 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":7,"total_tokens":10,"completion_tokens_details":{"reasoning_tokens":5}}}\n\ndata: [DONE]\n\n');
      else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '最终台词', reasoning_content: '真实字段' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10, completion_tokens_details: { reasoning_tokens: 5 } } }));
    });
    let reasoning = ''; const telemetry = vi.fn();
    expect(await generate({ ...connection, streaming, provider: 'deepseek', thinking: 'enabled', reasoningEffort: 'max' }, [], signal(), () => {}, d => { reasoning += d; }, telemetry)).toBe('最终台词');
    expect(reasoning).toBe('真实字段'); expect(requests[0].body).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'max', response_format: { type: 'json_object' } });
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 3, outputTokens: 7, totalTokens: 10, reasoningTokens: 5, finishReason: 'stop' }));
  });
  it.each(['disabled', 'none'] as const)('turns off DeepSeek thinking using its explicit toggle (%s)', async choice => {
    const { connection, requests } = await endpoint((_req, res) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(event('直接回答', 'stop') + 'data: [DONE]\n\n'));
    await generate({ ...connection, provider: 'deepseek', thinking: choice === 'disabled' ? 'disabled' : 'default', reasoningEffort: choice === 'none' ? 'none' : 'high' }, [], signal(), () => {});
    expect(requests[0].body.thinking).toEqual({ type: 'disabled' }); expect(requests[0].body).not.toHaveProperty('reasoning_effort');
  });
  it('rejects an unsupported DeepSeek provider protocol before making a request', async () => {
    const { connection, requests } = await endpoint((_req, res) => res.end());
    await expect(generate({ ...connection, provider: 'deepseek', protocol: 'responses' }, [], signal(), () => {})).rejects.toThrow('专用适配'); expect(requests).toEqual([]);
  });
  it.each([true, false])('separates returned reasoning_content from answers (stream=%s)', async streaming => {
    const thought = '{"text":"不可当成台词","action":"greet"}';
    const { connection, requests } = await endpoint((_req, res) => {
      if (streaming) res.writeHead(200, { 'content-type': 'text/event-stream' }).end(reasoningEvent(thought) + event('{"text":"最终回答"}', 'stop') + 'data: [DONE]\n\n');
      else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '{"text":"最终回答"}', reasoning_content: thought }, finish_reason: 'stop' }] }));
    });
    let answer = '', reasoning = '';
    expect(await generate({ ...connection, streaming }, [], signal(), d => { answer += d; }, d => { reasoning += d; })).toBe('{"text":"最终回答"}');
    expect(answer).toBe('{"text":"最终回答"}'); expect(reasoning).toBe(thought); expect(requests[0].body).not.toHaveProperty('reasoning_effort');
  });
  it('accepts final answers when the model does not expose its reasoning', async () => {
    const { connection } = await endpoint((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '最终回答' }, finish_reason: 'stop' }], usage: { completion_tokens_details: { reasoning_tokens: 15 } } })));
    const reasoning = vi.fn(); expect(await generate({ ...connection, streaming: false }, [], signal(), () => {}, reasoning)).toBe('最终回答'); expect(reasoning).not.toHaveBeenCalled();
  });
  it('rejects reasoning-only output without fabricating a reply', async () => {
    const { connection } = await endpoint((_req, res) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(reasoningEvent('只有思考') + event('', 'stop') + 'data: [DONE]\n\n'));
    await expect(generate(connection, [], signal(), () => {})).rejects.toThrow('没有最终回答');
  });
  it('aborts during reasoning without emitting a final answer', async () => {
    let closed!: () => void; const disconnected = new Promise<void>(done => { closed = done; });
    const { connection } = await endpoint((_req, res) => { res.on('close', closed); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(reasoningEvent('思考开始')); });
    const controller = new AbortController(), answer = vi.fn();
    await expect(generate(connection, [], controller.signal, answer, () => controller.abort())).rejects.toBeDefined();
    await disconnected; expect(answer).not.toHaveBeenCalled();
  });
  it.each([true, false])('delegates Responses summaries and final answers to LangChain (stream=%s)', async streaming => {
    const { connection, requests } = await endpoint((_req, res) => {
      if (!streaming) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(responseFixture())); return; }
      const sse = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(
        sse('response.created', { response: { id: 'resp_fixture', model: 'fixture-model' } })
        + sse('response.reasoning_summary_text.delta', { item_id: 'rs_fixture', output_index: 0, summary_index: 0, delta: '公开推理摘要' })
        + sse('response.output_text.delta', { item_id: 'msg_fixture', output_index: 1, content_index: 0, delta: '{"text":"最终回答"}' })
        + sse('response.completed', { response: responseFixture() }));
    });
    let answer = '', reasoning = '';
    expect(await generate({ ...connection, streaming, protocol: 'responses', reasoningEffort: 'high', maxOutputTokens: 8192 }, [], signal(), d => { answer += d; }, d => { reasoning += d; })).toBe('{"text":"最终回答"}');
    expect(answer).toBe('{"text":"最终回答"}'); expect(reasoning).toBe('公开推理摘要');
    expect(requests[0]).toMatchObject({ path: '/v1/responses', body: { store: false, max_output_tokens: 8192, reasoning: { effort: 'high', summary: 'auto' } } });
  });
  it('rejects incomplete Responses output and can omit summary and effort parameters', async () => {
    const { connection, requests } = await endpoint((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(responseFixture('incomplete'))));
    await expect(generate({ ...connection, protocol: 'responses', streaming: false, reasoningSummary: false }, [], signal(), () => {})).rejects.toThrow('截断或拒绝');
    expect(requests[0].body.reasoning ?? {}).not.toHaveProperty('summary'); expect(requests[0].body.reasoning ?? {}).not.toHaveProperty('effort');
  });
  it('passes explicitly selected Chat Completions effort and output budget through the SDK', async () => {
    const { connection, requests } = await endpoint((_req, res) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(event('答复', 'stop') + 'data: [DONE]\n\n'));
    await generate({ ...connection, reasoningEffort: 'high', maxOutputTokens: 8192 }, [], signal(), () => {});
    expect(requests[0].body).toMatchObject({ reasoning_effort: 'high', max_tokens: 8192 });
  });
  it('streams byte-fragmented UTF-8, multiline SSE, usage and finish metadata through the SDK', async () => {
    const { connection, requests } = await endpoint((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const packet = ': heartbeat\r\ndata: {"choices":[{"index":0,"delta":{\r\ndata: "role":"assistant","content":"你好🌱"},"finish_reason":null}]}\r\n\r\n'
        + event('', 'stop') + 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\ndata: [DONE]\n\n';
      for (const byte of Buffer.from(packet)) res.write(Buffer.from([byte])); res.end();
    });
    let shown = ''; expect(await generate(connection, [{ role: 'system', content: '角色设定' }, { role: 'user', content: '你好' }], signal(), delta => { shown += delta; })).toBe('你好🌱');
    expect(shown).toBe('你好🌱'); expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ path: '/v1/chat/completions', auth: 'Bearer fixture-only-secret', body: { model: 'fixture-model', stream: true, max_tokens: 12288, messages: [{ role: 'system', content: '角色设定' }, { role: 'user', content: '你好' }] } });
    expect(requests[0].body).not.toHaveProperty('stream_options');
  });
  it('uses an explicit nonstream request, keeps compatible model names on Chat Completions and omits absent keys', async () => {
    const { connection, requests } = await endpoint((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '完整回复' }, finish_reason: 'stop' }] }));
    });
    let shown = ''; expect(await generate({ ...connection, apiKey: '', streaming: false, model: 'gpt-5-pro' }, [{ role: 'user', content: '你好' }], signal(), d => { shown += d; })).toBe('完整回复');
    expect(shown).toBe('完整回复'); expect(requests[0].path).toBe('/v1/chat/completions'); expect(requests[0].auth).toBeUndefined(); expect(requests[0].body.stream).toBe(false);
  });
  it.each([400, 401, 402, 403, 422, 429, 503])('redacts HTTP %i errors with bounded provider retries', async status => {
    const { connection, requests } = await endpoint((_req, res) => res.writeHead(status, { 'content-type': 'application/json' }).end('{"error":{"message":"private fixture-only-secret"}}'));
    const error = await generate(connection, [], signal(), () => {}).catch(e => e);
    expect(error.message).not.toContain('private'); expect(error.message).not.toContain('fixture-only-secret'); expect(requests).toHaveLength(status === 429 || status === 503 ? 2 : 1); expect(error.httpStatus).toBe(status); expect(error.attempts).toBe(requests.length);
    expect(error.message).toContain(status === 401 || status === 403 ? '认证失败' : status === 429 ? '额度或频率' : status === 402 ? '余额不足' : String(status));
  });
  it.each([true, false])('recovers a first transient HTTP failure through the SDK without duplicated deltas (stream=%s)', async streaming => {
    let attempt = 0;
    const { connection, requests } = await endpoint((_req, res) => {
      if (++attempt === 1) { res.writeHead(503, { 'content-type': 'application/json', 'retry-after-ms': '1' }).end('{"error":{"message":"transient"}}'); return; }
      if (streaming) res.writeHead(200, { 'content-type': 'text/event-stream' }).end(event('一次回答', 'stop') + 'data: [DONE]\n\n');
      else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '一次回答' }, finish_reason: 'stop' }] }));
    });
    let shown = ''; const telemetry = vi.fn();
    expect(await generate({ ...connection, streaming }, [{role:'user', content:'首次问题'}], signal(), delta => { shown += delta; }, undefined, telemetry)).toBe('一次回答');
    expect(requests).toHaveLength(2); expect(shown).toBe('一次回答'); expect(requests[1].body.messages).toEqual(requests[0].body.messages); expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({attempts:2}));
  });
  it('does not replay a partially returned stream', async () => {
    const { connection, requests } = await endpoint((_req, res) => res.writeHead(200, {'content-type':'text/event-stream'}).end(event('已经显示一段')));
    let shown = ''; await expect(generate(connection, [], signal(), delta => { shown += delta; })).rejects.toThrow('没有正常结束'); expect(shown).toBe('已经显示一段'); expect(requests).toHaveLength(1);
  });
  it.each(['length', 'content_filter'])('rejects %s termination', async reason => {
    const { connection } = await endpoint((_req, res) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(event('半截回复', reason) + 'data: [DONE]\n\n'));
    await expect(generate(connection, [], signal(), () => {})).rejects.toThrow('截断或拒绝');
  });
  it('rejects a stream that ends without successful completion metadata', async () => {
    const { connection } = await endpoint((_req, res) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(event('看起来完整但连接已断')));
    await expect(generate(connection, [], signal(), () => {})).rejects.toThrow('没有正常结束');
  });
  it('aborts an in-flight SDK stream and closes the connection without late deltas', async () => {
    let closed!: () => void; const disconnected = new Promise<void>(done => { closed = done; });
    const { connection } = await endpoint((_req, res) => { res.on('close', closed); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(event('第一段')); });
    const controller = new AbortController(); let count = 0;
    await expect(generate(connection, [], controller.signal, () => { count++; controller.abort(); })).rejects.toBeDefined();
    await disconnected; expect(count).toBe(1);
  });
  it('does not follow redirects or forward credentials to another endpoint', async () => {
    const { connection, requests } = await endpoint((_req, res) => res.writeHead(307, { location: '/other' }).end());
    await expect(generate(connection, [], signal(), () => {})).rejects.toThrow('HTTP 307'); expect(requests).toHaveLength(1);
  });
  it('rejects oversized output and releases the request', async () => {
    const { connection } = await endpoint((_req, res) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(event('x'.repeat(36001), 'stop') + 'data: [DONE]\n\n'));
    await expect(generate(connection, [], signal(), () => {})).rejects.toThrow('回复过长');
  });
});

describe('library JSON parsing and application reply validation', () => {
  const pack = loadPack(resolve('characters'), 'yoshino');
  it('uses only top-level text consistently for draft and final reply', () => {
    const raw = '{"metadata":{"text":"不该显示"},"text":"真正台词"}';
    expect(visibleDraft(raw)).toBe('真正台词'); expect(parseReply(raw, pack).text).toBe('真正台词');
    expect(visibleDraft('{"metadata":{"text":"不该显示"},"text":"真正')).toBe('真正');
  });
  it('handles fenced partial JSON and escapes, but never treats an array or truncated JSON as a completed reply', () => {
    expect(visibleDraft('```json\n{"text":"第一行\\n\\u4f60')).toBe('第一行\n你');
    expect(visibleDraft('[{"text":"数组台词"}]')).toBe(''); expect(() => parseReply('[{"text":"数组台词"}]', pack)).toThrow('结构不完整');
    expect(() => parseReply('{"text":"半截', pack)).toThrow('结构不完整');
    expect(parseReply('```json\n{"text":"完整"}\n```', pack).text).toBe('完整');
  });
});
