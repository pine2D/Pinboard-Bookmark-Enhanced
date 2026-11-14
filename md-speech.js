// ============================================================
// Pinboard Bookmark Enhanced - Reader Short Voice Input (DeepSeek ASR)
// Opt-in short audio dictation (<= 120s / <= 8 MiB) -> 16 kHz 16-bit mono PCM
// WAV -> POST https://api.deepseek.com/v1/tools/asr -> editable textarea insert.
// ============================================================

const PBP_ASR_SAMPLE_RATE = 16000;
const PBP_ASR_WARN_SECONDS = 115;
const PBP_ASR_MAX_SECONDS = 120;
const PBP_ASR_MAX_SAMPLES = PBP_ASR_SAMPLE_RATE * PBP_ASR_MAX_SECONDS;
const PBP_ASR_MAX_BYTES = 8 * 1024 * 1024;
const PBP_ASR_TIMEOUT_MS = 60000;

function pbpAsrMixToMono(channelArrays) {
  if (!Array.isArray(channelArrays) || channelArrays.length === 0) return new Float32Array(0);
  const first = channelArrays[0];
  const length = first && Number.isInteger(first.length) ? first.length : 0;
  if (length <= 0) return new Float32Array(0);
  if (channelArrays.length === 1) {
    return first instanceof Float32Array ? first : Float32Array.from(first);
  }
  const out = new Float32Array(length);
  const count = channelArrays.length;
  for (let ch = 0; ch < count; ch++) {
    const src = channelArrays[ch];
    if (!src) continue;
    const lim = Math.min(length, src.length);
    for (let i = 0; i < lim; i++) {
      out[i] += (Number(src[i]) || 0) / count;
    }
  }
  return out;
}

function pbpAsrDownsampleFloat32(samples, inRate, outRate = PBP_ASR_SAMPLE_RATE) {
  if (!samples || !samples.length || !Number.isFinite(inRate) || inRate <= 0 || !Number.isFinite(outRate) || outRate <= 0) {
    return new Float32Array(0);
  }
  if (Math.round(inRate) === Math.round(outRate)) {
    return samples instanceof Float32Array ? samples : Float32Array.from(samples);
  }
  const outLength = Math.max(1, Math.round((samples.length * outRate) / inRate));
  const out = new Float32Array(outLength);
  const ratio = inRate / outRate;
  if (ratio > 1) {
    let offsetBuffer = 0;
    for (let i = 0; i < outLength; i++) {
      const nextOffset = Math.min(samples.length, Math.round((i + 1) * ratio));
      let sum = 0;
      let count = 0;
      for (let j = offsetBuffer; j < nextOffset; j++) {
        sum += Number(samples[j]) || 0;
        count += 1;
      }
      out[i] = count > 0 ? sum / count : (Number(samples[Math.min(offsetBuffer, samples.length - 1)]) || 0);
      offsetBuffer = nextOffset;
    }
    return out;
  }
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const i0 = Math.min(samples.length - 1, Math.floor(pos));
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = (Number(samples[i0]) || 0) * (1 - frac) + (Number(samples[i1]) || 0) * frac;
  }
  return out;
}

function _pbpAsrWriteWavHeader(view, bytes, rate, dataBytes) {
  const writeAscii = (off, str) => {
    for (let i = 0; i < str.length; i++) bytes[off + i] = str.charCodeAt(i) & 0xff;
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byteRate = sampleRate * channels * 2
  view.setUint16(32, 2, true); // blockAlign = channels * 2
  view.setUint16(34, 16, true); // bitsPerSample
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
}

function pbpAsrEncodePcm16Wav(float32Mono, sampleRate = PBP_ASR_SAMPLE_RATE) {
  const samples = float32Mono && float32Mono.length ? float32Mono : new Float32Array(0);
  const rate = Math.max(4000, Math.min(192000, Math.round(Number(sampleRate) || PBP_ASR_SAMPLE_RATE)));
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  _pbpAsrWriteWavHeader(view, bytes, rate, dataBytes);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const raw = Number(samples[i]);
    const clamped = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
    const pcm = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(offset, pcm, true);
    offset += 2;
  }
  return bytes;
}

