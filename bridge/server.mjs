import http from 'node:http';
import { createReadStream, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';

const bridgeDir = fileURLToPath(new URL('.', import.meta.url));
const projectDir = resolve(bridgeDir, '..');
const webDir = join(projectDir, 'spine');
const envPath = join(bridgeDir, '.env');
const settingsPath = join(bridgeDir, 'settings.json');
if (existsSync(envPath)) loadEnvFile(envPath);

const TTS_ADAPTERS = new Set(['mimo-sse', 'http-wav', 'gpt-sovits-stream', 'raw-pcm']);
const MIMO_PROFILE_ID = 'mimo-bingtang';
const HF_PROFILE_ID = 'hf-ryza-asmr';
const GPT_SOVITS_PROFILE_ID = 'gpt-sovits-v2-local';

function completeChatCompletionsUrl(value) {
  const url = String(value || '').trim().replace(/\/+$/, '');
  return url.endsWith('/chat/completions') ? url : `${url}/chat/completions`;
}

function presetProfiles() {
  return [
    {
      id: MIMO_PROFILE_ID,
      name: 'MiMo 冰糖',
      adapter: 'mimo-sse',
      url: completeChatCompletionsUrl(process.env.MIMO_BASE_URL || 'https://api.xiaomimimo.com/v1'),
      method: 'POST',
      key: process.env.MIMO_API_KEY || '',
      model: process.env.MIMO_TTS_MODEL || 'mimo-v2.5-tts',
      voice: process.env.MIMO_TTS_VOICE || '冰糖',
      instruction: '请使用自然、亲切、清晰的中文语音朗读。',
      headers: '{"Content-Type":"application/json"}',
      bodyTemplate: '{"model":{{JSON.stringify(model)}},"messages":[{"role":"user","content":{{JSON.stringify(instruction)}}},{"role":"assistant","content":{{JSON.stringify(speakText)}}}],"audio":{"format":"pcm16","voice":{{JSON.stringify(voice)}}},"stream":true}',
      responseContentType: 'text/event-stream',
      format: 'int16',
      sampleRate: 24000,
      channels: 1,
      concurrency: 1,
      streaming: true,
    },
    {
      id: HF_PROFILE_ID,
      name: '莱莎 CN（ASMR）- HF 云端',
      adapter: 'http-wav',
      url: 'https://example.invalid/v1/tts',
      method: 'POST',
      key: '',
      model: '',
      voice: 'zh_ryza_asmr',
      instruction: '',
      headers: '{"Content-Type":"application/json"}',
      bodyTemplate: '{"text":{{JSON.stringify(speakText)}},"voice_id":"zh_ryza_asmr","language":"zh","response_format":"wav","speed_factor":1.0,"text_split_method":"cut0"}',
      responseContentType: 'audio/wav',
      format: 'int16',
      sampleRate: 32000,
      channels: 1,
      concurrency: 1,
      streaming: false,
    },
    {
      id: GPT_SOVITS_PROFILE_ID,
      name: '本地 GPT-SoVITS v2',
      adapter: 'gpt-sovits-stream',
      url: 'http://127.0.0.1:9880/tts',
      method: 'POST',
      key: '',
      model: 'GPT-SoVITS v2',
      voice: '莱莎',
      instruction: '',
      headers: '{"Content-Type":"application/json"}',
      bodyTemplate: '{"text":{{JSON.stringify(speakText)}},"text_lang":"zh","ref_audio_path":"","prompt_lang":"zh","prompt_text":"","text_split_method":"cut5","batch_size":1,"media_type":"wav","streaming_mode":true}',
      responseContentType: 'audio/wav',
      format: 'int16',
      sampleRate: 32000,
      channels: 1,
      concurrency: 1,
      streaming: true,
    },
  ];
}

const config = {
  port: Number(process.env.PORT || 18766),
  llm: {
    name: 'DeepSeek',
    url: completeChatCompletionsUrl(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'),
    method: 'POST',
    key: process.env.DEEPSEEK_API_KEY || '',
    headers: '{}',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
    extraBody: '{}',
    thinking: true,
    reasoningEffort: 'low',
    temperature: 0.8,
    maxTokens: 1200,
    responseFormat: true,
  },
  tts: { activeProfileId: MIMO_PROFILE_ID, profiles: presetProfiles() },
  mouthSensitivity: 1.6,
  mouthAttackMs: 90,
  mouthReleaseMs: 150,
  mouthMinHoldMs: 100,
  mouthMixMs: 80,
};

let systemPrompt = readFileSync(join(bridgeDir, 'character-prompt.md'), 'utf8');

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function stringSetting(source, key, fallback, label, { allowEmpty = true, trim = true } = {}) {
  if (!own(source, key)) return fallback;
  if (typeof source[key] !== 'string') throw validationError(`${label} 必须是字符串`);
  const value = trim ? source[key].trim() : source[key];
  if (!allowEmpty && !value) throw validationError(`${label} 不能为空`);
  return value;
}

function validHttpUrl(value, label) {
  let parsed;
  try { parsed = new URL(value); } catch { throw validationError(`${label} 不是有效 URL`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw validationError(`${label} 只支持 http/https`);
  return value;
}

function validMethod(value, label) {
  const method = String(value).trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]*$/.test(method)) throw validationError(`${label} 不是有效 HTTP method`);
  return method;
}

function jsonObjectString(value, label, { stringValues = false } = {}) {
  if (typeof value !== 'string') throw validationError(`${label} 必须是 JSON 字符串`);
  const source = value.trim();
  let parsed;
  try { parsed = JSON.parse(source); } catch { throw validationError(`${label} 不是有效 JSON`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw validationError(`${label} 必须是 JSON 对象`);
  if (stringValues && Object.values(parsed).some(item => typeof item !== 'string')) {
    throw validationError(`${label} 的值必须都是字符串`);
  }
  return { source, parsed };
}

function renderBodyTemplate(template, values) {
  const rendered = template
    .replace(/\{\{\s*JSON\.stringify\(\s*(speakText|text|model|voice|instruction)\s*\)\s*\}\}/g, (_match, key) => JSON.stringify(values[key] ?? ''))
    .replace(/\{\{\s*(speakText|text|model|voice|instruction)\s*\}\}/g, (_match, key) => JSON.stringify(values[key] ?? '').slice(1, -1));
  if (/\{\{[^{}]*\}\}/.test(rendered)) throw validationError('bodyTemplate 包含不支持的模板表达式');
  let body;
  try { body = JSON.parse(rendered); } catch { throw validationError('bodyTemplate 渲染后必须是有效 JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw validationError('bodyTemplate 渲染后必须是 JSON 对象');
  return body;
}

function normalizeLlm(value, fallback) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validationError('llm 必须是对象');
  const legacy = !['name', 'method', 'headers', 'extraBody', 'responseFormat'].some(key => own(value, key));
  const rawUrl = stringSetting(value, 'url', fallback.url, 'llm.url', { allowEmpty: false });
  const url = validHttpUrl(legacy ? completeChatCompletionsUrl(rawUrl) : rawUrl, 'llm.url');
  const temperature = own(value, 'temperature') ? Number(value.temperature) : fallback.temperature;
  const maxTokens = own(value, 'maxTokens') ? Number(value.maxTokens) : fallback.maxTokens;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw validationError('llm.temperature 必须是 0 到 2 的数字');
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 1_000_000) throw validationError('llm.maxTokens 必须是 1 到 1000000 的整数');
  const thinking = own(value, 'thinking') ? value.thinking : fallback.thinking;
  const responseFormat = own(value, 'responseFormat') ? value.responseFormat : fallback.responseFormat;
  if (typeof thinking !== 'boolean') throw validationError('llm.thinking 必须是布尔值');
  if (typeof responseFormat !== 'boolean') throw validationError('llm.responseFormat 必须是布尔值');
  const headers = stringSetting(value, 'headers', fallback.headers, 'llm.headers', { allowEmpty: false, trim: false });
  const extraBody = stringSetting(value, 'extraBody', fallback.extraBody, 'llm.extraBody', { allowEmpty: false, trim: false });
  jsonObjectString(headers, 'llm.headers', { stringValues: true });
  jsonObjectString(extraBody, 'llm.extraBody');
  return {
    name: stringSetting(value, 'name', fallback.name, 'llm.name', { allowEmpty: false }),
    url,
    method: validMethod(stringSetting(value, 'method', fallback.method, 'llm.method', { allowEmpty: false }), 'llm.method'),
    key: stringSetting(value, 'key', fallback.key, 'llm.key'),
    headers: headers.trim(),
    model: stringSetting(value, 'model', fallback.model, 'llm.model', { allowEmpty: false }),
    extraBody: extraBody.trim(),
    thinking,
    reasoningEffort: stringSetting(value, 'reasoningEffort', fallback.reasoningEffort, 'llm.reasoningEffort'),
    temperature,
    maxTokens,
    responseFormat,
  };
}

function normalizeProfile(value, index) {
  const at = `tts.profiles[${index}]`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validationError(`${at} 必须是对象`);
  const id = stringSetting(value, 'id', '', `${at}.id`, { allowEmpty: false });
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw validationError(`${at}.id 只能包含字母、数字、点、下划线和连字符`);
  const adapter = stringSetting(value, 'adapter', '', `${at}.adapter`, { allowEmpty: false });
  if (!TTS_ADAPTERS.has(adapter)) throw validationError(`${at}.adapter 不受支持`);
  const url = validHttpUrl(stringSetting(value, 'url', '', `${at}.url`, { allowEmpty: false }), `${at}.url`);
  const headers = stringSetting(value, 'headers', '', `${at}.headers`, { allowEmpty: false, trim: false });
  jsonObjectString(headers, `${at}.headers`, { stringValues: true });
  const bodyTemplate = stringSetting(value, 'bodyTemplate', '', `${at}.bodyTemplate`, { allowEmpty: false, trim: false });
  renderBodyTemplate(bodyTemplate, { speakText: '测试文本', text: '测试文本', model: 'test-model', voice: 'test-voice', instruction: '测试语音提示词' });
  const responseContentType = stringSetting(value, 'responseContentType', '', `${at}.responseContentType`, { allowEmpty: false });
  if (!/^[^\s/;]+\/[^\s;]+(?:\s*;.*)?$/.test(responseContentType)) throw validationError(`${at}.responseContentType 不是有效 MIME 类型`);
  const format = stringSetting(value, 'format', '', `${at}.format`, { allowEmpty: false }).toLowerCase();
  if (!['int16', 'float32'].includes(format)) throw validationError(`${at}.format 只支持 int16/float32`);
  const sampleRate = Number(value.sampleRate);
  const channels = Number(value.channels);
  const concurrency = Number(value.concurrency);
  if (!Number.isInteger(sampleRate) || sampleRate < 1000 || sampleRate > 768000) throw validationError(`${at}.sampleRate 必须是 1000 到 768000 的整数`);
  if (!Number.isInteger(channels) || channels < 1 || channels > 32) throw validationError(`${at}.channels 必须是 1 到 32 的整数`);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw validationError(`${at}.concurrency 必须是 1 到 32 的整数`);
  if (id === HF_PROFILE_ID && concurrency !== 1) throw validationError('HF 莱莎档案 concurrency 固定为 1');
  if (typeof value.streaming !== 'boolean') throw validationError(`${at}.streaming 必须是布尔值`);
  return {
    id,
    name: stringSetting(value, 'name', '', `${at}.name`, { allowEmpty: false }),
    adapter,
    url,
    method: validMethod(stringSetting(value, 'method', '', `${at}.method`, { allowEmpty: false }), `${at}.method`),
    key: stringSetting(value, 'key', '', `${at}.key`),
    model: stringSetting(value, 'model', '', `${at}.model`),
    voice: stringSetting(value, 'voice', '', `${at}.voice`),
    instruction: stringSetting(value, 'instruction', '', `${at}.instruction`, { trim: false }),
    headers: headers.trim(),
    bodyTemplate,
    responseContentType,
    format,
    sampleRate,
    channels,
    concurrency,
    streaming: value.streaming,
  };
}

function migrateLegacyTts(value) {
  const profiles = presetProfiles();
  const mimo = profiles.find(profile => profile.id === MIMO_PROFILE_ID);
  if (own(value, 'url')) mimo.url = completeChatCompletionsUrl(stringSetting(value, 'url', mimo.url, 'tts.url', { allowEmpty: false }));
  if (own(value, 'key')) mimo.key = stringSetting(value, 'key', mimo.key, 'tts.key');
  if (own(value, 'model')) mimo.model = stringSetting(value, 'model', mimo.model, 'tts.model');
  if (own(value, 'voice')) mimo.voice = stringSetting(value, 'voice', mimo.voice, 'tts.voice');
  return normalizeTts({ activeProfileId: MIMO_PROFILE_ID, profiles });
}

function normalizeTts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validationError('tts 必须是对象');
  if (!own(value, 'profiles') && ['url', 'key', 'model', 'voice'].some(key => own(value, key))) return migrateLegacyTts(value);
  if (!Array.isArray(value.profiles) || !value.profiles.length) throw validationError('tts.profiles 至少需要一个 profile');
  const profiles = value.profiles.map(normalizeProfile);
  const ids = new Set();
  for (const profile of profiles) {
    if (ids.has(profile.id)) throw validationError(`tts profile id 重复：${profile.id}`);
    ids.add(profile.id);
  }
  const activeProfileId = stringSetting(value, 'activeProfileId', '', 'tts.activeProfileId', { allowEmpty: false });
  if (!ids.has(activeProfileId)) throw validationError('tts.activeProfileId 必须指向现有 profile');
  return { activeProfileId, profiles };
}

function normalizeSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validationError('settings 必须是对象');
  const llm = own(value, 'llm') ? normalizeLlm(value.llm, config.llm) : config.llm;
  const tts = own(value, 'tts') ? normalizeTts(value.tts) : config.tts;
  let mouthSensitivity = config.mouthSensitivity;
  let mouthAttackMs = config.mouthAttackMs;
  let mouthReleaseMs = config.mouthReleaseMs;
  let mouthMinHoldMs = config.mouthMinHoldMs;
  let mouthMixMs = config.mouthMixMs;
  if (own(value, 'performance')) {
    if (!value.performance || typeof value.performance !== 'object' || Array.isArray(value.performance)) throw validationError('performance 必须是对象');
    if (own(value.performance, 'mouthSensitivity')) {
      mouthSensitivity = Number(value.performance.mouthSensitivity);
      if (!Number.isFinite(mouthSensitivity) || mouthSensitivity < 0.25 || mouthSensitivity > 4) {
        throw validationError('performance.mouthSensitivity 必须是 0.25 到 4 的数字');
      }
    }
    if (own(value.performance, 'mouthAttackMs')) mouthAttackMs = Number(value.performance.mouthAttackMs);
    if (own(value.performance, 'mouthReleaseMs')) mouthReleaseMs = Number(value.performance.mouthReleaseMs);
    if (own(value.performance, 'mouthMinHoldMs')) mouthMinHoldMs = Number(value.performance.mouthMinHoldMs);
    if (own(value.performance, 'mouthMixMs')) mouthMixMs = Number(value.performance.mouthMixMs);
    if (!Number.isFinite(mouthAttackMs) || mouthAttackMs < 10 || mouthAttackMs > 1000) throw validationError('performance.mouthAttackMs 必须是 10 到 1000 毫秒');
    if (!Number.isFinite(mouthReleaseMs) || mouthReleaseMs < 10 || mouthReleaseMs > 2000) throw validationError('performance.mouthReleaseMs 必须是 10 到 2000 毫秒');
    if (!Number.isFinite(mouthMinHoldMs) || mouthMinHoldMs < 0 || mouthMinHoldMs > 1000) throw validationError('performance.mouthMinHoldMs 必须是 0 到 1000 毫秒');
    if (!Number.isFinite(mouthMixMs) || mouthMixMs < 0 || mouthMixMs > 500) throw validationError('performance.mouthMixMs 必须是 0 到 500 毫秒');
  }
  if (own(value, 'systemPrompt') && typeof value.systemPrompt !== 'string') throw validationError('systemPrompt 必须是字符串');
  return { llm, tts, mouthSensitivity, mouthAttackMs, mouthReleaseMs, mouthMinHoldMs, mouthMixMs, systemPrompt: own(value, 'systemPrompt') ? value.systemPrompt : systemPrompt };
}

function installSettings(value) {
  config.llm = value.llm;
  config.tts = value.tts;
  config.mouthSensitivity = value.mouthSensitivity;
  config.mouthAttackMs = value.mouthAttackMs;
  config.mouthReleaseMs = value.mouthReleaseMs;
  config.mouthMinHoldMs = value.mouthMinHoldMs;
  config.mouthMixMs = value.mouthMixMs;
  systemPrompt = value.systemPrompt;
}

function applySettings(value) {
  installSettings(normalizeSettings(value));
}

if (existsSync(settingsPath)) {
  try { applySettings(JSON.parse(readFileSync(settingsPath, 'utf8'))); }
  catch (error) { console.warn(`settings.json 读取失败，使用默认配置：${error.message}`); }
}

function settingsView(value = {
  llm: config.llm,
  tts: config.tts,
  mouthSensitivity: config.mouthSensitivity,
  mouthAttackMs: config.mouthAttackMs,
  mouthReleaseMs: config.mouthReleaseMs,
  mouthMinHoldMs: config.mouthMinHoldMs,
  mouthMixMs: config.mouthMixMs,
  systemPrompt,
}) {
  return {
    llm: { ...value.llm },
    tts: { activeProfileId: value.tts.activeProfileId, profiles: value.tts.profiles.map(profile => ({ ...profile })) },
    performance: {
      mouthSensitivity: value.mouthSensitivity,
      mouthAttackMs: value.mouthAttackMs,
      mouthReleaseMs: value.mouthReleaseMs,
      mouthMinHoldMs: value.mouthMinHoldMs,
      mouthMixMs: value.mouthMixMs,
    },
    systemPrompt: value.systemPrompt,
  };
}

function currentSettings() {
  return settingsView();
}

function saveSettings(value) {
  const next = normalizeSettings(value);
  const saved = settingsView(next);
  const temporaryPath = `${settingsPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(saved, null, 2)}\n`, { encoding: 'utf8', flush: true });
    renameSync(temporaryPath, settingsPath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* 临时文件可能尚未创建。 */ }
    throw error;
  }
  installSettings(next);
  return currentSettings();
}

