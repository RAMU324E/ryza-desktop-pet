import { MokaClient, mixMouth, subtitleAt } from './vendor/moka/index.js';

const API_ROOT = location.port ? '' : 'http://127.0.0.1:18766';
const settingsChannel = 'BroadcastChannel' in window ? new BroadcastChannel('ryza-settings') : null;
const $ = id => document.getElementById(id);
const ui = {
  form: $('chat-form'), input: $('chat-input'), messages: $('chat-messages'), send: $('chat-send'),
  stop: $('chat-stop'), clear: $('chat-clear'), settings: $('chat-settings'), status: $('chat-status'), tts: $('tts-enabled'), volume: $('tts-volume'),
  drawer: $('chat-drawer-toggle'), panel: document.querySelector('.control-panel'), drag: document.querySelector('.desktop-drag-region'),
  layoutOverlay: $('layout-adjust-overlay'), resizeHandles: document.querySelectorAll('.layout-resize-handle'),
};
const historyKey = 'ryza-chat-history-v2';
const settingsKey = 'ryza-chat-settings-v2';
let history = loadJson(historyKey, []);
let client = null;
let connectPromise = null;
let connected = false;
let requestBusy = false;
let audioActive = false;
let activeAssistantIndex = -1;
let mouthSensitivity = 1.6;
let mouthAttackMs = 90;
let mouthReleaseMs = 150;
let currentMouthLevel = 0;
let lipValue = 0;
let lastFrameAt = performance.now();
let lastSoundAt = 0;
let pendingImagePath = '';

function invoke(command, args = {}) {
  const call = window.__TAURI__?.core?.invoke;
  return call ? call(command, args) : Promise.reject(new Error('仅桌面版支持此功能'));
}

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

