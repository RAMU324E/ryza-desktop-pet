(() => {
  'use strict';

  const API_ROOT = location.port ? '' : 'http://127.0.0.1:18766';
  const settingsChannel = 'BroadcastChannel' in window ? new BroadcastChannel('ryza-settings') : null;
  const $ = id => document.getElementById(id);
  const ui = {
    form: $('settings-form'), status: $('settings-status'), message: $('settings-message'), reload: $('settings-reload'),
    saveButton: $('settings-save'), testLlm: $('settings-test-llm'), testTts: $('settings-test-tts'), saveFeedback: $('settings-save-feedback'),
    llmName: $('llm-name'), llmUrl: $('llm-url'), llmMethod: $('llm-method'), llmApiMode: $('llm-api-mode'), llmKey: $('llm-key'), llmModel: $('llm-model'),
    llmHeaders: $('llm-headers'), llmExtraBody: $('llm-extra-body'), thinking: $('llm-thinking'), responseFormat: $('llm-response-format'),
    effort: $('reasoning-effort'), temperature: $('llm-temperature'), maxTokens: $('llm-max-tokens'),
    characterStance: $('character-stance'), characterSittingPose: $('character-sitting-pose'),
    agentSource: $('agent-source'), visionEnabled: $('vision-enabled'), visionApiMode: $('vision-api-mode'), visionUrl: $('vision-url'), visionKey: $('vision-key'), visionModel: $('vision-model'),
    mcpEnabled: $('mcp-enabled'), mcpUrl: $('mcp-url'), mcpHeaders: $('mcp-headers'),
    speechMode: $('tts-speech-mode'), profileSelect: $('tts-profile-select'), profileAdd: $('tts-profile-add'), profileCopy: $('tts-profile-copy'), profileDelete: $('tts-profile-delete'),
    presetMimo: $('tts-preset-mimo'), presetHf: $('tts-preset-hf'), presetGpt: $('tts-preset-gpt'),
    profileName: $('tts-profile-name'), adapter: $('tts-adapter'), ttsUrl: $('tts-url'), ttsMethod: $('tts-method'), ttsKey: $('tts-key'),
    ttsModel: $('tts-model'), ttsVoice: $('tts-voice'), ttsHeaders: $('tts-headers'), bodyTemplate: $('tts-body-template'),
    responseContentType: $('tts-response-content-type'), format: $('tts-format'), sampleRate: $('tts-sample-rate'), channels: $('tts-channels'),
    concurrency: $('tts-concurrency'), streaming: $('tts-streaming'),
    mouthSensitivity: $('mouth-sensitivity'), mouthAttackMs: $('mouth-attack-ms'), mouthReleaseMs: $('mouth-release-ms'), mouthMixMs: $('mouth-mix-ms'),
    prompt: $('system-prompt'),
    ttsInstruction: $('tts-instruction'),
  };

  const adapters = new Set(['mimo-sse', 'http-wav', 'gpt-sovits-stream', 'raw-pcm']);
  const speechModes = new Set(['zh', 'zh-ja']);
  const apiModes = new Set(['auto', 'chat-completions', 'responses']);
  const agentSources = new Set(['clonoth', 'direct']);
  const stances = new Set(['sitting', 'standing']);
  const sittingPoses = new Set(['normal', 'agura']);
  const templatePattern = /\{\{JSON\.stringify\((speakText|text|model|voice|instruction|speechLanguage)\)\}\}/g;
  let settings = null;
  let selectedProfileId = '';

  const defaultTemplates = {
    mimo: `{
  "model": {{JSON.stringify(model)}},
  "messages": [
    { "role": "user", "content": {{JSON.stringify(instruction)}} },
    { "role": "assistant", "content": {{JSON.stringify(speakText)}} }
  ],
  "audio": { "format": "pcm16", "voice": {{JSON.stringify(voice)}} },
  "stream": true
}`,
    hf: `{
  "text": {{JSON.stringify(speakText)}},
  "voice_id": "zh_ryza_asmr",
  "language": {{JSON.stringify(speechLanguage)}},
  "response_format": "wav",
  "speed_factor": 1.0,
  "text_split_method": "cut0"
}`,
    gpt: `{
  "text": {{JSON.stringify(speakText)}},
  "text_lang": {{JSON.stringify(speechLanguage)}},
  "ref_audio_path": "",
  "prompt_text": "",
  "prompt_lang": "zh",
  "media_type": "wav",
  "streaming_mode": true
}`,
  };

  function setStatus(kind, text) {
    ui.status.className = `status-pill ${kind}`;
    ui.status.querySelector('.status-text').textContent = text;
    ui.status.title = text;
    ui.message.hidden = kind !== 'error';
    ui.message.textContent = kind === 'error' ? text : '';
    ui.saveFeedback.className = `save-feedback ${kind}`;
    ui.saveFeedback.textContent = text;
  }

  function jsonText(value) {
    if (typeof value === 'string') return value || '{}';
    return JSON.stringify(value && typeof value === 'object' ? value : {}, null, 2);
  }

  function uniqueId(prefix = 'tts') {
    let id;
    do {
      id = `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
    } while (settings?.tts?.profiles?.some(profile => profile.id === id));
    return id;
  }

  function preset(kind, source = {}) {
    if (kind === 'hf') return {
      id: uniqueId('hf'), name: '莱莎 CN（ASMR）- HF 云端', adapter: 'http-wav',
      url: 'https://example.invalid/v1/tts', method: 'POST', key: source.key || '', model: '', voice: 'zh_ryza_asmr', instruction: source.instruction || '',
      headers: source.headers || '{\n  "Content-Type": "application/json"\n}', bodyTemplate: defaultTemplates.hf,
      responseContentType: 'audio/wav', format: 'int16', sampleRate: 32000, channels: 1, concurrency: 1, streaming: false,
    };
    if (kind === 'gpt') return {
      id: uniqueId('gpt-sovits'), name: 'GPT-SoVITS 本地 API v2', adapter: 'gpt-sovits-stream',
      url: 'http://127.0.0.1:9880/tts', method: 'POST', key: source.key || '', model: '', voice: '', instruction: source.instruction || '',
      headers: source.headers || '{\n  "Content-Type": "application/json"\n}', bodyTemplate: defaultTemplates.gpt,
      responseContentType: 'audio/wav', format: 'int16', sampleRate: 32000, channels: 1, concurrency: 1, streaming: true,
    };
    return {
      id: uniqueId('mimo'), name: 'MiMo 冰糖', adapter: 'mimo-sse',
      url: source.url || 'https://api.xiaomimimo.com/v1/chat/completions', method: 'POST', key: source.key || '',
      model: source.model || 'mimo-v2.5-tts', voice: source.voice || '冰糖', instruction: source.instruction || '请使用自然、亲切、清晰的中文语音朗读。',
      headers: source.headers || '{\n  "Content-Type": "application/json"\n}', bodyTemplate: source.bodyTemplate || defaultTemplates.mimo,
      responseContentType: 'text/event-stream', format: 'int16', sampleRate: 24000, channels: 1, concurrency: 2, streaming: true,
    };
  }

  function normalizeSettings(value) {
    const result = structuredClone(value || {});
    result.llm ||= {};
    result.llm.name ||= 'DeepSeek';
    result.llm.method ||= 'POST';
    result.llm.apiMode = apiModes.has(result.llm.apiMode) ? result.llm.apiMode : 'auto';
    result.llm.headers = jsonText(result.llm.headers);
    result.llm.extraBody = jsonText(result.llm.extraBody);
    result.llm.responseFormat = result.llm.responseFormat !== false;
    result.agent ||= {};
    result.agent.source = agentSources.has(result.agent.source) ? result.agent.source : 'clonoth';
    result.agent.vision ||= {};
    result.agent.vision.enabled = result.agent.vision.enabled === true;
    result.agent.vision.apiMode = apiModes.has(result.agent.vision.apiMode) ? result.agent.vision.apiMode : 'responses';
    result.agent.vision.url ||= 'https://api.openai.com/v1/responses';
    result.agent.vision.model ||= 'gpt-4.1-mini';
    result.agent.vision.key ||= '';
    result.agent.mcp ||= {};
    result.agent.mcp.enabled = result.agent.mcp.enabled === true;
    result.agent.mcp.url ||= '';
    result.agent.mcp.headers = jsonText(result.agent.mcp.headers);
    result.character ||= {};
    result.character.stance = stances.has(result.character.stance) ? result.character.stance : 'sitting';
    result.character.sittingPose = sittingPoses.has(result.character.sittingPose) ? result.character.sittingPose : 'normal';
    result.performance ||= {};
    result.performance.mouthSensitivity = Number(result.performance.mouthSensitivity) || 1.6;
    result.performance.mouthAttackMs = Number(result.performance.mouthAttackMs) || 90;
    result.performance.mouthReleaseMs = Number(result.performance.mouthReleaseMs) || 150;
    result.performance.mouthMixMs = Number.isFinite(Number(result.performance.mouthMixMs)) ? Number(result.performance.mouthMixMs) : 140;
    if (!Array.isArray(result.tts?.profiles) || !result.tts.profiles.length) {
      const legacy = result.tts || {};
      result.tts = { speechMode: 'zh', activeProfileId: '', profiles: [preset('mimo', legacy)] };
      result.tts.activeProfileId = result.tts.profiles[0].id;
    }
    result.tts.speechMode = speechModes.has(result.tts.speechMode) ? result.tts.speechMode : 'zh';
    for (const profile of result.tts.profiles) {
      profile.id ||= uniqueId('tts');
      profile.name ||= '未命名 TTS';
      profile.adapter = adapters.has(profile.adapter) ? profile.adapter : 'raw-pcm';
      profile.method ||= 'POST';
      profile.headers = jsonText(profile.headers);
      profile.bodyTemplate = typeof profile.bodyTemplate === 'string' ? profile.bodyTemplate : '';
      profile.instruction = typeof profile.instruction === 'string' ? profile.instruction : '';
      profile.format = profile.format === 'float32' ? 'float32' : 'int16';
      profile.sampleRate = Number(profile.sampleRate) || 24000;
      profile.channels = Number(profile.channels) || 1;
      profile.concurrency = Number(profile.concurrency) || 1;
      profile.streaming = profile.streaming !== false;
    }
    if (!result.tts.profiles.some(profile => profile.id === result.tts.activeProfileId)) result.tts.activeProfileId = result.tts.profiles[0].id;
    return result;
  }

  function syncCharacterControls() {
    ui.characterSittingPose.disabled = ui.characterStance.value === 'standing';
  }

  function fill(value) {
    settings = normalizeSettings(value);
    const llm = settings.llm;
    ui.llmName.value = llm.name ?? '';
    ui.llmUrl.value = llm.url ?? '';
    ui.llmMethod.value = llm.method ?? 'POST';
    ui.llmApiMode.value = llm.apiMode ?? 'auto';
    ui.llmKey.value = llm.key ?? '';
    ui.llmModel.value = llm.model ?? '';
    ui.llmHeaders.value = jsonText(llm.headers);
    ui.llmExtraBody.value = jsonText(llm.extraBody);
    ui.thinking.checked = llm.thinking !== false;
    ui.responseFormat.checked = llm.responseFormat !== false;
    ui.effort.value = llm.reasoningEffort ?? '';
    ui.temperature.value = llm.temperature ?? 0.8;
    ui.maxTokens.value = llm.maxTokens ?? 1200;
    ui.agentSource.value = settings.agent.source;
    ui.visionEnabled.checked = settings.agent.vision.enabled;
    ui.visionApiMode.value = settings.agent.vision.apiMode;
    ui.visionUrl.value = settings.agent.vision.url;
    ui.visionKey.value = settings.agent.vision.key;
    ui.visionModel.value = settings.agent.vision.model;
    ui.mcpEnabled.checked = settings.agent.mcp.enabled;
    ui.mcpUrl.value = settings.agent.mcp.url;
    ui.mcpHeaders.value = jsonText(settings.agent.mcp.headers);
    ui.speechMode.value = settings.tts.speechMode;
    ui.characterStance.value = settings.character.stance;
    ui.characterSittingPose.value = settings.character.sittingPose;
    syncCharacterControls();
    ui.mouthSensitivity.value = settings.performance?.mouthSensitivity ?? 1.6;
    ui.mouthAttackMs.value = settings.performance?.mouthAttackMs ?? 90;
    ui.mouthReleaseMs.value = settings.performance?.mouthReleaseMs ?? 150;
    ui.mouthMixMs.value = settings.performance?.mouthMixMs ?? 140;
    ui.prompt.value = settings.systemPrompt ?? '';
    selectedProfileId = settings.tts.activeProfileId;
    renderProfileSelect();
    fillProfile();
  }

  function currentProfile() {
    return settings?.tts?.profiles?.find(profile => profile.id === selectedProfileId) || null;
  }

  function renderProfileSelect() {
    ui.profileSelect.replaceChildren();
    for (const profile of settings.tts.profiles) {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = `${profile.name} · ${profile.adapter}`;
      ui.profileSelect.append(option);
    }
    ui.profileSelect.value = selectedProfileId;
    ui.profileDelete.disabled = settings.tts.profiles.length <= 1;
  }

  function fillProfile() {
    const profile = currentProfile();
    if (!profile) return;
    ui.profileName.value = profile.name ?? '';
    ui.adapter.value = profile.adapter ?? 'raw-pcm';
    ui.ttsUrl.value = profile.url ?? '';
    ui.ttsMethod.value = profile.method ?? 'POST';
    ui.ttsKey.value = profile.key ?? '';
    ui.ttsModel.value = profile.model ?? '';
    ui.ttsVoice.value = profile.voice ?? '';
    ui.ttsInstruction.value = profile.instruction ?? '';
    ui.ttsHeaders.value = jsonText(profile.headers);
    ui.bodyTemplate.value = profile.bodyTemplate ?? '';
    ui.responseContentType.value = profile.responseContentType ?? '';
    ui.format.value = profile.format === 'float32' ? 'float32' : 'int16';
    ui.sampleRate.value = profile.sampleRate ?? 24000;
    ui.channels.value = profile.channels ?? 1;
    ui.concurrency.value = profile.concurrency ?? 1;
    ui.streaming.checked = profile.streaming !== false;
  }

  function captureProfile() {
    const profile = currentProfile();
    if (!profile) return;
    Object.assign(profile, {
      name: ui.profileName.value.trim(), adapter: ui.adapter.value, url: ui.ttsUrl.value.trim(), method: ui.ttsMethod.value.trim().toUpperCase(),
      key: ui.ttsKey.value.trim(), model: ui.ttsModel.value.trim(), voice: ui.ttsVoice.value.trim(), instruction: ui.ttsInstruction.value, headers: ui.ttsHeaders.value,
      bodyTemplate: ui.bodyTemplate.value, responseContentType: ui.responseContentType.value.trim(), format: ui.format.value,
      sampleRate: Number(ui.sampleRate.value), channels: Number(ui.channels.value), concurrency: Number(ui.concurrency.value), streaming: ui.streaming.checked,
    });
  }

  function parseObject(text, label) {
    let value;
    try { value = JSON.parse(text.trim() || '{}'); }
    catch (error) { throw new Error(`${label} JSON 错误：${error.message}`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象`);
    return value;
  }

  function validateUrl(value, label) {
    let url;
    try { url = new URL(value); }
    catch { throw new Error(`${label}不是有效 URL`); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label}只支持 http/https`);
  }

  function renderTemplate(profile) {
    const values = {
      speakText: '测试文本', text: '测试文本', model: profile.model || '', voice: profile.voice || '', instruction: profile.instruction || '',
      speechLanguage: ui.speechMode.value === 'zh-ja' ? 'ja' : 'zh',
    };
    const rendered = (profile.bodyTemplate || '{}').replace(templatePattern, (_all, key) => JSON.stringify(values[key]));
    if (/\{\{|\}\}/.test(rendered)) throw new Error(`TTS 档案“${profile.name}”包含不支持的模板占位符`);
    let body;
    try { body = JSON.parse(rendered); }
    catch (error) { throw new Error(`TTS 档案“${profile.name}”请求体模板错误：${error.message}`); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`TTS 档案“${profile.name}”请求体模板必须生成 JSON 对象`);
    return body;
  }

  function validate(value) {
    validateUrl(value.llm.url, 'LLM URL ');
    if (!apiModes.has(value.llm.apiMode)) throw new Error('LLM API 协议无效');
    if (!/^[A-Z]+$/.test(value.llm.method)) throw new Error('LLM HTTP Method 只能包含英文字母');
    parseObject(value.llm.headers, 'LLM 请求头');
    parseObject(value.llm.extraBody, 'LLM 额外请求体');
    if (!value.llm.model) throw new Error('LLM 模型名不能为空');
    if (!agentSources.has(value.agent.source)) throw new Error('Agent source 无效');
    if (value.agent.vision.enabled) {
      validateUrl(value.agent.vision.url, '视觉 Provider URL ');
      if (!value.agent.vision.model) throw new Error('视觉模型不能为空');
    }
    if (!apiModes.has(value.agent.vision.apiMode)) throw new Error('视觉 API 协议无效');
    if (value.agent.mcp.enabled) validateUrl(value.agent.mcp.url, 'MCP URL ');
    parseObject(value.agent.mcp.headers, 'MCP Headers');
    if (!Number.isFinite(value.llm.temperature) || value.llm.temperature < 0 || value.llm.temperature > 2) throw new Error('LLM temperature 必须是 0 到 2 的数字');
    if (!Number.isInteger(value.llm.maxTokens) || value.llm.maxTokens < 1) throw new Error('LLM max tokens 必须是正整数');
    if (!stances.has(value.character.stance)) throw new Error('基础姿态无效');
    if (!sittingPoses.has(value.character.sittingPose)) throw new Error('坐姿类型无效');
    if (!Number.isFinite(value.performance.mouthSensitivity) || value.performance.mouthSensitivity < 0.25 || value.performance.mouthSensitivity > 4) throw new Error('嘴型灵敏度必须是 0.25 到 4');
    if (!Number.isFinite(value.performance.mouthAttackMs) || value.performance.mouthAttackMs < 10 || value.performance.mouthAttackMs > 1000) throw new Error('张嘴响应必须是 10 到 1000 ms');
    if (!Number.isFinite(value.performance.mouthReleaseMs) || value.performance.mouthReleaseMs < 10 || value.performance.mouthReleaseMs > 2000) throw new Error('闭嘴响应必须是 10 到 2000 ms');
    if (!Number.isFinite(value.performance.mouthMixMs) || value.performance.mouthMixMs < 0 || value.performance.mouthMixMs > 500) throw new Error('嘴型开始/结束过渡必须是 0 到 500 ms');
    if (!speechModes.has(value.tts.speechMode)) throw new Error('回复 / 朗读语言模式无效');
    if (!value.tts.profiles.length) throw new Error('至少保留一个 TTS 档案');
    if (!value.tts.profiles.some(profile => profile.id === value.tts.activeProfileId)) throw new Error('当前 TTS 档案不存在');
    const ids = new Set();
    for (const profile of value.tts.profiles) {
      if (!profile.id || ids.has(profile.id)) throw new Error('TTS 档案 id 必须存在且唯一');
      ids.add(profile.id);
      if (!profile.name) throw new Error('TTS 档案名称不能为空');
      if (!adapters.has(profile.adapter)) throw new Error(`TTS 档案“${profile.name}”Adapter 无效`);
      validateUrl(profile.url, `TTS 档案“${profile.name}”URL `);
      if (!/^[A-Z]+$/.test(profile.method)) throw new Error(`TTS 档案“${profile.name}”HTTP Method 无效`);
      parseObject(profile.headers, `TTS 档案“${profile.name}”请求头`);
      const body = renderTemplate(profile);
      if (profile.adapter === 'gpt-sovits-stream' && ['ogg', 'aac'].includes(String(body.media_type).toLowerCase())) {
        throw new Error(`TTS 档案“${profile.name}”初版不解码 ${body.media_type}，请改用 wav/raw`);
      }
      if (!['int16', 'float32'].includes(profile.format)) throw new Error(`TTS 档案“${profile.name}”PCM format 无效`);
      if (!Number.isInteger(profile.sampleRate) || profile.sampleRate < 1000 || profile.sampleRate > 768000) throw new Error(`TTS 档案“${profile.name}”sample rate 必须是 1000 到 768000 的整数`);
      if (!Number.isInteger(profile.channels) || profile.channels < 1) throw new Error(`TTS 档案“${profile.name}”channels 必须是正整数`);
      if (!Number.isInteger(profile.concurrency) || profile.concurrency < 1) throw new Error(`TTS 档案“${profile.name}”concurrency 必须是正整数`);
    }
  }

  function collect() {
    captureProfile();
    const value = {
      llm: {
        name: ui.llmName.value.trim(), url: ui.llmUrl.value.trim(), method: ui.llmMethod.value.trim().toUpperCase(), apiMode: ui.llmApiMode.value, key: ui.llmKey.value.trim(),
        headers: ui.llmHeaders.value, model: ui.llmModel.value.trim(), extraBody: ui.llmExtraBody.value, thinking: ui.thinking.checked,
        reasoningEffort: ui.effort.value, temperature: Number(ui.temperature.value), maxTokens: Number(ui.maxTokens.value), responseFormat: ui.responseFormat.checked,
      },
      agent: {
        source: ui.agentSource.value,
        vision: { enabled: ui.visionEnabled.checked, apiMode: ui.visionApiMode.value, url: ui.visionUrl.value.trim(), key: ui.visionKey.value.trim(), model: ui.visionModel.value.trim() },
        mcp: { enabled: ui.mcpEnabled.checked, url: ui.mcpUrl.value.trim(), headers: ui.mcpHeaders.value },
      },
      tts: { speechMode: ui.speechMode.value, activeProfileId: selectedProfileId, profiles: settings.tts.profiles.map(profile => ({ ...profile })) },
      character: { stance: ui.characterStance.value, sittingPose: ui.characterSittingPose.value },
      performance: {
        mouthSensitivity: Number(ui.mouthSensitivity.value),
        mouthAttackMs: Number(ui.mouthAttackMs.value),
        mouthReleaseMs: Number(ui.mouthReleaseMs.value),
        mouthMixMs: Number(ui.mouthMixMs.value),
      },
      systemPrompt: ui.prompt.value,
    };
    validate(value);
    return value;
  }

  function addProfile(profile) {
    captureProfile();
    settings.tts.profiles.push(profile);
    selectedProfileId = profile.id;
    renderProfileSelect();
    fillProfile();
    setStatus('loading', '档案已添加，尚未保存');
  }

  function sourceProfile(adapter) {
    return settings.tts.profiles.find(profile => profile.adapter === adapter) || {};
  }

  async function load() {
    setStatus('loading', '正在载入');
    try {
      const response = await fetch(`${API_ROOT}/app/settings`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      fill(await response.json());
      setStatus('success', '配置已载入');
    } catch (error) {
      setStatus('error', `载入失败：${error.message}`);
    }
  }

  async function persistCurrentSettings() {
    const response = await fetch(`${API_ROOT}/app/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collect()),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
    fill(result.settings);
    settingsChannel?.postMessage({ type: 'saved' });
  }

  async function save(event) {
    event.preventDefault();
    ui.saveButton.disabled = true;
    ui.saveButton.textContent = '正在保存…';
    setStatus('loading', '正在校验并保存');
    try {
      await persistCurrentSettings();
      const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      setStatus('success', `已保存并立即生效 · ${time}`);
    } catch (error) {
      setStatus('error', `保存失败：${error.message}`);
    } finally {
      ui.saveButton.disabled = false;
      ui.saveButton.textContent = '保存并立即生效';
    }
  }

  async function playPcm(result, context) {
    const raw = atob(result.audioPcmBase64 || '');
    if (!raw.length) throw new Error('TTS 没有返回可播放音频');
    const view = new DataView(Uint8Array.from(raw, character => character.charCodeAt(0)).buffer);
    const buffer = context.createBuffer(1, Math.floor(view.byteLength / 2), result.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
    await new Promise(resolve => { source.onended = resolve; });
  }

  async function testProvider(kind) {
    const button = kind === 'llm' ? ui.testLlm : ui.testTts;
    const original = button.textContent;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const audio = kind === 'tts' && AudioContext ? new AudioContext() : null;
    button.disabled = true;
    button.textContent = '正在测试…';
    setStatus('loading', `正在保存当前配置并测试 ${kind.toUpperCase()}`);
    try {
      if (audio) await audio.resume();
      await persistCurrentSettings();
      const response = await fetch(`${API_ROOT}/app/test/${kind}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
      if (kind === 'tts') {
        if (!audio) throw new Error('当前浏览器不支持音频播放');
        await playPcm(result, audio);
        setStatus('success', `TTS 测试成功并已播放 · ${result.profile} · ${result.elapsedMs} ms`);
      } else {
        setStatus('success', `LLM 测试成功 · ${result.text || '连接正常'}`);
      }
    } catch (error) {
      setStatus('error', `${kind.toUpperCase()} 测试失败：${error.message}`);
    } finally {
      await audio?.close().catch(() => {});
      button.disabled = false;
      button.textContent = original;
    }
  }

  for (const link of document.querySelectorAll('.settings-back, .settings-body .brand')) {
    link.addEventListener('click', async event => {
      if (!window.__TAURI__?.webviewWindow?.getCurrentWebviewWindow) return;
      event.preventDefault();
      await window.__TAURI__.webviewWindow.getCurrentWebviewWindow().hide();
    });
  }

  ui.form.addEventListener('submit', save);
  ui.characterStance.addEventListener('change', syncCharacterControls);
  ui.reload.addEventListener('click', load);
  ui.testLlm.addEventListener('click', () => testProvider('llm'));
  ui.testTts.addEventListener('click', () => testProvider('tts'));
  ui.profileSelect.addEventListener('change', () => {
    captureProfile();
    selectedProfileId = ui.profileSelect.value;
    fillProfile();
  });
  ui.profileName.addEventListener('input', () => {
    const profile = currentProfile();
    if (!profile) return;
    profile.name = ui.profileName.value;
    const option = [...ui.profileSelect.options].find(item => item.value === profile.id);
    if (option) option.textContent = `${profile.name || '未命名 TTS'} · ${ui.adapter.value}`;
  });
  ui.adapter.addEventListener('change', () => {
    const profile = currentProfile();
    if (!profile) return;
    profile.adapter = ui.adapter.value;
    renderProfileSelect();
  });
  ui.profileAdd.addEventListener('click', () => addProfile({
    ...preset('gpt'), id: uniqueId('tts'), name: '新 TTS 档案', adapter: 'raw-pcm', url: 'http://127.0.0.1:9880/tts', bodyTemplate: '{}',
    responseContentType: 'application/octet-stream', streaming: true,
  }));
  ui.profileCopy.addEventListener('click', () => {
    captureProfile();
    const source = currentProfile();
    if (!source) return;
    addProfile({ ...structuredClone(source), id: uniqueId('tts-copy'), name: `${source.name} - 副本` });
  });
  ui.profileDelete.addEventListener('click', () => {
    if (settings.tts.profiles.length <= 1) return setStatus('error', '至少保留一个 TTS 档案');
    const index = settings.tts.profiles.findIndex(profile => profile.id === selectedProfileId);
    settings.tts.profiles.splice(index, 1);
    selectedProfileId = settings.tts.profiles[Math.max(0, index - 1)].id;
    renderProfileSelect();
    fillProfile();
    setStatus('loading', '档案已删除，尚未保存');
  });
  ui.presetMimo.addEventListener('click', () => addProfile(preset('mimo', sourceProfile('mimo-sse'))));
  ui.presetHf.addEventListener('click', () => addProfile(preset('hf', sourceProfile('http-wav'))));
  ui.presetGpt.addEventListener('click', () => addProfile(preset('gpt', sourceProfile('gpt-sovits-stream'))));

  load();
})();