const allowed = {
  emotion: new Set(['neutral', 'happy', 'laughing', 'angry', 'sad', 'crying', 'shy', 'tease', 'cuddle']),
  intensity: new Set(['weak', 'normal', 'strong']),
  attitude: new Set(['idle', 'agree', 'deny', 'question']),
};
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.skel': 'application/octet-stream',
  '.atlas': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.m4a': 'audio/mp4',
  '.ico': 'image/x-icon',
};
const emotionStyles = {
  neutral: '自然、亲切、放松',
  happy: '开心、明亮、有活力',
  laughing: '愉快、带笑意，但保持清晰',
  angry: '明显不满、语气有力，但不要喊叫',
  sad: '低落、轻柔、稍慢',
  crying: '难过、略带哽咽感，但保持可听清',
  shy: '害羞、轻柔、稍微迟疑',
  tease: '俏皮、带一点调侃',
  cuddle: '亲昵、温柔、靠近耳边的感觉',
};

function assertLocalApiRequest(request) {
  let authority;
  try { authority = new URL(`http://${request.headers.host || ''}`); }
  catch { throw httpError(403, '拒绝无效 Host'); }
  const hostname = authority.hostname.toLowerCase();
  const port = Number(authority.port || 80);
  if (!['127.0.0.1', 'localhost'].includes(hostname) || port !== config.port) throw httpError(403, 'API 仅接受本机 Host');

  const origin = request.headers.origin;
  if (origin) {
    let parsed;
    try { parsed = new URL(origin); } catch { throw httpError(403, '拒绝无效 Origin'); }
    const originPort = Number(parsed.port || (parsed.protocol === 'http:' ? 80 : 443));
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname.toLowerCase()) || originPort !== config.port) {
      throw httpError(403, '拒绝跨站 API 请求');
    }
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') throw httpError(403, '拒绝跨站 API 请求');
  if (request.method === 'POST') {
    const contentType = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') throw httpError(415, 'API POST 只接受 application/json');
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function writeEvent(response, event) {
  if (!response.writableEnded && !response.destroyed) response.write(`${JSON.stringify(event)}\n`);
}

async function readJson(request, maxBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw validationError('请求内容过大');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw validationError('请求必须是有效 JSON'); }
}