async function pbpAsrDecodeToWavBytes(blob) {
  if (!blob || typeof blob.arrayBuffer !== "function") {
    throw new Error("asr_empty_audio");
  }
  const rawBuf = await blob.arrayBuffer();
  if (!rawBuf || rawBuf.byteLength === 0) {
    throw new Error("asr_empty_audio");
  }
  const rawBytes = new Uint8Array(rawBuf);
  if (typeof pbpValidateWavBytes === "function") {
    const precheck = pbpValidateWavBytes(rawBytes);
    if (precheck.ok && precheck.sampleRate === PBP_ASR_SAMPLE_RATE && precheck.channels === 1
        && precheck.audioFormat === 1 && precheck.bitsPerSample === 16) {
      const maxDataBytes = PBP_ASR_MAX_SAMPLES * 2;
      if (precheck.dataSize <= maxDataBytes) {
        if (rawBytes.byteLength > PBP_ASR_MAX_BYTES) throw new Error("asr_too_large");
        return rawBytes;
      }
      const evenMaxBytes = maxDataBytes - (maxDataBytes & 1);
      const trimmedPcm = rawBytes.subarray(precheck.dataOffset, precheck.dataOffset + evenMaxBytes);
      const cappedBuf = new ArrayBuffer(44 + trimmedPcm.byteLength);
      const cappedBytes = new Uint8Array(cappedBuf);
      _pbpAsrWriteWavHeader(new DataView(cappedBuf), cappedBytes, PBP_ASR_SAMPLE_RATE, trimmedPcm.byteLength);
      cappedBytes.set(trimmedPcm, 44);
      return cappedBytes;
    }
  }
  const Ctx = typeof AudioContext === "function"
    ? AudioContext
    : (typeof window !== "undefined" ? window.webkitAudioContext : null);
  if (typeof Ctx !== "function") {
    throw new Error("asr_audio_context_unavailable");
  }
  const ctx = new Ctx();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(rawBuf.slice(0));
  } finally {
    try { await ctx.close(); } catch (_) { /* swallow-ok: AudioContext close cleanup */ }
  }
  if (!decoded || !decoded.length || decoded.duration <= 0) {
    throw new Error("asr_empty_audio");
  }
  let mono = null;
  if (typeof OfflineAudioContext === "function") {
    try {
      const targetFrames = Math.min(PBP_ASR_MAX_SAMPLES, Math.max(1, Math.ceil(decoded.duration * PBP_ASR_SAMPLE_RATE)));
      const offline = new OfflineAudioContext(1, targetFrames, PBP_ASR_SAMPLE_RATE);
      const source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start(0, 0, PBP_ASR_MAX_SECONDS);
      const rendered = await offline.startRendering();
      mono = rendered.getChannelData(0);
    } catch (e) {
      console.warn("[md-speech] OfflineAudioContext resample fell back to pure downsampler:", e?.name, e?.message);
    }
  }
  if (!mono) {
    const maxInFrames = Math.max(1, Math.ceil(decoded.sampleRate * PBP_ASR_MAX_SECONDS));
    const channels = [];
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const chData = decoded.getChannelData(ch);
      channels.push(chData.length > maxInFrames ? chData.subarray(0, maxInFrames) : chData);
    }
    mono = pbpAsrDownsampleFloat32(pbpAsrMixToMono(channels), decoded.sampleRate, PBP_ASR_SAMPLE_RATE);
  }
  if (!mono || mono.length === 0) {
    throw new Error("asr_empty_audio");
  }
  if (mono.length > PBP_ASR_MAX_SAMPLES) {
    mono = mono.subarray(0, PBP_ASR_MAX_SAMPLES);
  }
  const wavBytes = pbpAsrEncodePcm16Wav(mono, PBP_ASR_SAMPLE_RATE);
  if (wavBytes.byteLength > PBP_ASR_MAX_BYTES) {
    throw new Error("asr_too_large");
  }
  return wavBytes;
}

function pbpAsrBuildFormData(wavBytes, fileName = "speech.wav") {
  const fd = new FormData();
  const safeName = typeof fileName === "string" && fileName.trim() ? fileName.trim() : "speech.wav";
  const file = typeof File === "function"
    ? new File([wavBytes], safeName, { type: "audio/wav" })
    : new Blob([wavBytes], { type: "audio/wav" });
  if (typeof File === "function") fd.append("file", file);
  else fd.append("file", file, safeName);
  return fd;
}