function saveHistory() {
  history = history
    .filter(item => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string')
    .filter(item => item.content.trim())
    .slice(-60);
  localStorage.setItem(historyKey, JSON.stringify(history));
}

function saveChatSettings() {
  localStorage.setItem(settingsKey, JSON.stringify({ tts: ui.tts.checked, volume: Number(ui.volume.value) }));
}

function setStatus(text) {
  ui.status.textContent = text;
}

function syncControls() {
  ui.send.disabled = !connected;
  ui.send.textContent = requestBusy ? '发送并中断' : '发送';
  ui.stop.disabled = !requestBusy && !audioActive;
  ui.input.disabled = !connected;
}

function addMessageElement(role, text) {
  const element = document.createElement('div');
  element.className = `chat-message ${role}`;
  element.textContent = text;
  ui.messages.append(element);
}

function renderMessages() {
  ui.messages.replaceChildren();
  if (!history.length && activeAssistantIndex < 0) {
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.textContent = '输入一句话开始聊天。\n回复会通过 MOKAMOKA 驱动语音、嘴型、表情和动作。';
    ui.messages.append(empty);
    return;
  }
  for (const message of history) addMessageElement(message.role, message.content);
  ui.messages.scrollTop = ui.messages.scrollHeight;
}

function showError(message) {
  addMessageElement('error', message);
  setStatus('发生错误，可重试');
}

function ensureAssistantMessage() {
  if (activeAssistantIndex >= 0 && history[activeAssistantIndex]) return activeAssistantIndex;
  history.push({ role: 'assistant', content: '' });
  activeAssistantIndex = history.length - 1;
  return activeAssistantIndex;
}

function sendCapabilities() {
  const info = window.RYZA_SPINE_API?.getModelInfo?.();
  if (connected && info?.name) client?.sendModelInfo(info);
}

function resetPerformance() {
  lipValue = 0;
  currentMouthLevel = 0;
  window.RYZA_SPINE_API?.resetMouth?.();
  window.RYZA_SPINE_API?.stopMotions?.();
}

function callbacks() {
  return {
    onStatus(status, detail = {}) {
      connected = status === 'connected';
      if (status === 'connecting') setStatus('正在连接 MOKAMOKA…');
      else if (status === 'connected') {
        setStatus('MOKAMOKA 已连接');
        sendCapabilities();
      } else if (status === 'reconnecting') setStatus(`连接中断，${Math.ceil((detail.retryInMs || 1000) / 1000)} 秒后重试…`);
      else if (status === 'fatal') setStatus(`MOKAMOKA 连接失败：${detail.message || detail.code || '未知错误'}`);
      else setStatus('MOKAMOKA 已断开');
      syncControls();
    },
    onReplyBegin() {
      requestBusy = true;
      activeAssistantIndex = -1;
      ensureAssistantMessage();
      setStatus('莱莎正在组织回复…');
      syncControls();
      renderMessages();
    },
    onUtterance(utterance) {
      const index = ensureAssistantMessage();
      history[index].content += utterance.text;
      audioActive = true;
      saveHistory();
      renderMessages();
      setStatus('正在合成并播放语音…');
      syncControls();
    },
    onEvent(event) {
      window.RYZA_SPINE_API?.performMokaEvent?.(event);
    },
    onReplyEnd(payload) {
      requestBusy = false;
      if (activeAssistantIndex >= 0 && !history[activeAssistantIndex]?.content) history.splice(activeAssistantIndex, 1);
      activeAssistantIndex = -1;
      saveHistory();
      renderMessages();
      setStatus(payload.aborted ? '回复已中断' : '回复生成完成');
      syncControls();
    },
    onInterrupted() {
      requestBusy = false;
      audioActive = false;
      resetPerformance();
      setStatus('已停止');
      syncControls();
    },
    onError(code, message) {
      requestBusy = false;
      showError(`MOKAMOKA ${code || ''}：${message || '请求失败'}`);
      syncControls();
    },
    onWarning(code) {
      if (code === 'playback_overflow') setStatus('音频缓冲溢出，已丢弃过量分片');
    },
  };
}

function applyPerformanceSettings(settings = {}) {
  mouthSensitivity = Number(settings.mouthSensitivity) || 1.6;
  mouthAttackMs = Number(settings.mouthAttackMs) || 90;
  mouthReleaseMs = Number(settings.mouthReleaseMs) || 150;
  window.RYZA_SPINE_API?.setMouthTransitionMs?.(Number.isFinite(Number(settings.mouthMixMs)) ? Number(settings.mouthMixMs) : 140);
}

async function refreshAppSettings() {
  try {
    const response = await fetch(`${API_ROOT}/app/health`, { cache: 'no-store' });
    if (!response.ok) return;
    const health = await response.json();
    applyPerformanceSettings(health.performance);
    window.RYZA_SPINE_API?.setCharacterState?.(health.character);
  } catch { /* 下次连接时会重新读取。 */ }
}

async function connectMoka() {
  if (connectPromise) return connectPromise;
  connectPromise = (async () => {
    const response = await fetch(`${API_ROOT}/app/health`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`本地服务 HTTP ${response.status}`);
    const health = await response.json();
    if (!health.ok) throw new Error('本地服务未就绪');
    applyPerformanceSettings(health.performance);
    window.RYZA_SPINE_API?.setCharacterState?.(health.character);
    client = new MokaClient(callbacks());
    client.player.setVolume?.(ui.tts.checked ? Number(ui.volume.value) : 0);
    await client.connect(health.moka.url, health.moka.token);
  })().catch(error => {
    connectPromise = null;
    connected = false;
    setStatus(`无法连接本地服务：${error.message}`);
    syncControls();
    throw error;
  });
  return connectPromise;
}

function stop() {
  if (client && (requestBusy || audioActive)) client.interruptByUser();
  requestBusy = false;
  audioActive = false;
  resetPerformance();
  setStatus('已停止');
  syncControls();
}

async function send() {
  const text = ui.input.value.trim();
  if (!text && !pendingImagePath) return;
  try {
    await connectMoka();
    if (requestBusy || audioActive) client.interruptByUser();
    history.push({ role: 'user', content: text || '[截图]' });
    history = history.slice(-60);
    saveHistory();
    renderMessages();
    ui.input.value = '';
    requestBusy = true;
    window.RYZA_SPINE_API?.markInteraction?.();
    setStatus('莱莎正在思考…');
    syncControls();
    let outbound = text || '请看看这张截图。';
    try {
      const context = await invoke('get_foreground_context');
      const detail = [context?.process, context?.title].filter(Boolean).join(' · ');
      if (detail) outbound += `\n\n[最近使用的外部窗口：${detail}]`;
    } catch { /* 浏览器预览或桌面上下文暂不可用。 */ }
    if (pendingImagePath) {
      outbound = `[[RYZA_IMAGE:${pendingImagePath}]]\n${outbound}`;
      pendingImagePath = '';
    }
    client.sendText(outbound);
  } catch (error) {
    showError(error.message);
  }
}

async function pasteClipboardImage(event) {
  const item = Array.from(event.clipboardData?.items || []).find(value => value.type === 'image/png');
  const file = item?.getAsFile();
  if (!file) return;
  event.preventDefault();
  setStatus('正在附加剪贴板截图…');
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    pendingImagePath = await invoke('save_clipboard_image', { dataUrl });
    setStatus('截图已粘贴，将随下一条消息发送');
  } catch (error) {
    pendingImagePath = '';
    setStatus(`截图粘贴失败：${error}`);
  }
}

function toggleDrawer(force) {
  const open = typeof force === 'boolean' ? force : !ui.panel.classList.contains('drawer-open');
  ui.panel.classList.toggle('drawer-open', open);
  ui.drawer.setAttribute('aria-expanded', String(open));
  ui.drawer.title = open ? '收起聊天抽屉' : '打开聊天抽屉';
  ui.drawer.textContent = open ? '×' : '💬';
  updateInteractionRegions();
}

function rectValue(element) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0
    ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
    : null;
}

function updateInteractionRegions() {
  if (!document.documentElement.classList.contains('desktop-mode')) return;
  const character = window.RYZA_SPINE_API?.getInteractionRect?.() || rectValue(document.getElementById('character-player'));
  const regions = [character, rectValue(ui.drag), rectValue(ui.drawer), rectValue(ui.panel)].filter(Boolean);
  invoke('set_interaction_regions', { regions }).catch(() => {});
}