function cleanMessages(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
    .map(item => ({ role: item.role, content: item.content.trim().slice(0, 8000) }))
    .filter(item => item.content)
    .slice(-24);
}

function cleanActionCatalog(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .filter(item => item && /^group:\d+$/.test(item.id) && typeof item.label === 'string')
    .map(item => ({ id: item.id, label: item.label.trim().slice(0, 120) }))
    .filter(item => item.label && !seen.has(item.id) && seen.add(item.id))
    .slice(0, 160);
}

function actionPrompt(actions) {
  if (!actions.length) return '当前没有可用身体动作，action 必须为 none。';
  return `当前模型可用身体动作目录如下。action 只能选择准确 id 或 none；不要照抄标签到回复正文。\n${actions.map(item => `${item.id} = ${item.label}`).join('\n')}`;
}

function parseJsonContent(content) {
  if (typeof content !== 'string') throw new Error('LLM 没有返回文本');
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('LLM 没有返回有效 JSON');
  }
}

function fallbackText(content) {
  const cleaned = typeof content === 'string'
    ? content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : '';
  const textField = cleaned.match(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/s)?.[1];
  if (textField) {
    try { return JSON.parse(`"${textField}"`); } catch { /* 使用下面的安全回退。 */ }
  }
  if (cleaned && !/^[{[]/.test(cleaned)) {
    return cleaned
      .replace(/^@?莱莎\s*[:：]\s*/, '')
      .replace(/\[(?:emotion|attitude|tension):[^\]]+\]/g, '')
      .trim();
  }
  return '刚才有点走神了，不过我还在听。你可以继续说。';
}

function normalizeReply(value, actions = []) {
  const text = typeof value?.text === 'string' ? value.text.trim() : '';
  if (!text) throw new Error('LLM 回复正文为空');
  const emotion = allowed.emotion.has(value.emotion) ? value.emotion : 'neutral';
  const intensity = allowed.intensity.has(value.intensity) ? value.intensity : 'normal';
  const attitude = allowed.attitude.has(value.attitude) ? value.attitude : value.attitude === 'questioning' ? 'question' : 'idle';
  const number = Number(value.tension);
  const tension = Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0.5;
  const validActions = new Set(actions.map(item => item.id));
  const action = validActions.has(value.action) ? value.action : 'none';
  const hold = Number(value.actionHoldMs);
  const actionHoldMs = Number.isFinite(hold) ? Math.round(Math.min(8000, Math.max(800, hold))) : 2600;
  return { text: text.slice(0, 5000), emotion, intensity, attitude, tension, action, actionHoldMs };
}

function requestHeaders(settings, kind) {
  const custom = jsonObjectString(settings.headers, `${kind}.headers`, { stringValues: true }).parsed;
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const [name, value] of Object.entries(custom)) headers.set(name, value);
  const hasAuthorization = Object.keys(custom).some(name => name.toLowerCase() === 'authorization');
  if (kind === 'llm' && settings.key && !hasAuthorization) headers.set('Authorization', `Bearer ${settings.key}`);
  return { headers, custom };
}