function pbpAsrParseResponse(status, rawBodyText) {
  const trimmed = String(rawBodyText || "").trim();
  let parsed = null;
  if (trimmed) {
    try {
      parsed = JSON.parse(trimmed);
    } catch (_) {
      /* swallow-ok: non-JSON error body handled below */
    }
  }
  const errObj = parsed && typeof parsed === "object" ? parsed.error : null;
  const errMsg = typeof errObj === "string"
    ? errObj
    : (errObj && typeof errObj.message === "string" ? errObj.message : "");
  if (status === 401 || status === 403) {
    return { ok: false, code: "auth", message: errMsg || "Unauthorized" };
  }
  if (status === 413) {
    return { ok: false, code: "too_large", message: errMsg || "Payload too large" };
  }
  if (status < 200 || status >= 300 || errObj) {
    return { ok: false, code: "api_error", message: errMsg || ("HTTP " + status) };
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.text !== "string") {
    return { ok: false, code: "bad_payload", message: "Malformed ASR payload" };
  }
  return {
    ok: true,
    text: parsed.text.trim(),
    requestId: typeof parsed.request_id === "string" ? parsed.request_id : "",
    durationMs: Number(parsed.duration_ms) || 0,
  };
}

function pbpAsrInsertTranscript(textarea, transcript) {
  if (!textarea || textarea.disabled || textarea.readOnly) return false;
  const clean = String(transcript || "").trim();
  if (!clean) return false;
  const cur = String(textarea.value || "");
  const hasSel = Number.isInteger(textarea.selectionStart) && Number.isInteger(textarea.selectionEnd);
  const start = hasSel ? Math.max(0, Math.min(cur.length, textarea.selectionStart)) : cur.length;
  const end = hasSel ? Math.max(start, Math.min(cur.length, textarea.selectionEnd)) : cur.length;
  const before = cur.slice(0, start);
  const after = cur.slice(end);
  const needSpaceBefore = before.length > 0 && /[^\s\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]$/.test(before)
    && /^[^\s\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(clean);
  const needSpaceAfter = after.length > 0 && /[^\s\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]$/.test(clean)
    && /^[^\s\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(after);
  let chunk = (needSpaceBefore ? " " : "") + clean + (needSpaceAfter ? " " : "");
  const maxLen = Number(textarea.maxLength);
  if (Number.isInteger(maxLen) && maxLen > 0) {
    const budget = Math.max(0, maxLen - before.length - after.length);
    if (budget <= 0) return false;
    if (chunk.length > budget) chunk = chunk.slice(0, budget);
  }
  textarea.value = before + chunk + after;
  const caret = before.length + chunk.length;
  try { textarea.setSelectionRange(caret, caret); } catch (_) { /* swallow-ok: detached or non-selectable input */ }
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  try { textarea.focus({ preventScroll: true }); } catch (_) { /* swallow-ok: focus optional */ }
  return true;
}

// ---- Interactive Reader Recording Controller ----
const _pbpSpeechTargets = new Map();
let _pbpSpeechEnabled = false;
let _pbpSpeechDeepseekKey = "";
let _pbpSpeechOriginGranted = false;
let _pbpSpeechConfigLoaded = false;
let _pbpSpeechConfigPromise = null;
let _pbpSpeechConfigDirty = false;
let _pbpSpeechSession = null;
let _pbpSpeechSeq = 0;

function _pbpSpeechFormatClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function _pbpSpeechSyncTargetIdle(target, keepStatus = false) {
  if (!target) return;
  const btn = target.button;
  if (btn) {
    btn.hidden = !_pbpSpeechEnabled;
    delete btn.dataset.voiceState;
    btn.setAttribute("aria-pressed", "false");
    btn.removeAttribute("aria-busy");
    btn.innerHTML = typeof PBP_ICONS !== "undefined" ? PBP_ICONS.mic : "";
    const label = typeof t === "function" ? t("mdAsrMicStart") : "Voice input";
    btn.title = label;
    btn.setAttribute("aria-label", label);
  }
  if (!keepStatus && target.statusEl) {
    target.statusEl.textContent = "";
    delete target.statusEl.dataset.tone;
    target.statusEl.hidden = true;
  }
  if (typeof target.onLayoutChange === "function") target.onLayoutChange();
}

function _pbpSpeechShowStatus(target, text, tone = "info") {
  if (!target || !target.statusEl) return;
  if (!text || !_pbpSpeechEnabled) {
    target.statusEl.textContent = "";
    delete target.statusEl.dataset.tone;
    target.statusEl.hidden = true;
  } else {
    target.statusEl.textContent = text;
    target.statusEl.dataset.tone = tone;
    target.statusEl.hidden = false;
  }
  if (typeof target.onLayoutChange === "function") target.onLayoutChange();
}

function _pbpSpeechStopTracks(stream) {
  if (!stream || typeof stream.getTracks !== "function") return;
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch (_) { /* swallow-ok: MediaStreamTrack cleanup */ }
  }
}

async function pbpSpeechRefreshConfig() {
  if (_pbpSpeechConfigPromise) {
    _pbpSpeechConfigDirty = true;
    return _pbpSpeechConfigPromise;
  }
  _pbpSpeechConfigPromise = (async () => {
    try {
      do {
        _pbpSpeechConfigDirty = false;
        let settings = null;
        if (typeof pbpReadSettingsWithSecrets === "function") {
          settings = await pbpReadSettingsWithSecrets({ readerVoiceInputEnabled: false, deepseekApiKey: "" });
        } else if (typeof chrome !== "undefined" && chrome?.storage?.local?.get) {
          settings = await chrome.storage.local.get({ readerVoiceInputEnabled: false, deepseekApiKey: "" });
        }
        if (settings) {
          _pbpSpeechEnabled = settings.readerVoiceInputEnabled === true;
          const rawKey = String(settings.deepseekApiKey || "").trim();
          _pbpSpeechDeepseekKey = rawKey && typeof deobfuscateKey === "function"
            ? String(deobfuscateKey(rawKey) || "").trim()
            : rawKey;
        }
        const origin = typeof PBP_DEEPSEEK_FETCH_ORIGIN_PATTERN === "string"
          ? PBP_DEEPSEEK_FETCH_ORIGIN_PATTERN
          : "https://api.deepseek.com/*";
        if (typeof chrome !== "undefined" && chrome?.permissions?.contains) {
          _pbpSpeechOriginGranted = !!(await chrome.permissions.contains({ origins: [origin] }));
        }
        _pbpSpeechConfigLoaded = true;
        if (
          !_pbpSpeechEnabled
          || !_pbpSpeechDeepseekKey
          || (!_pbpSpeechOriginGranted && !(_pbpSpeechSession && _pbpSpeechSession.awaitingPerm))
        ) {
          pbpSpeechCancelAll();
        }
        for (const target of _pbpSpeechTargets.values()) {
          if (!_pbpSpeechSession || _pbpSpeechSession.targetId !== target.id || _pbpSpeechSession.pending) {
            _pbpSpeechSyncTargetIdle(target, false);
          } else if (target.button) {
            target.button.hidden = !_pbpSpeechEnabled;
          }
        }
      } while (_pbpSpeechConfigDirty);
    } catch (e) {
      console.warn("[md-speech] config refresh failed:", e?.name, e?.message);
    } finally {
      _pbpSpeechConfigPromise = null;
    }
  })();
  return _pbpSpeechConfigPromise;
}

function pbpSpeechCancelTarget(targetId) {
  const target = _pbpSpeechTargets.get(targetId);
  if (_pbpSpeechSession && _pbpSpeechSession.targetId === targetId) {
    const sess = _pbpSpeechSession;
    _pbpSpeechSession = null;
    _pbpSpeechSeq += 1;
    sess.cancelled = true;
    clearInterval(sess.timer);
    if (sess.recorder && sess.recorder.state !== "inactive") {
      try { sess.recorder.stop(); } catch (_) { /* swallow-ok: recorder stop */ }
    }
    _pbpSpeechStopTracks(sess.stream);
    if (sess.abortCtrl) {
      try { sess.abortCtrl.abort(); } catch (_) { /* swallow-ok: abort cleanup */ }
    }
  }
  if (target) _pbpSpeechSyncTargetIdle(target, false);
}

function pbpSpeechCancelAll() {
  for (const id of _pbpSpeechTargets.keys()) {
    pbpSpeechCancelTarget(id);
  }
}

function _pbpSpeechPickMimeType() {
  if (typeof MediaRecorder !== "function" || typeof MediaRecorder.isTypeSupported !== "function") return "";
  for (const mime of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch (_) { /* swallow-ok: browser mime probe */ }
  }
  return "";
}

async function _pbpSpeechFinishRecording(sess) {
  if (!sess || _pbpSpeechSession !== sess || sess.finishing) return;
  sess.finishing = true;
  clearInterval(sess.timer);
  const target = _pbpSpeechTargets.get(sess.targetId);
  const token = sess.token;
  try {
    if (!sess.stopped && sess.recorder && sess.recorder.state !== "inactive") {
      await new Promise((resolve) => {
        sess.onStopResolve = resolve;
        try {
          sess.recorder.stop();
        } catch (_) {
          /* swallow-ok: recorder already stopped */
          resolve();
        }
      });
    }
  } finally {
    // Release microphone tracks IMMEDIATELY after capture stops so the browser's
    // recording indicator turns off before local decoding or network upload.
    _pbpSpeechStopTracks(sess.stream);
    sess.stream = null;
  }
  if (sess.cancelled || _pbpSpeechSession !== sess || token !== _pbpSpeechSeq) return;
  if (!target || !_pbpSpeechEnabled || !_pbpSpeechDeepseekKey || !_pbpSpeechOriginGranted || !target.isTargetValid(sess.context)) {
    pbpSpeechCancelTarget(sess.targetId);
    return;
  }
  if (sess.rawBytes <= 0 || sess.chunks.length === 0) {
    _pbpSpeechSession = null;
    _pbpSpeechSyncTargetIdle(target, true);
    _pbpSpeechShowStatus(target, t("mdAsrErrEmpty"), "error");
    return;
  }
  if (sess.rawBytes > PBP_ASR_MAX_BYTES) {
    _pbpSpeechSession = null;
    _pbpSpeechSyncTargetIdle(target, true);
    _pbpSpeechShowStatus(target, t("mdAsrErrTooLarge"), "error");
    return;
  }
  if (target.button) {
    target.button.dataset.voiceState = "transcribing";
    target.button.setAttribute("aria-pressed", "false");
    target.button.setAttribute("aria-busy", "true");
    target.button.innerHTML = typeof PBP_ICONS !== "undefined" ? PBP_ICONS.stop : "";
    const stopLabel = t("mdAsrMicStop");
    target.button.title = stopLabel;
    target.button.setAttribute("aria-label", stopLabel);
  }
  _pbpSpeechShowStatus(target, t("mdAsrTranscribing"), "info");

  try {
    const rawBlob = new Blob(sess.chunks, { type: sess.mimeType || "audio/webm" });
    sess.chunks = [];
    const wavBytes = await pbpAsrDecodeToWavBytes(rawBlob);
    if (_pbpSpeechConfigPromise) await _pbpSpeechConfigPromise;
    if (sess.cancelled || _pbpSpeechSession !== sess || token !== _pbpSpeechSeq) return;
    if (!_pbpSpeechEnabled || !_pbpSpeechDeepseekKey || !_pbpSpeechOriginGranted || !target.isTargetValid(sess.context)) {
      pbpSpeechCancelTarget(sess.targetId);
      return;
    }
    const endpoint = typeof PBP_DEEPSEEK_ASR_ENDPOINT === "string"
      ? PBP_DEEPSEEK_ASR_ENDPOINT
      : "https://api.deepseek.com/v1/tools/asr";
    const ctrl = new AbortController();
    sess.abortCtrl = ctrl;
    const uploadTimer = setTimeout(() => ctrl.abort(), PBP_ASR_TIMEOUT_MS);
    let resp;
    let rawText = "";
    try {
      resp = await fetch(endpoint, {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        signal: ctrl.signal,
        headers: {
          Authorization: "Bearer " + _pbpSpeechDeepseekKey,
        },
        body: pbpAsrBuildFormData(wavBytes, "speech.wav"),
      });
      rawText = await resp.text();
    } finally {
      clearTimeout(uploadTimer);
      sess.abortCtrl = null;
    }
    if (sess.cancelled || _pbpSpeechSession !== sess || token !== _pbpSpeechSeq) return;
    if (!target.isTargetValid(sess.context)) {
      pbpSpeechCancelTarget(sess.targetId);
      return;
    }
    const parsed = pbpAsrParseResponse(resp.status, rawText);
    _pbpSpeechSession = null;
    if (!parsed.ok) {
      _pbpSpeechSyncTargetIdle(target, true);
      const errKey = parsed.code === "auth"
        ? "deepseekFetchAuthFailed"
        : parsed.code === "too_large"
          ? "mdAsrErrTooLarge"
          : "mdAsrErrFailed";
      _pbpSpeechShowStatus(target, t(errKey), "error");
      return;
    }
    if (!parsed.text) {
      _pbpSpeechSyncTargetIdle(target, true);
      _pbpSpeechShowStatus(target, t("mdAsrErrEmpty"), "warn");
      return;
    }
    _pbpSpeechSyncTargetIdle(target, false);
    const ta = target.getTextarea();
    pbpAsrInsertTranscript(ta, parsed.text);
  } catch (e) {
    if (sess.cancelled || _pbpSpeechSession !== sess || token !== _pbpSpeechSeq) return;
    _pbpSpeechSession = null;
    _pbpSpeechSyncTargetIdle(target, true);
    const msg = e?.message === "asr_too_large"
      ? t("mdAsrErrTooLarge")
      : e?.message === "asr_empty_audio"
        ? t("mdAsrErrEmpty")
        : t("mdAsrErrFailed");
    console.warn("[md-speech] transcription failed:", e?.name, e?.message);
    _pbpSpeechShowStatus(target, msg, "error");
  }
}

async function _pbpSpeechToggle(targetId) {
  const target = _pbpSpeechTargets.get(targetId);
  if (!target || (target.button && target.button.disabled)) return;
  if (_pbpSpeechSession && _pbpSpeechSession.targetId === targetId) {
    if (_pbpSpeechSession.pending || _pbpSpeechSession.finishing) {
      pbpSpeechCancelTarget(targetId);
    } else {
      await _pbpSpeechFinishRecording(_pbpSpeechSession);
    }
    return;
  }
  const origin = typeof PBP_DEEPSEEK_FETCH_ORIGIN_PATTERN === "string"
    ? PBP_DEEPSEEK_FETCH_ORIGIN_PATTERN
    : "https://api.deepseek.com/*";
  // Fire permission request synchronously inside the click gesture before any
  // storage await or getUserMedia call consumes transient user activation.
  const permPromise = (_pbpSpeechDeepseekKey && !_pbpSpeechOriginGranted && typeof chrome !== "undefined" && chrome?.permissions?.request)
    ? chrome.permissions.request({ origins: [origin] })
    : null;

  pbpSpeechCancelAll();
  const token = ++_pbpSpeechSeq;
  const context = typeof target.captureContext === "function" ? target.captureContext() : {};
  const sess = {
    targetId,
    token,
    context,
    pending: true,
    awaitingPerm: Boolean(permPromise),
    stopped: false,
    stream: null,
    recorder: null,
    mimeType: "audio/webm",
    chunks: [],
    rawBytes: 0,
    startedAt: 0,
    timer: 0,
    finishing: false,
    cancelled: false,
    onStopResolve: null,
    abortCtrl: null,
  };
  _pbpSpeechSession = sess;
  const clearPendingSession = () => {
    if (_pbpSpeechSession === sess) _pbpSpeechSession = null;
  };

  if (permPromise) {
    let granted = false;
    try { granted = !!(await permPromise); } catch (_) { /* swallow-ok: permission denied */ }
    sess.awaitingPerm = false;
    if (granted) _pbpSpeechOriginGranted = true;
    if (sess.cancelled || _pbpSpeechSession !== sess || token !== _pbpSpeechSeq) return;
  }
  if (!_pbpSpeechConfigLoaded) {
    await pbpSpeechRefreshConfig();
    if (sess.cancelled || _pbpSpeechSession !== sess || token !== _pbpSpeechSeq) return;
  }
  if (!_pbpSpeechEnabled || !target.isTargetValid(context)) {
    clearPendingSession();
    return;
  }
  if (!_pbpSpeechDeepseekKey) {
    clearPendingSession();
    _pbpSpeechShowStatus(target, t("deepseekFetchKeyMissing"), "error");
    return;
  }
  if (!_pbpSpeechOriginGranted) {
    clearPendingSession();
    _pbpSpeechShowStatus(target, t("deepseekVoiceAccessMissingHint"), "error");
    return;
  }
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder !== "function") {
    clearPendingSession();
    _pbpSpeechShowStatus(target, t("mdAsrErrMicUnavailable"), "error");
    return;
  }

  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    if (sess.cancelled || _pbpSpeechSession !== sess || token !== _pbpSpeechSeq) return;
    clearPendingSession();
    const denied = e?.name === "NotAllowedError" || e?.name === "PermissionDeniedError" || e?.name === "SecurityError";
    _pbpSpeechShowStatus(target, t(denied ? "mdAsrErrMicDenied" : "mdAsrErrMicUnavailable"), "error");
    return;
  }

  if (sess.cancelled || _pbpSpeechSession !== sess || token !== _pbpSpeechSeq || !_pbpSpeechEnabled || !_pbpSpeechDeepseekKey || !_pbpSpeechOriginGranted || !target.isTargetValid(context)) {
    clearPendingSession();
    _pbpSpeechStopTracks(stream);
    return;
  }

  const mimeType = _pbpSpeechPickMimeType();
  let recorder;
  try {
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch (e) {
    clearPendingSession();
    _pbpSpeechStopTracks(stream);
    console.warn("[md-speech] MediaRecorder init failed:", e?.name, e?.message);
    _pbpSpeechShowStatus(target, t("mdAsrErrMicUnavailable"), "error");
    return;
  }

  sess.stream = stream;
  sess.recorder = recorder;
  sess.mimeType = recorder.mimeType || mimeType || "audio/webm";

  recorder.ondataavailable = (ev) => {
    if (!ev?.data || ev.data.size <= 0) return;
    sess.chunks.push(ev.data);
    sess.rawBytes += ev.data.size;
    if (!sess.finishing && sess.rawBytes >= PBP_ASR_MAX_BYTES) {
      _pbpSpeechFinishRecording(sess);
    }
  };
  recorder.onerror = (ev) => {
    console.warn("[md-speech] MediaRecorder error:", ev?.error?.name, ev?.error?.message);
    if (_pbpSpeechSession === sess && !sess.finishing) {
      pbpSpeechCancelTarget(targetId);
      _pbpSpeechShowStatus(target, t("mdAsrErrMicUnavailable"), "error");
    }
  };
  recorder.onstop = () => {
    sess.stopped = true;
    if (typeof sess.onStopResolve === "function") {
      const done = sess.onStopResolve;
      sess.onStopResolve = null;
      done();
    } else if (!sess.cancelled && !sess.finishing && _pbpSpeechSession === sess) {
      void _pbpSpeechFinishRecording(sess);
    }
  };

  const tracks = typeof stream.getTracks === "function" ? stream.getTracks() : [];
  const onTrackEnded = () => {
    if (_pbpSpeechSession !== sess || sess.cancelled || sess.finishing || sess.stopped) return;
    const allEnded = tracks.length > 0 && tracks.every((tr) => tr && tr.readyState === "ended");
    if (allEnded || tracks.length <= 1) {
      void _pbpSpeechFinishRecording(sess);
    }
  };
  for (const tr of tracks) {
    if (typeof tr?.addEventListener === "function") {
      tr.addEventListener("ended", onTrackEnded, { once: true });
    }
  }

  try {
    recorder.start(250);
  } catch (e) {
    clearPendingSession();
    _pbpSpeechStopTracks(stream);
    console.warn("[md-speech] recorder.start failed:", e?.name, e?.message);
    _pbpSpeechShowStatus(target, t("mdAsrErrMicUnavailable"), "error");
    return;
  }
  sess.pending = false;
  sess.startedAt = Date.now();

  if (target.button) {
    target.button.dataset.voiceState = "recording";
    target.button.setAttribute("aria-pressed", "true");
    target.button.removeAttribute("aria-busy");
    target.button.innerHTML = typeof PBP_ICONS !== "undefined" ? PBP_ICONS.stop : "";
    const stopLabel = t("mdAsrMicStop");
    target.button.title = stopLabel;
    target.button.setAttribute("aria-label", stopLabel);
  }
  _pbpSpeechShowStatus(target, t("mdAsrRecording", _pbpSpeechFormatClock(0)), "recording");

  const updateTick = () => {
    if (_pbpSpeechSession !== sess || sess.finishing) return;
    if (!target.isTargetValid(sess.context)) {
      pbpSpeechCancelTarget(targetId);
      return;
    }
    const elapsedSec = (Date.now() - sess.startedAt) / 1000;
    if (elapsedSec >= PBP_ASR_MAX_SECONDS) {
      _pbpSpeechFinishRecording(sess);
      return;
    }
    if (elapsedSec >= PBP_ASR_WARN_SECONDS) {
      const rem = Math.max(1, Math.ceil(PBP_ASR_MAX_SECONDS - elapsedSec));
      _pbpSpeechShowStatus(target, t("mdAsrMaxSoon", String(rem)), "warn");
    } else {
      _pbpSpeechShowStatus(target, t("mdAsrRecording", _pbpSpeechFormatClock(elapsedSec)), "recording");
    }
  };
  sess.timer = setInterval(updateTick, 250);
}