function applyLayoutMode(adjusting) {
  document.documentElement.classList.toggle('layout-adjust-mode', adjusting);
  ui.layoutOverlay?.setAttribute('aria-hidden', String(!adjusting));
  updateInteractionRegions();
}

function startResize(event) {
  event.preventDefault();
  event.stopPropagation();
  const appWindow = window.__TAURI__?.window?.getCurrentWindow?.();
  appWindow?.startResizeDragging(event.currentTarget.dataset.resizeDirection)
    .catch(error => showError(`无法调整窗口：${error}`));
}

async function clearConversation() {
  stop();
  history = [];
  pendingImagePath = '';
  activeAssistantIndex = -1;
  saveHistory();
  renderMessages();
  client?.close();
  client = null;
  connected = false;
  connectPromise = null;
  syncControls();
  try {
    await connectMoka();
    setStatus('对话已清空');
  } catch { /* connectMoka 已显示错误。 */ }
}

function animationFrame(now) {
  const delta = Math.min(100, now - lastFrameAt);
  lastFrameAt = now;
  const position = client?.position?.();
  const utterance = position ? client?.utterance(position.streamId) : null;
  const loudness = ui.tts.checked ? (client?.player?.loudness?.() || 0) : 0;
  if (loudness > 0.01) {
    lastSoundAt = now;
    audioActive = true;
  } else if (!requestBusy && audioActive && now - lastSoundAt > 500) {
    audioActive = false;
    lipValue = 0;
    currentMouthLevel = 0;
    window.RYZA_SPINE_API?.resetMouth?.();
    if (ui.status.textContent.startsWith('正在说话')) setStatus('回复播放完成');
  }
  const mouth = utterance && position ? mixMouth(utterance.mouth, position.ptsMs) : null;
  const articulation = mouth ? Math.max(mouth.a, mouth.i, mouth.u, mouth.e, mouth.o) : 0;
  const target = Math.min(1, loudness * mouthSensitivity * (0.72 + articulation * 0.28));
  const duration = target > lipValue ? mouthAttackMs : mouthReleaseMs;
  lipValue += (target - lipValue) * (1 - Math.exp(-delta / duration));
  if (audioActive || lipValue > 0.01) {
    const applied = window.RYZA_SPINE_API?.setMouthOpen?.(lipValue);
    if (Number.isFinite(applied) && applied >= 0) currentMouthLevel = applied;
  }
  if (utterance && position && loudness > 0.01) {
    const subtitle = subtitleAt(utterance, position.ptsMs);
    setStatus(`正在说话 · ${subtitle || utterance.text}`);
  }
  client?.pumpEvents?.();
  syncControls();
  requestAnimationFrame(animationFrame);
}

function init() {
  const settings = loadJson(settingsKey, { tts: true, volume: 1 });
  ui.tts.checked = settings.tts !== false;
  ui.volume.value = Number.isFinite(Number(settings.volume)) ? settings.volume : 1;
  renderMessages();
  syncControls();
  connectMoka().catch(() => {});

  ui.form.addEventListener('submit', event => {
    event.preventDefault();
    send();
  });
  ui.input.addEventListener('paste', pasteClipboardImage);
  ui.input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  ui.stop.addEventListener('click', stop);
  ui.clear.addEventListener('click', clearConversation);
  ui.drawer.addEventListener('click', () => toggleDrawer());
  ui.resizeHandles.forEach(handle => handle.addEventListener('pointerdown', startResize));
  ui.settings.addEventListener('click', async () => {
    try {
      if (window.__TAURI__?.webviewWindow?.WebviewWindow) {
        const settingsWindow = await window.__TAURI__.webviewWindow.WebviewWindow.getByLabel('settings');
        await settingsWindow?.show();
        await settingsWindow?.setFocus();
      } else window.open('settings.html', 'ryza-settings');
    } catch (error) {
      showError(`无法打开设置：${error.message}`);
    }
  });
  ui.tts.addEventListener('change', () => {
    client?.player?.setVolume?.(ui.tts.checked ? Number(ui.volume.value) : 0);
    if (!ui.tts.checked) resetPerformance();
    saveChatSettings();
  });
  ui.volume.addEventListener('input', () => {
    client?.player?.setVolume?.(ui.tts.checked ? Number(ui.volume.value) : 0);
    saveChatSettings();
  });
  settingsChannel?.addEventListener('message', event => {
    if (event.data?.type === 'saved') refreshAppSettings();
  });
  window.addEventListener('ryza-spine-ready', () => {
    sendCapabilities();
    updateInteractionRegions();
  });
  window.addEventListener('resize', updateInteractionRegions);
  window.addEventListener('ryza-layout-mode', event => applyLayoutMode(event.detail === true));
  setInterval(updateInteractionRegions, 500);
  updateInteractionRegions();
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && (requestBusy || audioActive)) stop();
  });
  requestAnimationFrame(animationFrame);
}

init();