async function callLlm(provider, turnSystemPrompt, messages, signal, strict = false, actions = []) {
  const { headers } = requestHeaders(provider, 'llm');
  const extraBody = jsonObjectString(provider.extraBody, 'llm.extraBody').parsed;
  const body = {
    model: provider.model,
    messages: [
      { role: 'system', content: turnSystemPrompt },
      { role: 'system', content: actionPrompt(actions) },
      ...(strict ? [{ role: 'system', content: '务必只输出一个完整、可被 JSON.parse 解析的 JSON 对象。不要输出 Markdown 或解释。' }] : []),
      ...messages,
    ],
    ...(provider.responseFormat ? { response_format: { type: 'json_object' } } : {}),
    thinking: { type: provider.thinking ? 'enabled' : 'disabled' },
    ...(provider.thinking && provider.reasoningEffort ? { reasoning_effort: provider.reasoningEffort } : {}),
    temperature: strict ? Math.min(0.2, provider.temperature) : provider.temperature,
    max_tokens: provider.maxTokens,
    ...extraBody,
  };
  const requestOptions = {
    method: provider.method,
    signal,
    headers,
  };
  if (!['GET', 'HEAD'].includes(provider.method)) requestOptions.body = JSON.stringify(body);
  const response = await fetch(provider.url, requestOptions);
  const responseBody = await response.text();
  if (!response.ok) throw new Error(`${provider.name} HTTP ${response.status}: ${responseBody.slice(0, 300)}`);
  let payload;
  try { payload = JSON.parse(responseBody); } catch { throw new Error(`${provider.name} 返回的响应不是有效 JSON`); }
  return payload.choices?.[0]?.message?.content;
}