function pbpSpeechRegisterTarget(spec) {
  if (!spec || !spec.id || !spec.button) return;
  const target = {
    id: String(spec.id),
    button: spec.button,
    statusEl: spec.statusEl || null,
    getTextarea: typeof spec.getTextarea === "function" ? spec.getTextarea : () => null,
    isTargetValid: typeof spec.isTargetValid === "function" ? spec.isTargetValid : () => true,
    captureContext: typeof spec.captureContext === "function" ? spec.captureContext : () => ({}),
    onLayoutChange: typeof spec.onLayoutChange === "function" ? spec.onLayoutChange : null,
  };
  _pbpSpeechTargets.set(target.id, target);
  if (!target.button._pbpSpeechWired) {
    target.button._pbpSpeechWired = true;
    target.button.addEventListener("click", () => { _pbpSpeechToggle(target.id); });
  }
  _pbpSpeechSyncTargetIdle(target, false);
  if (!_pbpSpeechConfigLoaded) pbpSpeechRefreshConfig();
}

function pbpSpeechReapplyI18n() {
  for (const target of _pbpSpeechTargets.values()) {
    if (!_pbpSpeechSession || _pbpSpeechSession.targetId !== target.id || _pbpSpeechSession.pending) {
      _pbpSpeechSyncTargetIdle(target, true);
    } else if (target.button) {
      const stopLabel = t("mdAsrMicStop");
      target.button.title = stopLabel;
      target.button.setAttribute("aria-label", stopLabel);
    }
  }
}

