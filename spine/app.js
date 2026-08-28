(() => {
  'use strict';

  const assets = window.SPINE_ASSETS;
  const hostRoot = location.port ? '' : 'http://127.0.0.1:18766';
  const desktopMode = !location.port || new URLSearchParams(location.search).has('desktop');
  const $ = id => document.getElementById(id);
  const ui = {
    characterSelect: $('character-select'),
    sceneSearch: $('scene-search'),
    periodFilter: $('period-filter'),
    sceneSelect: $('scene-select'),
    sceneVisible: $('scene-visible'),
    controlsVisible: $('controls-visible'),
    checkerVisible: $('checker-visible'),
    canvasColor: $('canvas-color'),
    reloadButton: $('reload-button'),
    fullscreenButton: $('fullscreen-button'),
    resetButton: $('reset-button'),
    applyButton: $('apply-button'),
    viewport: $('viewport'),
    characterLayer: $('character-player'),
    sceneLayer: $('scene-player'),
    overlay: $('loading-overlay'),
    globalStatus: $('global-status'),
    activeCharacter: $('active-character'),
    activeScene: $('active-scene'),
    sceneStatus: $('scene-status'),
    characterCount: $('character-count'),
    sceneCount: $('scene-count'),
    motionSelect: $('motion-select'),
    playMotion: $('play-motion'),
    motionGroupSelect: $('motion-group-select'),
    playMotionGroup: $('play-motion-group'),
    stopMotionGroup: $('stop-motion-group'),
    allAnimationSelect: $('all-animation-select'),
    playAllAnimation: $('play-all-animation'),
    attitudeTestSelect: $('attitude-test-select'),
    lookTestSelect: $('look-test-select'),
    applyPoseLook: $('apply-pose-look'),
    tapPartSelect: $('tap-part-select'),
    playTapReaction: $('play-tap-reaction'),
    hitDebugVisible: $('hit-debug-visible'),
    motionStatus: $('motion-status'),
    emotionSelect: $('emotion-select'),
    intensitySelect: $('intensity-select'),
    rerollExpression: $('reroll-expression'),
    clearExpression: $('clear-expression'),
    mouthTakeover: $('mouth-takeover'),
    eyeTestSelect: $('eye-test-select'),
    eyebrowTestSelect: $('eyebrow-test-select'),
    mouthTestSelect: $('mouth-test-select'),
    fxTestSelect: $('fx-test-select'),
    expressionStatus: $('expression-status'),
    trackDebugPanel: $('track-debug-panel'),
    trackDebug: $('track-debug'),
  };

  const labels = {
    mor: '早晨',
    aft: '下午',
    eve: '傍晚',
    ngt: '夜晚',
  };

  const defaults = {
    character: assets.characters[0],
    stance: 'sitting',
    sittingPose: 'normal',
    scene: 'stage_01_001_01_mor',
    period: 'all',
    color: '#17151f',
  };

  const trackDebugOpenKey = 'ryza-track-debug-open-v1';
  const tracks = Object.freeze({ body: 0, eye: 1, eyebrow: 2, mouth: 3, fx: 4, sitting: 5, motion1: 6, motion2: 7, attitude: 8 });
  const emotionLabels = {
    angry: '生气', crying: '哭泣', cuddle: '亲昵', happy: '开心', laughing: '大笑',
    neutral: '平静', sad: '难过', shy: '害羞', tease: '调皮',
  };
  const intensityLabels = { weak: '弱', normal: '普通', strong: '强' };
  // 需求文档 M5：无音频时嘴型回落闭嘴 idle。01 有 facial_mouth_009_idle；
  // 99 的嘴型只到 008，因此按候选顺序取第一个存在的动画。
  const defaultMouthCandidates = ['facial_mouth_009_idle', 'facial_mouth_001_idle'];
  const trackLabels = ['T0 身体', 'T1 眼', 'T2 眉', 'T3 嘴', 'T4 FX', 'T5 坐姿', 'T6 叠加1', 'T7 叠加2', 'T8 态度'];
  const fxLabels = {
    blush001: '脸红 1', blush002: '脸红 2', blush003: '脸红 3',
    tear001: '眼泪 1', tear002: '眼泪 2', sweat: '汗', pale: '苍白',
    blush: '脸红', tear: '眼泪',
  };
  const tapReactionCodes = {
    head: ['001', '002'], breast: ['003'], body: ['004'],
    arm_l: ['005'], arm_r: ['006'], weast: ['007'],
  };
  const characterDebug = { bones: false, regions: false, meshes: false, bounds: false, paths: false, clipping: false, points: false, hulls: false };

  let characterPlayer = null;
  let scenePlayer = null;
  let currentGesture = null;
  let currentFx = null;
  let currentExpression = null;
  let currentDefaultMouth = null;
  let currentLipLevel = 0;
  let mouthScrubEntry = null;
  let mouthScrubName = null;
  let mouthMixMs = 140;
  let expressionIndex = 0;
  let characterRequest = 0;
  let sceneRequest = 0;
  let motionClearTimer = 0;
  let ambientIdleTimer = 0;
  let ambientIdleIndex = -1;
  let ambientIdleLabel = '';
  let ambientIdleActive = false;
  let mokaHoldMs = 2600;
  let skeletonBounds = null;
  let pointerDown = null;
  let touchVoice = null;
  let lookMode = 'pointer';
  let lookTarget = { x: 0, y: 0 };
  let lookCurrent = { x: 0, y: 0 };
  let lookBones = [];
  let lastPointerAt = 0;
  let lastInteractionAt = performance.now();
  let nextIdleAt = lastInteractionAt + 5000;
  let lastDebugText = '';
  let activeStance = defaults.stance;
  let activeSittingPose = defaults.sittingPose;
  let characterSaveTimer = 0;
  let lastMokaMood = null;

  function setGlobalStatus(kind, text) {
    ui.globalStatus.className = `status-pill ${kind}`;
    ui.globalStatus.querySelector('.status-text').textContent = text;
  }

  function disposePlayer(player, container) {
    if (player) player.dispose();
    container.replaceChildren();
  }

  function characterPath(id, extension) {
    return `crf_chr_002/${id}/${id}.${extension}`;
  }

  function characterAtlasPath(id) {
    return `crf_chr_002/${id}/${id}_pma.atlas`;
  }

  function scenePath(id, extension) {
    return `scenes/${id}/spine/${id}.${extension}`;
  }

  function gesturePath(id) {
    return `crf_chr_002/${id}/${id}_gesture.json`;
  }

  async function loadGesture(id) {
    const response = await fetch(gesturePath(id));
    if (!response.ok) throw new Error(`gesture.json HTTP ${response.status}`);
    return response.json();
  }

  function hasAnimation(name) {
    return Boolean(name && characterPlayer?.skeleton?.data.findAnimation(name));
  }

  function characterIdForStance(stance) {
    return stance === 'standing' ? 'crf_skn_002_0001_99' : 'crf_skn_002_0001_01';
  }

  function characterSettings() {
    return { stance: activeStance, sittingPose: activeSittingPose };
  }

  async function persistCharacterSettings() {
    try {
      const response = await fetch(`${hostRoot}/app/settings`, { cache: 'no-store' });
      if (!response.ok) return;
      const settings = await response.json();
      settings.character = characterSettings();
      await fetch(`${hostRoot}/app/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings),
      });
    } catch { /* 下次切换时重试。 */ }
  }

  function scheduleCharacterSave() {
    clearTimeout(characterSaveTimer);
    characterSaveTimer = setTimeout(persistCharacterSettings, 120);
  }

  function setCharacterState(value = {}, persist = false) {
    const stance = ['sitting', 'standing'].includes(value.stance) ? value.stance : activeStance;
    const sittingPose = ['normal', 'agura'].includes(value.sittingPose) ? value.sittingPose : activeSittingPose;
    const modelChanged = ui.characterSelect.value !== characterIdForStance(stance);
    const poseChanged = sittingPose !== activeSittingPose;
    activeStance = stance;
    activeSittingPose = sittingPose;
    if (modelChanged) {
      ui.characterSelect.value = characterIdForStance(stance);
      loadCharacter();
    } else if (poseChanged && characterPlayer && currentGesture) {
      applySittingPose();
    }
    if (persist) scheduleCharacterSave();
    return characterSettings();
  }

  function configureMouthMix(state, fromName, toName) {
    if (!fromName || !toName || fromName === toName || mouthMixMs <= 0) return;
    state.data?.setMix?.(fromName, toName, mouthMixMs / 1000);
  }

  function setTrackAnimation(state, track, name, loop) {
    const previousName = state.getCurrent(track)?.animation?.name;
    if (track === tracks.mouth) configureMouthMix(state, previousName, name);
    const entry = state.setAnimation(track, name, loop);
    if (track === tracks.mouth && previousName && entry) entry.mixDuration = mouthMixMs / 1000;
    return entry;
  }

  function setExpressionTrack(track, baseName) {
    const state = characterPlayer?.animationState;
    if (!state || !baseName) return;

    const stem = baseName.replace(/_(?:active|idle)$/, '');
    const activeName = `${stem}_active`;
    const idleName = baseName.endsWith('_idle') ? baseName : `${stem}_idle`;
    const active = characterPlayer.skeleton.data.findAnimation(activeName);
    const idle = characterPlayer.skeleton.data.findAnimation(idleName);
    const fallback = characterPlayer.skeleton.data.findAnimation(baseName);

    if (active && idle && active.name !== idle.name) {
      setTrackAnimation(state, track, active.name, false);
      if (track === tracks.mouth) configureMouthMix(state, active.name, idle.name);
      const idleEntry = state.addAnimation(track, idle.name, true, 0);
      if (track === tracks.mouth && idleEntry) idleEntry.mixDuration = mouthMixMs / 1000;
    } else if (idle) {
      setTrackAnimation(state, track, idle.name, true);
    } else if (fallback) {
      setTrackAnimation(state, track, fallback.name, true);
    } else {
      state.setEmptyAnimation(track, 0.2);
    }
  }

  function applyDefaultMouth() {
    const state = characterPlayer?.animationState;
    if (!state) return;
    currentLipLevel = 0;
    mouthScrubEntry = null;
    mouthScrubName = null;
    currentDefaultMouth = defaultMouthCandidates.find(hasAnimation) ?? null;
    if (currentDefaultMouth) setTrackAnimation(state, tracks.mouth, currentDefaultMouth, true);
    else state.setEmptyAnimation(tracks.mouth, 0.2);
  }

  function setMouthTransitionMs(value) {
    const numeric = Number(value);
    mouthMixMs = Math.min(500, Math.max(0, Number.isFinite(numeric) ? numeric : 140));
    return mouthMixMs;
  }

  function setupMouthScrub(state) {
    const animations = characterPlayer?.skeleton?.data.animations ?? [];
    const animation = animations.find(item => item.name === 'facial_mouth_002_scrub_02')
      ?? animations.find(item => /^facial_mouth_\d+_scrub_02$/.test(item.name));
    if (!animation) return null;
    mouthScrubName = animation.name;
    mouthScrubEntry = state.setAnimation(tracks.mouth, animation.name, false);
    mouthScrubEntry.timeScale = 0;
    mouthScrubEntry.mixDuration = mouthMixMs / 1000;
    return mouthScrubEntry;
  }

  function setMouthOpen(value) {
    const state = characterPlayer?.animationState;
    if (!state) return -1;
    const openness = Math.min(1, Math.max(0, Number(value) || 0));
    const current = state.getCurrent(tracks.mouth);
    const entry = mouthScrubEntry && current === mouthScrubEntry ? mouthScrubEntry : setupMouthScrub(state);
    if (!entry) return -1;
    const eased = openness * openness * (3 - 2 * openness);
    entry.trackTime = entry.animation.duration * eased;
    currentLipLevel = openness < 0.025 ? 0 : Math.min(8, Math.max(1, Math.round(openness * 8)));
    return currentLipLevel;
  }

  function applyPerformance(performance = {}) {
    if (!characterPlayer || !currentGesture) return false;
    const profiles = currentGesture.emotionalGesture?.EmotionProfilesV4 ?? {};
    const emotion = profiles[performance.emotion] ? performance.emotion : 'neutral';
    ui.emotionSelect.value = emotion;
    expressionIndex = 0;
    fillIntensityOptions(performance.intensity);
    applyExpression();
    playAttitude(performance.attitude, emotion);
    const actionIndex = Number(String(performance.action ?? '').match(/^group:(\d+)$/)?.[1]);
    if (Number.isInteger(actionIndex)) playMotionGroupByIndex(actionIndex, performance.actionHoldMs);
    else if (!ambientIdleActive) startAmbientIdle();
    return true;
  }

  function setFacialFx(name) {
    const state = characterPlayer?.animationState;
    const project = currentGesture?.projectConfig;
    if (!state || !project) return;

    const offName = currentFx ? project.fxOffAnimNames?.[currentFx] : null;
    const onName = name ? project.fxOnAnimNames?.[name] : null;

    if (hasAnimation(offName)) {
      state.setAnimation(tracks.fx, offName, false);
      if (hasAnimation(onName)) state.addAnimation(tracks.fx, onName, false, 0);
    } else if (hasAnimation(onName)) {
      state.setAnimation(tracks.fx, onName, false);
    } else {
      state.setEmptyAnimation(tracks.fx, 0.2);
    }
    currentFx = name || null;
  }

  const motionLabelReplacements = [
    ['LL-', '左腿 · '], ['RL-', '右腿 · '], ['BA-', '双臂 · '], ['LB-', '腿部 · '],
    ['L-', '左手 · '], ['R-', '右手 · '], ['T-', '躯干 · '],
    ['肩を回す', '转肩'], ['両手を重ねる', '双手交叠'], ['両手を両腰に', '双手叉腰'],
    ['腕組み', '抱臂'], ['両手を胸元に', '双手放胸前'], ['左右伸び(背伸び)', '左右伸懒腰'],
    ['両手を太ももの内側に', '双手放大腿内侧'], ['脚プラプラ(両足)', '双腿晃动'],
    ['脚の角度を変える/崩す', '调整腿部姿势'], ['膝の開閉', '膝盖开合'],
    ['太腿の高さ', '大腿高度'], ['あぐら', '盘腿'], ['ふらふらアイドル', '摇晃待机'],
    ['傾けてアイドル', '倾斜待机'], ['ぽよん上下', '上下轻弹'], ['後方のみ傾き', '仅向后倾'],
    ['左のみ傾き', '仅向左倾'], ['右のみ傾き', '仅向右倾'], ['前方のみ傾き', '仅向前倾'],
    ['横揺れ', '左右摇摆'], ['前後揺れ', '前后摇摆'], ['左傾き', '向左倾'], ['右傾き', '向右倾'],
    ['前傾', '向前倾'], ['後傾', '向后倾'], ['上下運動', '上下运动'], ['左右運動', '左右运动'],
    ['もじもじ', '害羞扭动'], ['腰振り', '摇腰'], ['2ループ', '2 次循环'],
    ['タブルピース', '双手剪刀手'], ['囁き', '低语'], ['パーで触る', '张开手触碰'],
    ['しーっ', '嘘声手势'], ['指差し', '指向'], ['拍手', '拍手'], ['バイバイ', '挥手'],
    ['ガッツポーズ', '胜利姿势'], ['挨拶', '打招呼'], ['太もも', '大腿'], ['掌を見せて', '展示手掌'],
    ['使わない', '不使用'], ['通常位置', '正常位置'], ['腰に', '放腰间'], ['顎に', '放下巴'],
    ['口元に', '放嘴边'], ['目元に', '放眼边'], ['頭に', '放头上'], ['こめかみに', '放太阳穴'],
  ];

  function translateMotionLabel(label = '') {
    return motionLabelReplacements.reduce((text, [from, to]) => text.replaceAll(from, to), label);
  }

  function simpleMotionLabel(name) {
    const match = name.match(/^motion_(?:(oneshot|touch)_)?([A-Z])_(\d+)_(idle|active)$/);
    if (!match) return name;
    const [, kind, letter, number] = match;
    const type = kind === 'oneshot' ? '一次动作' : kind === 'touch' ? '点击反应' : '待机';
    return `${type} · ${letter}-${number}  [${name}]`;
  }

  function addOptionGroup(select, label, names) {
    if (!names.length) return;
    const group = document.createElement('optgroup');
    group.label = label;
    for (const name of names) group.append(new Option(simpleMotionLabel(name), name));
    select.append(group);
  }

  function isUsableMotionGroup(group) {
    const label = group?.Label || group?.GroupId || '';
    return Boolean(group && !/使わない|不使用/.test(label));
  }

  function motionAppliesToCurrentPose(group) {
    if (activeStance !== 'sitting') return true;
    const ids = String(group?.ApplicableSittingIDs || '').split(/[\s,]+/).filter(Boolean);
    return !ids.length || ids.includes(`sitting_${activeSittingPose}`);
  }

  function isAvailableMotionGroup(group) {
    return isUsableMotionGroup(group) && motionAppliesToCurrentPose(group);
  }

  function setupMotionControls(config) {
    const names = characterPlayer?.skeleton?.data.animations.map(item => item.name) ?? [];
    ui.motionSelect.replaceChildren();
    addOptionGroup(ui.motionSelect, '待机动作', names.filter(name => /^motion_[A-Z]_\d+_idle$/.test(name)));
    addOptionGroup(ui.motionSelect, '一次性动作', names.filter(name => /^motion_oneshot_[A-Z]_\d+_active$/.test(name)));
    addOptionGroup(ui.motionSelect, '点击反应', names.filter(name => /^motion_touch_[A-Z]_\d+_active$/.test(name)));

    const groups = config?.emotionalGesture?.MotionGroups ?? [];
    const groupOptions = groups.map((group, index) => ({ group, index })).filter(item => isAvailableMotionGroup(item.group));
    ui.motionGroupSelect.replaceChildren(...groupOptions.map(({ group, index }) => {
      const code = [group.AnimName_1, group.AnimName_2].filter(Boolean).join(' + ');
      return new Option(`${translateMotionLabel(group.Label || group.GroupId)}  [${code}]`, String(index));
    }));

    ui.allAnimationSelect.replaceChildren(...names.map(name => new Option(name, name)));
    ui.allAnimationSelect.disabled = !names.length;
    ui.playAllAnimation.disabled = !names.length;
    const parts = [...new Set(Object.values(config?.projectConfig?.hitPartNames ?? {}))];
    ui.tapPartSelect.replaceChildren(...parts.map(part => new Option(part, part)));
    ui.tapPartSelect.disabled = !parts.length;
    ui.playTapReaction.disabled = !parts.length;

    ui.motionSelect.disabled = !ui.motionSelect.options.length;
    ui.playMotion.disabled = ui.motionSelect.disabled;
    ui.motionGroupSelect.disabled = !groupOptions.length;
    ui.playMotionGroup.disabled = !groupOptions.length;
    ui.stopMotionGroup.disabled = !groupOptions.length;
    ui.motionStatus.textContent = `${ui.motionSelect.options.length} 个独立动作 · ${groupOptions.length} 个可用叠加动作组`;
  }

  function playSelectedMotion() {
    const name = ui.motionSelect.value;
    if (!characterPlayer || !hasAnimation(name)) return;
    const loop = name.endsWith('_idle');
    characterPlayer.setAnimation(name, loop);
    if (!loop && hasAnimation('motion_A_001_idle')) characterPlayer.addAnimation('motion_A_001_idle', true, 0);
    ui.motionStatus.textContent = `正在播放：${simpleMotionLabel(name)}`;
  }

  function playSelectedRawAnimation() {
    const name = ui.allAnimationSelect.value;
    const state = characterPlayer?.animationState;
    if (!state || !hasAnimation(name)) return;
    let track = tracks.body;
    if (name.startsWith('facial_eye_')) track = tracks.eye;
    else if (name.startsWith('facial_eyebrow_')) track = tracks.eyebrow;
    else if (name.startsWith('facial_mouth_')) track = tracks.mouth;
    else if (name.startsWith('facial_add_')) track = tracks.fx;
    else if (name.startsWith('motion_add_')) track = tracks.motion1;
    else if (name.startsWith('motion_touch_') || name.startsWith('motion_oneshot_')) track = tracks.attitude;
    const loop = name.endsWith('_idle') || name.startsWith('motion_add_');
    setTrackAnimation(state, track, name, loop);
    ui.motionStatus.textContent = `原始动画 T${track}：${name}`;
    markInteraction();
  }

  function clearMotionTracks(mix = 0.2) {
    const state = characterPlayer?.animationState;
    if (!state) return;
    state.setEmptyAnimation(tracks.motion1, mix);
    state.setEmptyAnimation(tracks.motion2, mix);
  }

  function applyMotionGroup(group, maxBlendTime = Infinity) {
    const state = characterPlayer?.animationState;
    if (!isAvailableMotionGroup(group) || !state) return false;
    const mix = Math.min(maxBlendTime, Math.max(0.2, Number(group.BlendTime) || 0.6));
    [
      [tracks.motion1, group.AnimName_1, group.Alpha1, group.Speed1],
      [tracks.motion2, group.AnimName_2, group.Alpha2, group.Speed2],
    ].forEach(([track, name, alpha, speed]) => {
      if (!hasAnimation(name)) {
        state.setEmptyAnimation(track, mix);
        return;
      }
      const entry = state.setAnimation(track, name, true);
      entry.mixDuration = mix;
      const parsedAlpha = Number(alpha);
      const parsedSpeed = Number(speed);
      entry.alpha = Number.isFinite(parsedAlpha) ? parsedAlpha : 1;
      entry.timeScale = Number.isFinite(parsedSpeed) ? parsedSpeed : 1;
    });
    return true;
  }

  function applySittingPose(notify = true) {
    const state = characterPlayer?.animationState;
    if (!state) return false;
    clearTimeout(motionClearTimer);
    clearTimeout(ambientIdleTimer);
    motionClearTimer = 0;
    ambientIdleTimer = 0;
    ambientIdleActive = false;
    clearMotionTracks(0.25);
    state.setEmptyAnimation(tracks.sitting, 0.35);
    if (activeStance === 'sitting' && activeSittingPose === 'agura') {
      const groups = currentGesture?.emotionalGesture?.MotionGroups ?? [];
      const group = groups.find(item => item.Label === 'LB-あぐら' && String(item.VariantIndex || '0') === '0');
      const name = group?.AnimName_1;
      if (!hasAnimation(name)) return false;
      const entry = state.setAnimation(tracks.sitting, name, true);
      entry.mixDuration = 0.35;
      entry.alpha = Number.isFinite(Number(group.Alpha1)) ? Number(group.Alpha1) : 1;
      entry.timeScale = Number.isFinite(Number(group.Speed1)) ? Number(group.Speed1) : 1;
    }
    if (currentGesture) setupMotionControls(currentGesture);
    startAmbientIdle();
    if (notify && currentGesture) window.dispatchEvent(new CustomEvent('ryza-spine-ready', { detail: getModelInfo() }));
    return true;
  }

  function ambientIdleGroups() {
    const groups = currentGesture?.emotionalGesture?.MotionGroups ?? [];
    const standing = ui.characterSelect.value.endsWith('_99');
    return groups
      .map((group, index) => ({ group, index }))
      .filter(({ group }) => isAvailableMotionGroup(group) && (standing
        ? /^(?:横揺れ|前後揺れ) 上下運動$/.test(group.Label || '')
        : /ふらふらアイドル|ぽよん上下/.test(group.Label || '')));
  }

  function startAmbientIdle(forceDifferent = false) {
    clearTimeout(ambientIdleTimer);
    if (motionClearTimer || !characterPlayer || !currentGesture) return;
    const candidates = ambientIdleGroups();
    if (!candidates.length) return;
    const choices = forceDifferent ? candidates.filter(item => item.index !== ambientIdleIndex) : candidates;
    const selected = (choices.length ? choices : candidates)[Math.floor(Math.random() * (choices.length || candidates.length))];
    if (!applyMotionGroup(selected.group, 0.45)) return;
    ambientIdleIndex = selected.index;
    ambientIdleLabel = translateMotionLabel(selected.group.Label || selected.group.GroupId);
    ambientIdleActive = true;
    ui.motionStatus.textContent = `持续待机：${ambientIdleLabel}`;
    ambientIdleTimer = setTimeout(() => startAmbientIdle(true), 8000 + Math.random() * 5000);
  }

  function scheduleAmbientIdle(delay = 400) {
    clearTimeout(ambientIdleTimer);
    ambientIdleActive = false;
    ambientIdleTimer = setTimeout(() => startAmbientIdle(true), delay);
  }

  function stopMotionGroup(showStatus = true, restoreAmbient = true) {
    clearTimeout(motionClearTimer);
    clearTimeout(ambientIdleTimer);
    motionClearTimer = 0;
    ambientIdleTimer = 0;
    ambientIdleActive = false;
    clearMotionTracks(0.3);
    if (restoreAmbient) scheduleAmbientIdle(350);
    if (showStatus) ui.motionStatus.textContent = restoreAmbient ? '已停止表演 · 正在恢复持续待机' : '已停止叠加动作';
  }

  function playMotionGroupByIndex(index, holdMs = 2600) {
    const groups = currentGesture?.emotionalGesture?.MotionGroups ?? [];
    const group = groups[index];
    if (!isUsableMotionGroup(group)) return false;
    stopMotionGroup(false, false);
    if (!applyMotionGroup(group)) return false;
    const duration = Math.min(8000, Math.max(800, Number(holdMs) || 2600));
    motionClearTimer = setTimeout(() => {
      motionClearTimer = 0;
      clearMotionTracks(Math.max(0.3, Number(group.BlendTime) || 0.6));
      scheduleAmbientIdle(500);
    }, duration);
    ui.motionStatus.textContent = `表演：${translateMotionLabel(group.Label || group.GroupId)}`;
    return true;
  }

  function playSelectedMotionGroup() {
    playMotionGroupByIndex(Number(ui.motionGroupSelect.value), 5000);
  }

  function getActionCatalog() {
    const groups = currentGesture?.emotionalGesture?.MotionGroups ?? [];
    return groups
      .map((group, index) => ({ group, index }))
      .filter(item => isAvailableMotionGroup(item.group))
      .map(({ group, index }) => ({ id: `group:${index}`, label: translateMotionLabel(group.Label || group.GroupId) }));
  }

  function markInteraction() {
    lastInteractionAt = performance.now();
    nextIdleAt = lastInteractionAt + 7000 + Math.random() * 5000;
  }

  function playTapAudio(code) {
    const variation = String(1 + Math.floor(Math.random() * 3)).padStart(2, '0');
    const base = `${hostRoot}/media/audio/tap_voice/jp/normal/jp_normal_motion_touch_A_${code}_${variation}.m4a`;
    touchVoice?.pause();
    touchVoice = new Audio(base);
    touchVoice.volume = 1;
    void touchVoice.play().catch(() => {});
  }

  function playTapReaction(part) {
    const codes = tapReactionCodes[part];
    const state = characterPlayer?.animationState;
    if (!codes?.length || !state) return false;
    const code = codes[Math.floor(Math.random() * codes.length)];
    const animation = `motion_touch_A_${code}_active`;
    const fallback = currentGesture?.projectConfig?.tapReactionAnimation;
    const selected = hasAnimation(animation) ? animation : hasAnimation(fallback) ? fallback : null;
    if (!selected) return false;
    markInteraction();
    if (motionClearTimer) stopMotionGroup(false, false);
    const entry = state.setAnimation(tracks.attitude, selected, false);
    if (entry) entry.mixDuration = Number(currentGesture?.projectConfig?.tapReactionEnterMix) || 0;
    const exitMix = Number(currentGesture?.projectConfig?.tapReactionExitMix) || 0.3;
    state.addEmptyAnimation(tracks.attitude, exitMix, 0);
    if (!ambientIdleActive) scheduleAmbientIdle(((entry?.animation?.duration || 1.2) + exitMix) * 1000);
    playTapAudio(code);
    ui.motionStatus.textContent = `触摸反应：${part} · ${selected}`;
    window.dispatchEvent(new CustomEvent('ryza-touch', { detail: { part, animation: selected } }));
    return true;
  }

  function screenToWorld(event) {
    const canvas = characterPlayer?.canvas;
    const camera = characterPlayer?.sceneRenderer?.camera;
    if (!canvas || !camera) return null;
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * canvas.clientWidth / Math.max(1, rect.width);
    const y = (event.clientY - rect.top) * canvas.clientHeight / Math.max(1, rect.height);
    const point = new spine.Vector3(x, y, 0);
    camera.screenToWorld(point, canvas.clientWidth, canvas.clientHeight);
    return point;
  }

  function hitTest(event) {
    const skeleton = characterPlayer?.skeleton;
    const point = screenToWorld(event);
    if (!skeleton || !point || !skeletonBounds) return null;
    skeletonBounds.update(skeleton, true);
    const attachment = skeletonBounds.containsPoint(point.x - skeleton.x, point.y - skeleton.y);
    return attachment?.name ? currentGesture?.projectConfig?.hitPartNames?.[attachment.name] ?? attachment.name : null;
  }

  function getInteractionRect() {
    const canvas = characterPlayer?.canvas;
    const camera = characterPlayer?.sceneRenderer?.camera;
    const skeleton = characterPlayer?.skeleton;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    try {
      if (camera && skeleton && skeletonBounds) {
        skeletonBounds.update(skeleton, true);
        const first = new spine.Vector3(skeletonBounds.minX + skeleton.x, skeletonBounds.minY + skeleton.y, 0);
        const second = new spine.Vector3(skeletonBounds.maxX + skeleton.x, skeletonBounds.maxY + skeleton.y, 0);
        camera.worldToScreen(first, canvas.clientWidth, canvas.clientHeight);
        camera.worldToScreen(second, canvas.clientWidth, canvas.clientHeight);
        const scaleX = rect.width / Math.max(1, canvas.clientWidth);
        const scaleY = rect.height / Math.max(1, canvas.clientHeight);
        const left = rect.left + Math.min(first.x, second.x) * scaleX - 14;
        const top = rect.top + Math.min(first.y, second.y) * scaleY - 14;
        const right = rect.left + Math.max(first.x, second.x) * scaleX + 14;
        const bottom = rect.top + Math.max(first.y, second.y) * scaleY + 14;
        if (right > left && bottom > top) {
          return { x: Math.max(rect.left, left), y: Math.max(rect.top, top), width: Math.min(rect.right, right) - Math.max(rect.left, left), height: Math.min(rect.bottom, bottom) - Math.max(rect.top, top) };
        }
      }
    } catch { /* Runtime 版本不提供 worldToScreen 时使用保守角色区域。 */ }
    return { x: rect.left + rect.width * 0.12, y: rect.top + rect.height * 0.03, width: rect.width * 0.76, height: rect.height * 0.9 };
  }

  function setLook(name) {
    const presets = {
      user: [0, 0.08], front: [0, 0], left: [-0.8, 0], right: [0.8, 0],
      up: [0, 0.7], down: [0, -0.7], pointer: null,
    };
    if (!(name in presets)) return false;
    lookMode = name;
    if (presets[name]) lookTarget = { x: presets[name][0], y: presets[name][1] };
    return true;
  }

  function setupLookBones() {
    const skeleton = characterPlayer?.skeleton;
    const slots = currentGesture?.rigConfig?.aimSlots ?? {};
    const project = currentGesture?.projectConfig ?? {};
    const scales = {
      center: 1,
      eye: 0.9,
      head: Number(project.fingerTrackHeadScale) || 0.7,
      body: Number(project.fingerTrackBodyScale) || 0.55,
    };
    lookBones = Object.entries(slots)
      .map(([slot, config]) => ({ bone: skeleton?.findBone(config?.bone), scale: scales[slot] ?? 0.5 }))
      .filter(item => item.bone);
  }

  function applyLookAt(player, delta) {
    const skeleton = player?.skeleton;
    if (!skeleton) return;
    let target = lookTarget;
    if (lookMode === 'pointer' && performance.now() - lastPointerAt > 4000) target = { x: 0, y: 0 };
    const alpha = 1 - Math.exp(-Math.max(0, delta) * 7);
    lookCurrent.x += (target.x - lookCurrent.x) * alpha;
    lookCurrent.y += (target.y - lookCurrent.y) * alpha;
    const maxRange = Math.min(80, (Number(currentGesture?.projectConfig?.fingerTrackMaxRange) || 500) * 0.12);
    for (const { bone, scale } of lookBones) {
      bone.x += lookCurrent.x * maxRange * scale;
      bone.y += lookCurrent.y * maxRange * scale;
    }
    skeleton.updateWorldTransform(spine.Physics.update);
  }

  function setupCharacterInteraction() {
    const canvas = characterPlayer?.canvas;
    if (!canvas) return;
    skeletonBounds = new spine.SkeletonBounds();
    setupLookBones();
    canvas.style.cursor = 'pointer';
    canvas.addEventListener('pointermove', event => {
      const rect = canvas.getBoundingClientRect();
      const x = Math.min(1, Math.max(-1, ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1));
      const y = Math.min(1, Math.max(-1, 1 - ((event.clientY - rect.top) / Math.max(1, rect.height)) * 2));
      if (lookMode === 'pointer') lookTarget = { x, y };
      lastPointerAt = performance.now();
    });
    canvas.addEventListener('pointerdown', event => {
      pointerDown = { x: event.clientX, y: event.clientY, at: performance.now() };
    });
    canvas.addEventListener('pointerup', event => {
      if (!pointerDown) return;
      const distance = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
      const elapsed = performance.now() - pointerDown.at;
      pointerDown = null;
      if (distance <= 10 && elapsed <= 600) {
        const part = hitTest(event);
        if (part) playTapReaction(part);
      }
    });
    canvas.addEventListener('pointercancel', () => { pointerDown = null; });
  }

  function idleAnimations() {
    return characterPlayer?.skeleton?.data.animations
      .map(animation => animation.name)
      .filter(name => /^motion_[A-Z]_\d+_idle$/.test(name)) ?? [];
  }

  function ensureIdleMotion() {
    const state = characterPlayer?.animationState;
    const names = idleAnimations();
    if (!state || !names.length) return;
    const current = state.getCurrent(tracks.body)?.animation?.name;
    if (!names.includes(current)) {
      const entry = setTrackAnimation(state, tracks.body, names[0], true);
      if (entry) entry.mixDuration = 0.4;
    }
    nextIdleAt = performance.now() + 4000 + Math.random() * 3000;
  }

  function maybePlayIdle() {
    const now = performance.now();
    const state = characterPlayer?.animationState;
    if (!state || now < nextIdleAt || now - lastInteractionAt < 3000 || motionClearTimer) return;
    const names = idleAnimations();
    const current = state.getCurrent(tracks.body)?.animation?.name;
    const choices = names.filter(name => name !== current);
    if (choices.length) {
      const selected = choices[Math.floor(Math.random() * choices.length)];
      const entry = setTrackAnimation(state, tracks.body, selected, true);
      if (entry) entry.mixDuration = 0.35;
      ui.motionStatus.textContent = `自然待机：${selected}`;
    }
    nextIdleAt = now + 7000 + Math.random() * 5000;
  }

  function getModelInfo() {
    const profiles = currentGesture?.emotionalGesture?.EmotionProfilesV4 ?? {};
    const moods = Object.entries(profiles).flatMap(([emotion, profile]) =>
      Object.keys(profile?.intensityProfiles ?? {}).map(intensity => `${emotion}.${intensity}`));
    const mouthParams = (characterPlayer?.skeleton?.data.animations ?? [])
      .map(animation => animation.name)
      .filter(name => /^facial_mouth_\d+_(?:idle|active)$/.test(name));
    return {
      name: ui.characterSelect.value,
      stance: activeStance,
      sittingPose: activeSittingPose,
      mouthParams,
      expressions: [],
      motions: getActionCatalog().map(action => ({ name: action.id, label: action.label })),
      primitives: {
        mood: moods,
        pose: ['idle', 'agree', 'deny', 'question'],
        stance: ['current', 'sitting', 'standing'],
        sittingPose: ['current', 'normal', 'agura'],
        look: ['user', 'front', 'left', 'right', 'up', 'down', 'pointer'],
        hold: ['800', '1200', '1800', '2400', '2600', '3200', '5000', '8000'],
      },
    };
  }

  function applyMokaMood(name) {
    lastMokaMood = String(name || '');
    const [emotion, intensity = 'normal'] = lastMokaMood.split('.');
    const profiles = currentGesture?.emotionalGesture?.EmotionProfilesV4 ?? {};
    if (!profiles[emotion]) return false;
    ui.emotionSelect.value = emotion;
    expressionIndex = 0;
    fillIntensityOptions(intensity);
    applyExpression();
    return true;
  }

  function performMokaEvent(event = {}) {
    markInteraction();
    window.dispatchEvent(new CustomEvent('ryza-moka-event', { detail: event }));
    switch (event.type) {
      case 'mood':
        return applyMokaMood(event.name);
      case 'pose':
        if (event.name === 'stance.sitting') {
          setCharacterState({ stance: 'sitting' }, true);
          return true;
        }
        if (event.name === 'stance.standing') {
          setCharacterState({ stance: 'standing' }, true);
          return true;
        }
        if (event.name === 'sitting.normal') {
          setCharacterState({ stance: 'sitting', sittingPose: 'normal' }, true);
          return true;
        }
        if (event.name === 'sitting.agura') {
          setCharacterState({ stance: 'sitting', sittingPose: 'agura' }, true);
          return true;
        }
        if (event.name === 'idle') {
          characterPlayer?.animationState?.setEmptyAnimation(tracks.attitude, 0.15);
          return true;
        }
        return playAttitude(event.name, ui.emotionSelect.value || 'neutral');
      case 'look':
        return setLook(event.name);
      case 'hold': {
        const value = Number(event.name);
        if (Number.isFinite(value)) mokaHoldMs = Math.min(8000, Math.max(800, value));
        return true;
      }
      case 'motion': {
        const index = Number(String(event.name || '').match(/^group:(\d+)$/)?.[1]);
        const played = Number.isInteger(index) && playMotionGroupByIndex(index, mokaHoldMs);
        mokaHoldMs = 2600;
        return Boolean(played);
      }
      default:
        return false;
    }
  }

  function playAttitude(attitude, emotion = 'neutral') {
    const state = characterPlayer?.animationState;
    if (!state) return false;
    state.setEmptyAnimation(tracks.attitude, 0.15);
    if (!['agree', 'deny', 'question'].includes(attitude)) return false;
    const profile = currentGesture?.emotionalGesture?.EmotionProfilesV4?.[emotion]
      ?? currentGesture?.emotionalGesture?.EmotionProfilesV4?.neutral;
    const candidates = profile?.fixedGestureBindingsByAttitude?.[attitude] ?? [];
    const selected = [...candidates]
      .filter(item => hasAnimation(item.oneShotAnimation))
      .sort((left, right) => Number(right.weight || 0) - Number(left.weight || 0))[0];
    if (!selected) return false;
    const entry = state.setAnimation(tracks.attitude, selected.oneShotAnimation, false);
    state.addEmptyAnimation(tracks.attitude, 0.2, 0);
    entry.mixDuration = 0.15;
    return true;
  }

  function fillFaceAnimationSelect(select, pattern, label) {
    const names = characterPlayer?.skeleton?.data.animations.map(item => item.name) ?? [];
    const options = [new Option(`选择${label}…`, '')];
    for (const name of names) {
      const match = name.match(pattern);
      if (match) options.push(new Option(`${label} ${match[1]}  [${name}]`, name));
    }
    select.replaceChildren(...options);
    select.disabled = options.length === 1;
  }

  function setupFaceTestControls(config) {
    fillFaceAnimationSelect(ui.eyeTestSelect, /^facial_eye_(\d+)_idle$/, '眼睛');
    fillFaceAnimationSelect(ui.eyebrowTestSelect, /^facial_eyebrow_(\d+)_idle$/, '眉毛');
    fillFaceAnimationSelect(ui.mouthTestSelect, /^facial_mouth_(\d+)_idle$/, '嘴型');
    ui.mouthTestSelect.value = currentDefaultMouth ?? '';

    const onNames = config?.projectConfig?.fxOnAnimNames ?? {};
    const seen = new Set();
    const options = [new Option('无脸部效果', '')];
    for (const [id, animation] of Object.entries(onNames)) {
      if (id.startsWith('facial_') || seen.has(animation) || !hasAnimation(animation)) continue;
      seen.add(animation);
      options.push(new Option(`${fxLabels[id] ?? id}  [${animation}]`, id));
    }
    ui.fxTestSelect.replaceChildren(...options);
    ui.fxTestSelect.disabled = options.length === 1;
  }

  function fillIntensityOptions(preferred = 'normal') {
    const profile = currentGesture?.emotionalGesture?.EmotionProfilesV4?.[ui.emotionSelect.value];
    const intensities = profile?.intensityProfiles ?? {};
    const order = ['weak', 'normal', 'strong'];
    ui.intensitySelect.replaceChildren(...order
      .filter(id => intensities[id])
      .map(id => new Option(intensityLabels[id] ?? id, id)));
    ui.intensitySelect.value = intensities[preferred] ? preferred : Object.keys(intensities)[0] ?? '';
  }

  function expressionCode(expression) {
    const number = name => name?.match(/_(\d+)/)?.[1] ?? '—';
    return `E${number(expression.eyeOpen)} · B${number(expression.eyebrow)} · M${number(expression.mouth)}`;
  }

  function applyExpression(reroll = false) {
    const emotion = ui.emotionSelect.value;
    const intensity = ui.intensitySelect.value;
    const profile = currentGesture?.emotionalGesture?.EmotionProfilesV4?.[emotion]?.intensityProfiles?.[intensity];
    const expressions = profile?.expressionSets ?? [];
    if (!characterPlayer || !expressions.length) {
      ui.expressionStatus.textContent = '当前模型没有可用表情集';
      return;
    }

    // 确定性顺序循环，替代原“最远距离”随机选择（交接文档 §13-4）。
    if (reroll) expressionIndex = (expressionIndex + 1) % expressions.length;
    if (expressionIndex >= expressions.length) expressionIndex = 0;
    const expression = expressions[expressionIndex];
    currentExpression = expression;
    setExpressionTrack(tracks.eye, expression.eyeOpen);
    setExpressionTrack(tracks.eyebrow, expression.eyebrow);
    // ExpressionSet 的 mouth 仅作候选，默认不接管闭嘴基线（交接文档 §7）。
    if (ui.mouthTakeover.checked && expression.mouth) {
      setExpressionTrack(tracks.mouth, expression.mouth);
    } else {
      applyDefaultMouth();
    }

    const effects = profile.effectSets ?? [];
    const effect = effects.length ? effects[expressionIndex % effects.length]?.names?.[0] : null;
    setFacialFx(effect);
    ui.expressionStatus.textContent = `${emotionLabels[emotion] ?? emotion} · ${intensityLabels[intensity] ?? intensity} · ${expressionIndex + 1}/${expressions.length} · ${expressionCode(expression)}`;
  }

  function clearExpression() {
    const state = characterPlayer?.animationState;
    if (!state) return;
    state.setEmptyAnimation(tracks.eye, 0.2);
    state.setEmptyAnimation(tracks.eyebrow, 0.2);
    state.setEmptyAnimation(tracks.fx, 0.2);
    currentFx = null;
    currentExpression = null;
    expressionIndex = 0;
    applyDefaultMouth();
    ui.eyeTestSelect.value = '';
    ui.eyebrowTestSelect.value = '';
    ui.mouthTestSelect.value = currentDefaultMouth ?? '';
    ui.fxTestSelect.value = '';
    ui.expressionStatus.textContent = '已清除表情 · 仅保留默认闭嘴';
  }

  function setupExpressionControls(config) {
    currentGesture = config;
    currentFx = null;
    currentExpression = null;
    expressionIndex = 0;
    const profiles = config?.emotionalGesture?.EmotionProfilesV4 ?? {};
    const emotions = Object.keys(profiles);
    ui.emotionSelect.replaceChildren(...emotions.map(id => new Option(emotionLabels[id] ?? id, id)));
    ui.emotionSelect.value = emotions.includes('neutral') ? 'neutral' : emotions[0] ?? '';
    ui.emotionSelect.disabled = !emotions.length;
    ui.intensitySelect.disabled = !emotions.length;
    ui.rerollExpression.disabled = !emotions.length;
    ui.clearExpression.disabled = false;
    ui.mouthTakeover.disabled = !emotions.length;
    fillIntensityOptions();
    setupMotionControls(config);
    setupFaceTestControls(config);
    // 临时关闭自动 ExpressionSet 调度（交接文档 §13-4）：不在加载后自动 applyExpression。
    ui.expressionStatus.textContent = emotions.length
      ? '自动调度已关闭 · 手动选择后生效'
      : '当前模型没有表情配置';
  }

  function disableExpressionControls(message = '表情配置加载中…') {
    currentGesture = null;
    currentFx = null;
    currentExpression = null;
    currentDefaultMouth = null;
    ui.emotionSelect.disabled = true;
    ui.intensitySelect.disabled = true;
    ui.rerollExpression.disabled = true;
    ui.clearExpression.disabled = true;
    ui.mouthTakeover.disabled = true;
    ui.motionSelect.disabled = true;
    ui.playMotion.disabled = true;
    ui.motionGroupSelect.disabled = true;
    ui.playMotionGroup.disabled = true;
    ui.stopMotionGroup.disabled = true;
    ui.allAnimationSelect.disabled = true;
    ui.playAllAnimation.disabled = true;
    ui.tapPartSelect.disabled = true;
    ui.playTapReaction.disabled = true;
    ui.eyeTestSelect.disabled = true;
    ui.eyebrowTestSelect.disabled = true;
    ui.mouthTestSelect.disabled = true;
    ui.fxTestSelect.disabled = true;
    ui.motionStatus.textContent = message;
    ui.expressionStatus.textContent = message;
  }

  // 轨道可观察性（交接文档 §9 第四步）：区分“动画没播”与“被高轨覆盖”。
  function updateTrackDebug(player) {
    if (!ui.trackDebug) return;
    const state = player?.animationState;
    const lines = trackLabels.map((label, index) => {
      const entry = state?.tracks?.[index];
      return entry?.animation
        ? `${label}  ${entry.animation.name} · t=${entry.trackTime.toFixed(1)}`
        : `${label}  —`;
    });
    lines.push(`表情组 ${currentExpression ? expressionCode(currentExpression) : '—'} · FX ${currentFx ?? '—'} · 默认嘴 ${currentDefaultMouth ?? '—'}`);
    const text = lines.join('\n');
    if (text !== lastDebugText) {
      lastDebugText = text;
      ui.trackDebug.textContent = text;
    }
  }

  function loadCharacter() {
    const id = ui.characterSelect.value;
    activeStance = id.endsWith('_99') ? 'standing' : 'sitting';
    const request = ++characterRequest;
    clearTimeout(motionClearTimer);
    clearTimeout(ambientIdleTimer);
    motionClearTimer = 0;
    ambientIdleTimer = 0;
    ambientIdleIndex = -1;
    ambientIdleLabel = '';
    ambientIdleActive = false;
    currentGesture = null;
    const gesturePromise = loadGesture(id).catch(error => {
      console.error('表情配置加载失败：', error);
      return null;
    });

    setGlobalStatus('loading', '正在加载角色');
    disableExpressionControls();
    ui.overlay.classList.remove('hidden');
    ui.activeCharacter.textContent = id;
    disposePlayer(characterPlayer, ui.characterLayer);
    characterPlayer = null;

    try {
      characterPlayer = new spine.SpinePlayer(ui.characterLayer, {
        skeleton: characterPath(id, 'skel'),
        atlas: characterAtlasPath(id),
        alpha: true,
        backgroundColor: '#00000000',
        fullScreenBackgroundColor: '#17151f',
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
        interactive: false,
        showControls: ui.controlsVisible.checked && !desktopMode,
        showLoading: false,
        animation: 'motion_A_001_idle',
        defaultMix: 0.2,
        debug: characterDebug,
        viewport: {
          padLeft: '4%',
          padRight: '4%',
          padTop: '3%',
          padBottom: '8%',
        },
        updateWorldTransform(player, delta) {
          applyLookAt(player, delta);
        },
        update(player) {
          maybePlayIdle();
          updateTrackDebug(player);
        },
        async success(player) {
          if (request !== characterRequest) return;
          ensureIdleMotion();
          applyDefaultMouth();
          const gesture = await gesturePromise;
          if (request !== characterRequest) return;
          if (gesture) {
            setupExpressionControls(gesture);
            setupCharacterInteraction();
            applySittingPose(false);
            if (lastMokaMood) applyMokaMood(lastMokaMood);
            window.dispatchEvent(new CustomEvent('ryza-spine-ready', { detail: getModelInfo() }));
          } else {
            disableExpressionControls('表情配置不可用，已降级为单动画播放');
          }
          const animationCount = player.skeleton?.data.animations.length ?? 0;
          setGlobalStatus('success', `已载入 · ${animationCount} 个动画`);
          ui.overlay.classList.add('hidden');
        },
        error(_player, message) {
          if (request !== characterRequest) return;
          setGlobalStatus('error', '角色加载失败');
          ui.overlay.classList.add('hidden');
          console.error('角色加载失败：', message);
        },
      });
    } catch (error) {
      setGlobalStatus('error', '运行时不可用');
      ui.overlay.classList.add('hidden');
      console.error(error);
    }
  }

  function loadScene() {
    if (desktopMode) {
      disposePlayer(scenePlayer, ui.sceneLayer);
      scenePlayer = null;
      return;
    }
    const id = ui.sceneSelect.value;
    if (!id) {
      ui.sceneStatus.textContent = '没有匹配的场景';
      return;
    }

    const request = ++sceneRequest;
    ui.activeScene.textContent = id;
    ui.sceneStatus.textContent = '场景加载中…';
    disposePlayer(scenePlayer, ui.sceneLayer);
    scenePlayer = null;

    try {
      scenePlayer = new spine.SpinePlayer(ui.sceneLayer, {
        skeleton: scenePath(id, 'skel'),
        atlas: scenePath(id, 'atlas'),
        alpha: true,
        backgroundColor: '#00000000',
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        showControls: false,
        showLoading: false,
        interactive: false,
        viewport: {
          padLeft: 0,
          padRight: 0,
          padTop: 0,
          padBottom: 0,
        },
        success() {
          if (request !== sceneRequest) return;
          ui.sceneStatus.textContent = `场景已载入 · ${labels[id.slice(-3)]}`;
        },
        error(_player, message) {
          if (request !== sceneRequest) return;
          ui.sceneStatus.textContent = '场景加载失败';
          console.error('场景加载失败：', message);
        },
      });
    } catch (error) {
      ui.sceneStatus.textContent = '场景运行时不可用';
      console.error(error);
    }
  }

  function characterLabel(id) {
    return id.endsWith('_99') ? '站姿（99）' : '坐姿（01）';
  }

  function sceneLabel(id) {
    const [, area, location, variant, period] = id.split('_');
    return `区域 ${area} · ${location}-${variant} · ${labels[period]}`;
  }

  function fillCharacters() {
    const fragment = document.createDocumentFragment();
    for (const id of assets.characters) {
      const option = new Option(characterLabel(id), id);
      fragment.append(option);
    }
    ui.characterSelect.replaceChildren(fragment);
    ui.characterSelect.value = defaults.character;
  }

  function filteredScenes() {
    const query = ui.sceneSearch.value.trim().toLowerCase();
    const period = ui.periodFilter.value;
    return assets.scenes.filter(id =>
      (!query || id.toLowerCase().includes(query)) &&
      (period === 'all' || id.endsWith(`_${period}`))
    );
  }

  function fillScenes(preferred = ui.sceneSelect.value || defaults.scene) {
    const matches = filteredScenes();
    const fragment = document.createDocumentFragment();
    let currentArea = '';
    let group = null;

    for (const id of matches) {
      const area = id.split('_')[1];
      if (area !== currentArea) {
        currentArea = area;
        group = document.createElement('optgroup');
        group.label = `区域 ${area}`;
        fragment.append(group);
      }
      group.append(new Option(sceneLabel(id), id));
    }

    ui.sceneSelect.replaceChildren(fragment);
    ui.sceneSelect.disabled = matches.length === 0;
    if (matches.includes(preferred)) ui.sceneSelect.value = preferred;
    return matches;
  }

  function filterSceneList() {
    const previous = ui.sceneSelect.value;
    const matches = fillScenes(previous);
    if (matches.length && ui.sceneSelect.value !== previous) loadScene();
    if (!matches.length) {
      ui.activeScene.textContent = '—';
      ui.sceneStatus.textContent = '没有匹配的场景';
    }
  }

  function syncViewOptions() {
    ui.sceneLayer.classList.toggle('hidden', desktopMode || !ui.sceneVisible.checked);
    ui.viewport.classList.toggle('checkerboard', !desktopMode && ui.checkerVisible.checked);
    ui.viewport.style.backgroundColor = desktopMode ? 'transparent' : ui.canvasColor.value;
  }

  function reloadAll() {
    loadScene();
    loadCharacter();
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await ui.viewport.requestFullscreen();
      }
    } catch (error) {
      setGlobalStatus('error', '无法进入全屏');
      console.error(error);
    }
  }

  function reset() {
    ui.characterSelect.value = defaults.character;
    activeStance = defaults.stance;
    activeSittingPose = defaults.sittingPose;
    ui.sceneSearch.value = '';
    ui.periodFilter.value = defaults.period;
    ui.sceneVisible.checked = true;
    ui.controlsVisible.checked = true;
    ui.checkerVisible.checked = true;
    ui.canvasColor.value = defaults.color;
    ui.mouthTakeover.checked = false;
    ui.attitudeTestSelect.value = 'idle';
    ui.lookTestSelect.value = 'pointer';
    ui.hitDebugVisible.checked = false;
    characterDebug.bounds = false;
    setLook('pointer');
    fillScenes(defaults.scene);
    syncViewOptions();
    reloadAll();
    scheduleCharacterSave();
  }

  function bindEvents() {
    ui.characterSelect.addEventListener('change', () => {
      activeStance = ui.characterSelect.value.endsWith('_99') ? 'standing' : 'sitting';
      loadCharacter();
      scheduleCharacterSave();
    });
    ui.sceneSelect.addEventListener('change', loadScene);
    ui.sceneSearch.addEventListener('input', filterSceneList);
    ui.periodFilter.addEventListener('change', filterSceneList);
    ui.sceneVisible.addEventListener('change', syncViewOptions);
    ui.checkerVisible.addEventListener('change', syncViewOptions);
    ui.canvasColor.addEventListener('input', syncViewOptions);
    ui.controlsVisible.addEventListener('change', loadCharacter);
    ui.emotionSelect.addEventListener('change', () => {
      expressionIndex = 0;
      fillIntensityOptions();
      applyExpression();
    });
    ui.intensitySelect.addEventListener('change', () => {
      expressionIndex = 0;
      applyExpression();
    });
    ui.rerollExpression.addEventListener('click', () => applyExpression(true));
    ui.playMotion.addEventListener('click', playSelectedMotion);
    ui.playMotionGroup.addEventListener('click', playSelectedMotionGroup);
    ui.stopMotionGroup.addEventListener('click', () => stopMotionGroup());
    ui.playAllAnimation.addEventListener('click', playSelectedRawAnimation);
    ui.applyPoseLook.addEventListener('click', () => {
      const attitude = ui.attitudeTestSelect.value;
      if (attitude === 'idle') characterPlayer?.animationState?.setEmptyAnimation(tracks.attitude, 0.15);
      else playAttitude(attitude, ui.emotionSelect.value || 'neutral');
      setLook(ui.lookTestSelect.value);
      markInteraction();
    });
    ui.playTapReaction.addEventListener('click', () => playTapReaction(ui.tapPartSelect.value));
    ui.hitDebugVisible.addEventListener('change', () => { characterDebug.bounds = ui.hitDebugVisible.checked; });
    ui.clearExpression.addEventListener('click', clearExpression);
    ui.mouthTakeover.addEventListener('change', () => {
      if (!characterPlayer) return;
      if (ui.mouthTakeover.checked && currentExpression?.mouth) {
        setExpressionTrack(tracks.mouth, currentExpression.mouth);
      } else {
        applyDefaultMouth();
        ui.mouthTestSelect.value = currentDefaultMouth ?? '';
      }
    });
    ui.eyeTestSelect.addEventListener('change', () => {
      if (ui.eyeTestSelect.value) setExpressionTrack(tracks.eye, ui.eyeTestSelect.value);
    });
    ui.eyebrowTestSelect.addEventListener('change', () => {
      if (ui.eyebrowTestSelect.value) setExpressionTrack(tracks.eyebrow, ui.eyebrowTestSelect.value);
    });
    ui.mouthTestSelect.addEventListener('change', () => {
      if (ui.mouthTestSelect.value) setExpressionTrack(tracks.mouth, ui.mouthTestSelect.value);
    });
    ui.fxTestSelect.addEventListener('change', () => setFacialFx(ui.fxTestSelect.value || null));
    ui.reloadButton.addEventListener('click', reloadAll);
    ui.applyButton.addEventListener('click', reloadAll);
    ui.resetButton.addEventListener('click', reset);
    ui.fullscreenButton.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', () => {
      const active = Boolean(document.fullscreenElement);
      ui.fullscreenButton.textContent = active ? '×' : '⛶';
      ui.fullscreenButton.title = active ? '退出全屏' : '全屏预览';
      ui.fullscreenButton.setAttribute('aria-label', ui.fullscreenButton.title);
    });
  }

  function setupTrackDebugPanel() {
    if (!ui.trackDebugPanel) return;
    try { ui.trackDebugPanel.open = localStorage.getItem(trackDebugOpenKey) === '1'; } catch { ui.trackDebugPanel.open = false; }
    ui.trackDebugPanel.addEventListener('toggle', () => {
      try { localStorage.setItem(trackDebugOpenKey, ui.trackDebugPanel.open ? '1' : '0'); } catch { /* 本地存储不可用时仍可临时折叠。 */ }
    });
  }

  async function init() {
    ui.characterCount.textContent = assets.characters.length;
    ui.sceneCount.textContent = assets.scenes.length;
    fillCharacters();
    fillScenes(defaults.scene);
    syncViewOptions();
    setupTrackDebugPanel();
    bindEvents();
    try {
      const response = await fetch(`${hostRoot}/app/health`, { cache: 'no-store' });
      const saved = response.ok ? (await response.json()).character : null;
      if (saved) {
        activeStance = ['sitting', 'standing'].includes(saved.stance) ? saved.stance : defaults.stance;
        activeSittingPose = ['normal', 'agura'].includes(saved.sittingPose) ? saved.sittingPose : defaults.sittingPose;
        ui.characterSelect.value = characterIdForStance(activeStance);
      }
    } catch { /* 使用默认坐姿。 */ }
    reloadAll();
  }

  window.RYZA_SPINE_API = Object.freeze({
    isReady: () => Boolean(characterPlayer && currentGesture),
    applyPerformance,
    getActionCatalog,
    getModelInfo,
    getInteractionRect,
    performMokaEvent,
    markInteraction,
    setLook,
    setCharacterState,
    characterSettings,
    playTapReaction,
    hitTestAt(clientX, clientY) {
      return hitTest({ clientX, clientY });
    },
    setHitDebug(enabled) {
      characterDebug.bounds = Boolean(enabled);
      return characterDebug.bounds;
    },
    getDebugSnapshot() {
      if (skeletonBounds && characterPlayer?.skeleton) skeletonBounds.update(characterPlayer.skeleton, true);
      return {
        model: ui.characterSelect.value,
        stance: activeStance,
        sittingPose: activeSittingPose,
        animations: characterPlayer?.skeleton?.data.animations.map(animation => animation.name) ?? [],
        hitBoxes: skeletonBounds?.boundingBoxes.map(box => box.name) ?? [],
        lookBones: lookBones.map(item => ({ name: item.bone.data?.name || item.bone.name, x: item.bone.x, y: item.bone.y })),
        lookMode,
        lipLevel: currentLipLevel,
        ambientIdleActive,
        ambientIdleIndex,
        ambientIdleLabel,
        mouthScrub: mouthScrubName,
        mouthScrubTime: mouthScrubEntry?.trackTime ?? 0,
        tracks: (characterPlayer?.animationState?.tracks ?? []).map(entry => entry?.animation?.name ?? null),
      };
    },
    setMouthTransitionMs,
    setMouthOpen,
    resetMouth: applyDefaultMouth,
    stopMotions() {
      mokaHoldMs = 2600;
      stopMotionGroup(false, true);
      characterPlayer?.animationState?.setEmptyAnimation(tracks.attitude, 0.15);
    },
  });

  if (!assets || !window.spine?.SpinePlayer) {
    setGlobalStatus('error', '运行时加载失败');
    ui.overlay.classList.add('hidden');
  } else {
    init();
  }
})();