async function requestLlm(provider, turnSystemPrompt, messages, signal, actions) {
  const firstContent = await callLlm(provider, turnSystemPrompt, messages, signal, false, actions);
  try {
    return normalizeReply(parseJsonContent(firstContent), actions);
  } catch {
    console.warn(`${provider.name} 返回格式无效，正在自动重试。`);
  }

  let retryContent = '';
  try {
    retryContent = await callLlm(provider, turnSystemPrompt, messages, signal, true, actions);
    return normalizeReply(parseJsonContent(retryContent), actions);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    console.warn(`${provider.name} 重试仍非 JSON，已回退为安全文本回复。`);
    return normalizeReply({ text: fallbackText(retryContent || firstContent) }, actions);
  }
}

function ttsInstruction(reply) {
  const strength = reply.intensity === 'strong' ? '情绪表现明显' : reply.intensity === 'weak' ? '情绪轻微克制' : '情绪自然';
  return `${emotionStyles[reply.emotion] || emotionStyles.neutral}；${strength}；语速稍慢，声音年轻自然，中文发音清楚。`;
}

function activeTtsProfile() {
  return config.tts.profiles.find(profile => profile.id === config.tts.activeProfileId) || null;
}

function publicProfile(profile) {
  return profile ? {
    id: profile.id,
    name: profile.name,
    adapter: profile.adapter,
    model: profile.model,
    voice: profile.voice,
    format: profile.format,
    sampleRate: profile.sampleRate,
    channels: profile.channels,
    concurrency: profile.concurrency,
    streaming: profile.streaming,
  } : null;
}

function profileConfigured(profile) {
  return Boolean(profile?.url);
}

function ttsHeaders(profile) {
  const { headers, custom } = requestHeaders(profile, 'tts profile');
  if (profile.responseContentType && !Object.keys(custom).some(name => name.toLowerCase() === 'accept')) {
    headers.set('Accept', profile.responseContentType);
  }
  const names = Object.keys(custom).map(name => name.toLowerCase());
  if (profile.key && !names.includes('authorization') && !names.includes('api-key')) {
    if (profile.adapter === 'mimo-sse') headers.set('api-key', profile.key);
    else headers.set('Authorization', `Bearer ${profile.key}`);
  }
  return headers;
}

async function ttsFetch(profile, reply, signal) {
  const speakText = reply.text;
  const body = renderBodyTemplate(profile.bodyTemplate, {
    speakText,
    text: reply.text,
    model: profile.model,
    voice: profile.voice,
    instruction: profile.instruction || ttsInstruction(reply),
  });
  const requestedMediaType = String(body.media_type || '').toLowerCase();
  if (profile.adapter === 'gpt-sovits-stream' && ['ogg', 'aac', 'm4a', 'mp3'].includes(requestedMediaType)) {
    throw new Error(`${profile.name} 不支持 ${requestedMediaType}；请改用 wav 或 raw`);
  }
  const requestOptions = {
    method: profile.method,
    signal,
    headers: ttsHeaders(profile),
  };
  if (!['GET', 'HEAD'].includes(profile.method)) requestOptions.body = JSON.stringify(body);
  const upstream = await fetch(profile.url, requestOptions);
  if (!upstream.ok) throw new Error(`${profile.name} HTTP ${upstream.status}: ${(await upstream.text()).slice(0, 300)}`);
  if (!upstream.body) throw new Error(`${profile.name} 没有返回响应内容`);
  const expected = profile.responseContentType.split(';')[0].trim().toLowerCase();
  const actual = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const wavAliases = new Set(['audio/wav', 'audio/x-wav', 'audio/wave']);
  if (!actual || (actual !== expected && !(wavAliases.has(actual) && wavAliases.has(expected)))) {
    throw new Error(`${profile.name} Content-Type 错误：期望 ${expected}，收到 ${actual || '缺失'}`);
  }
  return { upstream, requestBody: body };
}