if (typeof chrome !== "undefined" && chrome?.storage) {
  pbpSpeechRefreshConfig();
  chrome.storage.onChanged?.addListener((changes, area) => {
    if ((area === "local" || area === "sync")
        && (changes.readerVoiceInputEnabled || changes.deepseekApiKey || changes.optSyncEnabled || changes.syncApiKeys)) {
      pbpSpeechRefreshConfig();
    }
  });
  const _pbpSpeechPermRefresh = () => { pbpSpeechRefreshConfig(); };
  chrome.permissions?.onAdded?.addListener(_pbpSpeechPermRefresh);
  chrome.permissions?.onRemoved?.addListener(_pbpSpeechPermRefresh);
}

if (typeof window !== "undefined") {
  window.pbpSpeechRegisterTarget = pbpSpeechRegisterTarget;
  window.pbpSpeechCancelTarget = pbpSpeechCancelTarget;
  window.pbpSpeechCancelAll = pbpSpeechCancelAll;
  window.pbpSpeechRefreshConfig = pbpSpeechRefreshConfig;
  window.pbpSpeechReapplyI18n = pbpSpeechReapplyI18n;
  window.addEventListener("pagehide", () => pbpSpeechCancelAll());
}

if (typeof document !== "undefined") {
  document.addEventListener("pbp:article-will-replace", () => pbpSpeechCancelAll());
  document.addEventListener("pbp:account-changed", () => pbpSpeechCancelAll());
  document.addEventListener("pbp:i18n-applied", () => pbpSpeechReapplyI18n());
}