function audioStart(response, profile, synthesisId, metadata) {
  writeEvent(response, {
    type: 'audio.start',
    synthesisId,
    profileId: profile.id,
    profileName: profile.name,
    sampleRate: metadata.sampleRate,
    channels: metadata.channels,
    format: metadata.format,
    voice: profile.voice,
  });
}

function audioChunk(response, synthesisId, order, chunk) {
  writeEvent(response, { type: 'audio.chunk', synthesisId, order, data: Buffer.from(chunk).toString('base64') });
}

function parseWaveFormat(fmt) {
  if (fmt.length < 16) throw new Error('WAV fmt chunk 不完整');
  let tag = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2);
  const sampleRate = fmt.readUInt32LE(4);
  const blockAlign = fmt.readUInt16LE(12);
  const bitsPerSample = fmt.readUInt16LE(14);
  if (tag === 0xfffe) {
    if (fmt.length < 40 || fmt.readUInt16LE(16) < 22) throw new Error('WAV extensible fmt chunk 不完整');
    const guid = fmt.subarray(24, 40);
    const canonicalTail = Buffer.from([0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]);
    if (!guid.subarray(4).equals(canonicalTail)) throw new Error('WAV extensible SubFormat 不受支持');
    tag = guid.readUInt16LE(0);
  }
  const format = tag === 1 && bitsPerSample === 16 ? 'int16' : tag === 3 && bitsPerSample === 32 ? 'float32' : null;
  if (!format) throw new Error(`WAV 仅支持 PCM16/Float32，收到 format=${tag}, bits=${bitsPerSample}`);
  if (!channels || !sampleRate || blockAlign !== channels * (bitsPerSample / 8)) throw new Error('WAV fmt 元数据无效');
  return { format, channels, sampleRate, blockAlign };
}

function findWaveData(buffer, requireComplete) {
  if (buffer.length < 12) return requireComplete ? (() => { throw new Error('WAV RIFF header 不完整'); })() : null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('响应不是 RIFF/WAVE；请确认服务返回 wav');
  let offset = 12;
  let metadata = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'data') {
      if (!metadata) throw new Error('WAV data chunk 出现在 fmt chunk 之前');
      if (requireComplete && size !== 0xffffffff && start + size > buffer.length) throw new Error('WAV data chunk 不完整');
      return { metadata, dataOffset: start, dataLength: size === 0xffffffff ? buffer.length - start : Math.min(size, buffer.length - start) };
    }
    if (size === 0xffffffff || start + size > buffer.length) {
      if (requireComplete) throw new Error(`WAV ${id || 'unknown'} chunk 不完整`);
      return null;
    }
    if (id === 'fmt ') metadata = parseWaveFormat(buffer.subarray(start, start + size));
    offset = start + size + (size & 1);
  }
  if (requireComplete) throw new Error('WAV 缺少 fmt 或 data chunk');
  return null;
}

function parseWave(buffer) {
  const parsed = findWaveData(buffer, true);
  if (!parsed.dataLength) throw new Error('WAV data chunk 为空');
  if (parsed.dataLength % parsed.metadata.blockAlign !== 0) throw new Error('WAV data chunk 结尾不是完整音频帧');
  return { metadata: parsed.metadata, data: buffer.subarray(parsed.dataOffset, parsed.dataOffset + parsed.dataLength) };
}

function unsupportedCompressedAudio(profile, upstream) {
  const format = profile.format.toLowerCase();
  const type = (upstream.headers.get('content-type') || '').toLowerCase();
  if (/^(?:ogg|aac|m4a|mp3)$/.test(format) || /(?:ogg|aac|mpeg|mp4)/.test(type)) {
    throw new Error(`${profile.name} 返回 ${type || format}；当前只支持 wav/raw，请改用 wav 或 raw`);
  }
}

function emitBuffer(response, synthesisId, buffer, blockAlign = 1, startOrder = 0) {
  if (buffer.length % blockAlign !== 0) throw new Error('PCM 数据结尾不是完整音频帧');
  let order = startOrder;
  const target = Math.max(blockAlign, Math.floor(64 * 1024 / blockAlign) * blockAlign);
  for (let offset = 0; offset < buffer.length; offset += target) {
    audioChunk(response, synthesisId, order++, buffer.subarray(offset, Math.min(buffer.length, offset + target)));
  }
  return order;
}

async function streamAlignedBody(body, response, synthesisId, blockAlign) {
  const reader = body.getReader();
  let carry = Buffer.alloc(0);
  let order = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const combined = carry.length ? Buffer.concat([carry, Buffer.from(value)]) : Buffer.from(value);
    const complete = combined.length - (combined.length % blockAlign);
    if (complete) order = emitBuffer(response, synthesisId, combined.subarray(0, complete), blockAlign, order);
    carry = combined.subarray(complete);
  }
  if (carry.length) throw new Error('raw PCM 响应结尾不是完整音频帧');
  if (!order) throw new Error('服务没有返回音频数据');
  return order;
}

function validBase64(value) {
  const compact = value.replace(/\s/g, '');
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return false;
  try { return Buffer.from(compact, 'base64').length > 0; } catch { return false; }
}

async function streamMimoSse(profile, reply, response, signal, synthesisId) {
  const { upstream } = await ttsFetch(profile, reply, signal);
  audioStart(response, profile, synthesisId, { sampleRate: profile.sampleRate, channels: profile.channels, format: profile.format === 'float32' ? 'float32' : 'int16' });
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let order = 0;
  const consume = line => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let payload;
    try { payload = JSON.parse(data); } catch { throw new Error(`${profile.name} 返回了无效 SSE JSON`); }
    const audio = payload.choices?.[0]?.delta?.audio?.data;
    if (typeof audio === 'string' && audio) {
      if (!validBase64(audio)) throw new Error(`${profile.name} 返回了无效 Base64 音频分片`);
      writeEvent(response, { type: 'audio.chunk', synthesisId, order: order++, data: audio });
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) consume(line);
  }
  buffer += decoder.decode();
  if (buffer) consume(buffer);
  if (!order) throw new Error(`${profile.name} 没有返回音频分片`);
  writeEvent(response, { type: 'audio.end', synthesisId, chunks: order });
}

async function streamHttpWav(profile, reply, response, signal, synthesisId) {
  const { upstream } = await ttsFetch(profile, reply, signal);
  unsupportedCompressedAudio(profile, upstream);
  const wav = parseWave(Buffer.from(await upstream.arrayBuffer()));
  audioStart(response, profile, synthesisId, wav.metadata);
  const order = emitBuffer(response, synthesisId, wav.data, wav.metadata.blockAlign);
  writeEvent(response, { type: 'audio.end', synthesisId, chunks: order });
}

function rawMetadata(profile) {
  const value = profile.format.toLowerCase();
  if (/^(?:float32|f32|pcm-f32)$/.test(value)) return { format: 'float32', sampleRate: profile.sampleRate, channels: profile.channels, blockAlign: profile.channels * 4 };
  if (/^(?:raw|raw-pcm|pcm|pcm16|int16|s16le)$/.test(value)) return { format: 'int16', sampleRate: profile.sampleRate, channels: profile.channels, blockAlign: profile.channels * 2 };
  throw new Error(`${profile.name} 的 raw PCM format 不受支持：${profile.format}`);
}

async function streamRawPcm(profile, reply, response, signal, synthesisId) {
  const { upstream } = await ttsFetch(profile, reply, signal);
  unsupportedCompressedAudio(profile, upstream);
  const metadata = rawMetadata(profile);
  audioStart(response, profile, synthesisId, metadata);
  const chunks = await streamAlignedBody(upstream.body, response, synthesisId, metadata.blockAlign);
  writeEvent(response, { type: 'audio.end', synthesisId, chunks });
}

async function streamWaveBody(profile, upstream, response, synthesisId) {
  const reader = upstream.body.getReader();
  let pending = Buffer.alloc(0);
  let parsed = null;
  let order = 0;
  let carry = Buffer.alloc(0);
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    if (!parsed) {
      pending = Buffer.concat([pending, chunk]);
      parsed = findWaveData(pending, false);
      if (!parsed) continue;
      audioStart(response, profile, synthesisId, parsed.metadata);
      carry = pending.subarray(parsed.dataOffset);
      pending = Buffer.alloc(0);
    } else {
      carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    }
    const complete = carry.length - (carry.length % parsed.metadata.blockAlign);
    if (complete) order = emitBuffer(response, synthesisId, carry.subarray(0, complete), parsed.metadata.blockAlign, order);
    carry = carry.subarray(complete);
  }
  if (!parsed) throw new Error(`${profile.name} 没有返回完整 WAV header`);
  if (carry.length) throw new Error(`${profile.name} WAV 流结尾不是完整音频帧`);
  if (!order) throw new Error(`${profile.name} 没有返回音频数据`);
  writeEvent(response, { type: 'audio.end', synthesisId, chunks: order });
}

async function streamGptSovits(profile, reply, response, signal, synthesisId) {
  const { upstream, requestBody } = await ttsFetch(profile, reply, signal);
  unsupportedCompressedAudio(profile, upstream);
  const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
  const mediaType = String(requestBody.media_type || (contentType.includes('wav') ? 'wav' : 'raw')).toLowerCase();
  if (mediaType === 'wav') {
    const streaming = typeof requestBody.streaming_mode === 'boolean' ? requestBody.streaming_mode : profile.streaming;
    if (streaming) return streamWaveBody(profile, upstream, response, synthesisId);
    const wav = parseWave(Buffer.from(await upstream.arrayBuffer()));
    audioStart(response, profile, synthesisId, wav.metadata);
    const chunks = emitBuffer(response, synthesisId, wav.data, wav.metadata.blockAlign);
    return writeEvent(response, { type: 'audio.end', synthesisId, chunks });
  }
  const metadata = rawMetadata(profile);
  audioStart(response, profile, synthesisId, metadata);
  const chunks = await streamAlignedBody(upstream.body, response, synthesisId, metadata.blockAlign);
  writeEvent(response, { type: 'audio.end', synthesisId, chunks });
}

const profileQueues = new Map();

function abortError() {
  const error = new Error('操作已取消');
  error.name = 'AbortError';
  return error;
}

function pumpProfileQueue(state) {
  while (state.active < state.limit && state.pending.length) {
    const item = state.pending.shift();
    item.signal?.removeEventListener('abort', item.onAbort);
    if (item.signal?.aborted) {
      item.reject(abortError());
      continue;
    }
    state.active += 1;
    Promise.resolve().then(item.job).then(item.resolve, item.reject).finally(() => {
      state.active -= 1;
      pumpProfileQueue(state);
    });
  }
}

function enqueueProfile(profile, signal, job) {
  let state = profileQueues.get(profile.id);
  if (!state) {
    state = { active: 0, limit: profile.concurrency, pending: [] };
    profileQueues.set(profile.id, state);
  }
  state.limit = profile.concurrency;
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(abortError());
    const item = { signal, job, resolve: resolvePromise, reject, onAbort: null };
    item.onAbort = () => {
      const index = state.pending.indexOf(item);
      if (index >= 0) state.pending.splice(index, 1);
      reject(abortError());
    };
    signal?.addEventListener('abort', item.onAbort, { once: true });
    state.pending.push(item);
    pumpProfileQueue(state);
  });
}

async function synthesize(profile, reply, response, signal, synthesisId) {
  const adapters = {
    'mimo-sse': streamMimoSse,
    'http-wav': streamHttpWav,
    'gpt-sovits-stream': streamGptSovits,
    'raw-pcm': streamRawPcm,
  };
  const adapter = adapters[profile.adapter];
  if (!adapter) throw new Error(`不支持的 TTS adapter：${profile.adapter}`);
  return enqueueProfile(profile, signal, () => adapter(profile, reply, response, signal, synthesisId));
}

async function handleChat(request, response) {
  const controller = new AbortController();
  response.on('close', () => controller.abort());
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return sendJson(response, error.statusCode || 400, { error: error.message });
  }

  const messages = cleanMessages(body.messages);
  const actions = cleanActionCatalog(body.actions);
  if (!messages.length || messages.at(-1).role !== 'user') return sendJson(response, 400, { error: '缺少用户消息' });

  const turnLlm = { ...config.llm };
  const turnSystemPrompt = systemPrompt;
  const activeProfile = activeTtsProfile();
  const turnProfile = activeProfile ? { ...activeProfile } : null;

  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });

  const turnId = randomUUID();
  writeEvent(response, { type: 'turn.start', turnId });
  try {
    const reply = await requestLlm(turnLlm, turnSystemPrompt, messages, controller.signal, actions);
    writeEvent(response, { type: 'reply', turnId, text: reply.text, performance: reply });

    if (body.tts !== false && turnProfile && profileConfigured(turnProfile)) {
      const synthesisId = randomUUID();
      try {
        await synthesize(turnProfile, reply, response, controller.signal, synthesisId);
      } catch (error) {
        if (error.name !== 'AbortError') writeEvent(response, { type: 'error', stage: 'tts', message: error.message });
      }
    }
    writeEvent(response, { type: 'turn.end', turnId });
  } catch (error) {
    if (error.name !== 'AbortError') writeEvent(response, { type: 'error', stage: 'llm', message: error.message });
  } finally {
    if (!response.writableEnded) response.end();
  }
}

function safeStaticPath(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
  if (decoded === '/') decoded = '/index.html';
  const relative = normalize(decoded).replace(/^[/\\]+/, '');
  const target = resolve(webDir, relative);
  return target === webDir || target.startsWith(`${webDir}${sep}`) ? target : null;
}

function serveStatic(request, response) {
  const target = safeStaticPath(request.url || '/');
  if (!target || !existsSync(target) || !statSync(target).isFile()) return sendJson(response, 404, { error: 'Not found' });
  const size = statSync(target).size;
  response.writeHead(200, {
    'Content-Type': mimeTypes[extname(target).toLowerCase()] || 'application/octet-stream',
    'Content-Length': size,
    'Cache-Control': ['.html', '.js', '.css'].includes(extname(target).toLowerCase()) ? 'no-cache' : 'public, max-age=3600',
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(target).pipe(response);
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.url?.startsWith('/api/')) assertLocalApiRequest(request);
    if (request.method === 'GET' && request.url === '/api/status') {
      const profile = activeTtsProfile();
      return sendJson(response, 200, {
        ok: true,
        llm: {
          configured: Boolean(config.llm.url && config.llm.model),
          name: config.llm.name,
          model: config.llm.model,
          thinking: config.llm.thinking,
          reasoningEffort: config.llm.thinking ? config.llm.reasoningEffort : 'off',
        },
        tts: {
          configured: profileConfigured(profile),
          name: profile?.name || '',
          activeProfileId: config.tts.activeProfileId,
          activeProfile: publicProfile(profile),
          model: profile?.model || '',
          voice: profile?.voice || '',
        },
        performance: {
          mouthSensitivity: config.mouthSensitivity,
          mouthAttackMs: config.mouthAttackMs,
          mouthReleaseMs: config.mouthReleaseMs,
          mouthMinHoldMs: config.mouthMinHoldMs,
          mouthMixMs: config.mouthMixMs,
        },
      });
    }
    if (request.method === 'GET' && request.url === '/api/settings') return sendJson(response, 200, currentSettings());
    if (request.method === 'POST' && request.url === '/api/settings') {
      const value = await readJson(request, 200_000);
      return sendJson(response, 200, { ok: true, settings: saveSettings(value) });
    }
    if (request.method === 'POST' && request.url === '/api/chat') return await handleChat(request, response);
    if (request.method === 'GET' || request.method === 'HEAD') return serveStatic(request, response);
    sendJson(response, 405, { error: 'Method not allowed' });
  } catch (error) {
    if (!response.headersSent) sendJson(response, error.statusCode || 500, { error: error.message });
    else response.end();
  }
});

server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${config.port} 已被占用。请先关闭旧控制台。` : error);
  process.exitCode = 1;
});
server.listen(config.port, '127.0.0.1', () => {
  const profile = activeTtsProfile();
  console.log(`Ryza Chat Bridge: http://127.0.0.1:${config.port}/`);
  console.log(`LLM: ${config.llm.name}/${config.llm.model} · TTS: ${profile ? `${profile.name}/${profile.voice}` : 'off'}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
