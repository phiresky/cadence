// ─── Step Detector ──────────────────────────────────────────────────────────

class StepDetector {
  constructor() {
    this.stepTimestamps = [];
    this.spm = 0;
    this.stepCount = 0;

    // Signal processing
    this.smoothed = 9.81;
    this.baseline = 9.81;
    this.smoothAlpha = 0.2;
    this.baselineAlpha = 0.005;

    // Peak detection
    this.threshold = 0.8;
    this.minStepInterval = 280;
    this.lastStepTime = 0;
    this.aboveThreshold = false;

    // Callbacks
    this.onStep = null;
    this.onSPMChange = null;

    this._handleMotion = this._handleMotion.bind(this);
    this.active = false;
    this._decayTimer = null;
  }

  async start() {
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      const permission = await DeviceMotionEvent.requestPermission();
      if (permission !== 'granted') throw new Error('Motion permission denied');
    }

    window.addEventListener('devicemotion', this._handleMotion);
    this.active = true;
    this._decayTimer = setInterval(() => this._checkDecay(), 1000);
  }

  stop() {
    window.removeEventListener('devicemotion', this._handleMotion);
    this.active = false;
    if (this._decayTimer) clearInterval(this._decayTimer);
    this._decayTimer = null;
  }

  setThreshold(value) {
    this.threshold = value;
  }

  // For desktop simulation
  simulateStep() {
    this._registerStep(Date.now());
  }

  _handleMotion(event) {
    const acc = event.accelerationIncludingGravity;
    if (!acc || acc.x === null) return;

    const magnitude = Math.sqrt(acc.x ** 2 + acc.y ** 2 + acc.z ** 2);

    // Slow baseline tracking (adapts to phone orientation / gravity)
    this.baseline += this.baselineAlpha * (magnitude - this.baseline);

    // Smooth the signal
    this.smoothed += this.smoothAlpha * (magnitude - this.smoothed);

    const deviation = this.smoothed - this.baseline;
    const now = Date.now();

    if (deviation > this.threshold) {
      this.aboveThreshold = true;
    } else if (this.aboveThreshold) {
      this.aboveThreshold = false;
      if (now - this.lastStepTime >= this.minStepInterval) {
        this._registerStep(now);
      }
    }
  }

  _registerStep(time) {
    this.lastStepTime = time;
    this.stepCount++;
    this.stepTimestamps.push(time);

    // Keep last 30 steps
    while (this.stepTimestamps.length > 30) {
      this.stepTimestamps.shift();
    }

    this._calculateSPM();
    if (this.onStep) this.onStep(this.stepCount);
  }

  _calculateSPM() {
    if (this.stepTimestamps.length < 4) return;

    // Median interval for robustness against outliers
    const stamps = this.stepTimestamps.slice(-12);
    const intervals = [];
    for (let i = 1; i < stamps.length; i++) {
      intervals.push(stamps[i] - stamps[i - 1]);
    }

    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)];
    const newSPM = Math.round(60000 / median);

    if (newSPM >= 40 && newSPM <= 220) {
      this.spm = newSPM;
      if (this.onSPMChange) this.onSPMChange(this.spm);
    }
  }

  _checkDecay() {
    if (this.stepTimestamps.length === 0) return;
    const elapsed = Date.now() - this.stepTimestamps[this.stepTimestamps.length - 1];
    if (elapsed > 3000) {
      this.spm = 0;
      this.stepTimestamps = [];
      if (this.onSPMChange) this.onSPMChange(0);
    }
  }
}


// ─── Audio Engine ───────────────────────────────────────────────────────────

class AudioEngine {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.originalBPM = 0;
    this.targetRate = 1.0;
    this.currentRate = 1.0;
    this.minRate = 0.7;
    this.maxRate = 1.4;
    this.smoothing = 0.08;
    this.loaded = false;
    this.playing = false;
    this.fileName = '';

    this._rafId = null;
    this._smoothLoop = this._smoothLoop.bind(this);

    // Media Session API for lock screen controls
    this._setupMediaSession();
  }

  async loadFile(file) {
    const url = URL.createObjectURL(file);
    this.audio.src = url;
    this.fileName = file.name.replace(/\.[^.]+$/, '');
    this.loaded = true;

    return new Promise((resolve, reject) => {
      this.audio.oncanplaythrough = () => resolve();
      this.audio.onerror = () => reject(new Error('Failed to load audio'));
    });
  }

  play() {
    if (!this.loaded) return;
    this.audio.play();
    this.playing = true;
    this._startSmoothing();
    this._updateMediaSession();
  }

  pause() {
    this.audio.pause();
    this.playing = false;
    this._stopSmoothing();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(fraction) {
    if (!this.loaded) return;
    this.audio.currentTime = fraction * this.audio.duration;
  }

  setTargetBPM(targetBPM) {
    if (!this.originalBPM || !targetBPM) {
      this.targetRate = 1.0;
      return;
    }
    const rate = targetBPM / this.originalBPM;
    this.targetRate = Math.max(this.minRate, Math.min(this.maxRate, rate));
  }

  resetRate() {
    this.targetRate = 1.0;
  }

  _startSmoothing() {
    if (this._rafId) return;
    this._smoothLoop();
  }

  _stopSmoothing() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  _smoothLoop() {
    // Exponential smoothing toward target rate
    this.currentRate += this.smoothing * (this.targetRate - this.currentRate);

    // Clamp to prevent extreme values
    this.currentRate = Math.max(this.minRate, Math.min(this.maxRate, this.currentRate));

    // Only update if meaningfully different (avoids micro-stutters)
    if (Math.abs(this.audio.playbackRate - this.currentRate) > 0.002) {
      this.audio.playbackRate = this.currentRate;
    }

    if (this.playing) {
      this._rafId = requestAnimationFrame(this._smoothLoop);
    }
  }

  _setupMediaSession() {
    if (!('mediaSession' in navigator)) return;

    navigator.mediaSession.setActionHandler('play', () => this.play());
    navigator.mediaSession.setActionHandler('pause', () => this.pause());
  }

  _updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: this.fileName || 'Cadence',
      artist: 'Cadence',
    });
  }

  get currentTime() { return this.audio.currentTime || 0; }
  get duration() { return this.audio.duration || 0; }
  get progress() { return this.duration ? this.currentTime / this.duration : 0; }
}


// ─── BPM Detector ───────────────────────────────────────────────────────────

class BPMDetector {
  /**
   * Detect BPM using proper biquad filtering + comb filter autocorrelation.
   * Uses OfflineAudioContext for accurate band separation, then scores
   * each BPM candidate by summing autocorrelation at beat-period harmonics.
   */
  static async detect(file) {
    const arrayBuffer = await file.arrayBuffer();
    const decCtx = new OfflineAudioContext(1, 1, 44100);
    const audioBuf = await decCtx.decodeAudioData(arrayBuffer);

    const sr = audioBuf.sampleRate;
    const skip = Math.min(15, audioBuf.duration * 0.15);
    const dur = Math.min(30, audioBuf.duration - skip);
    if (dur < 5) throw new Error('Track too short for BPM detection');
    const outLen = Math.ceil(dur * sr);

    // Render bass and full-range filtered versions in parallel
    const [bass, full] = await Promise.all([
      // 4th-order Butterworth LPF at 200Hz (two cascaded biquads)
      BPMDetector._renderFiltered(audioBuf, sr, outLen, skip, dur, [
        { type: 'lowpass', freq: 200, Q: 0.707 },
        { type: 'lowpass', freq: 200, Q: 0.707 },
      ]),
      // High-pass at 60Hz to remove DC/sub-bass rumble
      BPMDetector._renderFiltered(audioBuf, sr, outLen, skip, dur, [
        { type: 'highpass', freq: 60, Q: 0.707 },
      ]),
    ]);

    // Onset detection: 10ms hop (~100 frames/sec), 25ms analysis window
    const hop = Math.round(sr * 0.01);
    const win = Math.round(sr * 0.025);
    const bassOnset = BPMDetector._onsetEnvelope(bass, win, hop);
    const fullOnset = BPMDetector._onsetEnvelope(full, win, hop);

    // Pre-compute normalized autocorrelation for both bands
    const onsetRate = sr / hop;
    const minBPM = 60, maxBPM = 200;
    const maxLag = Math.ceil((60 / minBPM) * onsetRate * 4) + 1;
    const bassACF = BPMDetector._autocorrelation(bassOnset, maxLag);
    const fullACF = BPMDetector._autocorrelation(fullOnset, maxLag);

    // Comb filter scoring: for each BPM, sum ACF at harmonics 1-4
    // Equal weighting — avoids the 1/h bias that favors half-time
    const scores = new Float64Array(maxBPM - minBPM + 1);
    for (let bpm = minBPM; bpm <= maxBPM; bpm++) {
      const baseLag = (60 * onsetRate) / bpm;
      let bScore = 0, fScore = 0;
      for (let h = 1; h <= 4; h++) {
        const lag = Math.round(baseLag * h);
        if (lag < bassACF.length) bScore += bassACF[lag];
        if (lag < fullACF.length) fScore += fullACF[lag];
      }
      scores[bpm - minBPM] = bScore * 2.0 + fScore;
    }

    // Mild perceptual bias toward common tempos (centered at 120)
    for (let bpm = minBPM; bpm <= maxBPM; bpm++) {
      const d = (bpm - 120) / 55;
      scores[bpm - minBPM] *= 0.8 + 0.2 * Math.exp(-0.5 * d * d);
    }

    // Find best candidate
    let best = 120, bestScore = -Infinity;
    for (let bpm = minBPM; bpm <= maxBPM; bpm++) {
      if (scores[bpm - minBPM] > bestScore) {
        bestScore = scores[bpm - minBPM];
        best = bpm;
      }
    }

    // Resolve octave ambiguity
    const half = Math.round(best / 2);
    const dbl = Math.round(best * 2);
    if (half >= minBPM && half <= maxBPM &&
        scores[half - minBPM] > bestScore * 0.85 && half >= 80) {
      best = half;
    }
    if (dbl >= minBPM && dbl <= maxBPM &&
        scores[dbl - minBPM] > bestScore * 1.2) {
      best = dbl;
    }

    // Find beat phase offset for beat-step synchronization
    const phaseInWindow = BPMDetector._findBeatPhase(bassOnset, fullOnset, best, onsetRate);
    const beatPeriod = 60 / best;
    const beatOffset = (skip + phaseInWindow) % beatPeriod;

    return { bpm: best, beatOffset };
  }

  /** Render audio through a chain of biquad filters via OfflineAudioContext */
  static async _renderFiltered(audioBuf, sr, outLen, skip, dur, filters) {
    const ctx = new OfflineAudioContext(1, outLen, sr);
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    let node = src;
    for (const f of filters) {
      const bq = ctx.createBiquadFilter();
      bq.type = f.type;
      bq.frequency.value = f.freq;
      bq.Q.value = f.Q;
      node.connect(bq);
      node = bq;
    }
    node.connect(ctx.destination);
    src.start(0, skip, dur);
    return (await ctx.startRendering()).getChannelData(0);
  }

  /** Normalized autocorrelation (divided by zero-lag energy) */
  static _autocorrelation(signal, maxLag) {
    const n = signal.length;
    const len = Math.min(maxLag + 1, n);
    const acf = new Float64Array(len);
    for (let lag = 0; lag < len; lag++) {
      let sum = 0;
      const count = n - lag;
      for (let i = 0; i < count; i++) {
        sum += signal[i] * signal[i + lag];
      }
      acf[lag] = sum / count;
    }
    if (acf[0] > 0) {
      for (let i = len - 1; i >= 0; i--) acf[i] /= acf[0];
    }
    return acf;
  }

  /** Onset strength: RMS energy difference, adaptively thresholded */
  static _onsetEnvelope(data, win, hop) {
    const n = Math.floor((data.length - win) / hop);
    if (n < 2) return new Float32Array(0);

    const energy = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      let sum = 0;
      const s = f * hop;
      for (let i = 0; i < win; i++) sum += data[s + i] ** 2;
      energy[f] = Math.sqrt(sum / win);
    }

    // Half-wave rectified first difference
    const onset = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      onset[i] = Math.max(0, energy[i] - energy[i - 1]);
    }

    // Adaptive threshold: subtract local mean to suppress sustained sections
    const hw = 10;
    const result = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - hw);
      const hi = Math.min(n, i + hw + 1);
      let mean = 0;
      for (let j = lo; j < hi; j++) mean += onset[j];
      mean /= (hi - lo);
      result[i] = Math.max(0, onset[i] - mean);
    }
    return result;
  }

  /** Find the beat phase offset within the onset envelope */
  static _findBeatPhase(bassOnset, fullOnset, bpm, onsetRate) {
    const beatPeriodSamples = onsetRate * 60 / bpm;
    const numOffsets = Math.ceil(beatPeriodSamples);
    let bestOffset = 0, bestScore = -Infinity;

    const len = Math.min(bassOnset.length, fullOnset.length);
    for (let offset = 0; offset < numOffsets; offset++) {
      let bScore = 0, fScore = 0;
      for (let pos = offset; pos < len; pos += beatPeriodSamples) {
        const idx = Math.round(pos);
        if (idx < bassOnset.length) bScore += bassOnset[idx];
        if (idx < fullOnset.length) fScore += fullOnset[idx];
      }
      const score = bScore * 2.0 + fScore;
      if (score > bestScore) {
        bestScore = score;
        bestOffset = offset;
      }
    }

    return bestOffset / onsetRate;
  }
}


// ─── Tap BPM ────────────────────────────────────────────────────────────────

class TapBPM {
  constructor() {
    this.taps = [];
    this.timeout = null;
  }

  tap() {
    const now = Date.now();

    // Reset if more than 2s since last tap
    if (this.taps.length > 0 && now - this.taps[this.taps.length - 1] > 2000) {
      this.taps = [];
    }

    this.taps.push(now);

    // Keep last 12 taps
    if (this.taps.length > 12) this.taps.shift();

    if (this.taps.length < 2) return null;

    const intervals = [];
    for (let i = 1; i < this.taps.length; i++) {
      intervals.push(this.taps[i] - this.taps[i - 1]);
    }
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    return Math.round(60000 / avg);
  }
}


// ─── Sync Visualizer ─────────────────────────────────────────────────────────

class SyncVisualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.beatEvents = [];
    this.stepEvents = [];
    this.timeWindow = 6000;
    this.maxEvents = 60;

    this.bpm = 0;
    this.beatOffset = 0;
    this._lastBeatIndex = -1;

    this.width = 0;
    this.height = 0;
    this._resize();
    this._resizeHandler = () => this._resize();
    window.addEventListener('resize', this._resizeHandler);
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = rect.width;
    this.height = rect.height;
  }

  setBeatGrid(bpm, beatOffset) {
    this.bpm = bpm;
    this.beatOffset = beatOffset;
    this._lastBeatIndex = -1;
    this.beatEvents = [];
  }

  clear() {
    this.bpm = 0;
    this.beatOffset = 0;
    this._lastBeatIndex = -1;
    this.beatEvents = [];
    this.stepEvents = [];
  }

  recordStep() {
    this.stepEvents.push(performance.now());
    while (this.stepEvents.length > this.maxEvents) this.stepEvents.shift();
  }

  update(audioTime, playbackRate) {
    if (!this.width) this._resize();

    const now = performance.now();

    // Track beat events from audio position
    if (this.bpm > 0 && audioTime > 0) {
      const beatPeriod = 60 / this.bpm;
      const beatIndex = Math.floor((audioTime - this.beatOffset) / beatPeriod);

      if (beatIndex > this._lastBeatIndex) {
        if (this._lastBeatIndex >= 0 && beatIndex - this._lastBeatIndex <= 2) {
          const fractional = (audioTime - this.beatOffset) / beatPeriod;
          const overshootAudio = (fractional - beatIndex) * beatPeriod;
          const overshootMs = (overshootAudio / (playbackRate || 1)) * 1000;
          this.beatEvents.push(now - overshootMs);
          while (this.beatEvents.length > this.maxEvents) this.beatEvents.shift();
        }
        this._lastBeatIndex = beatIndex;
      }
    }

    // Prune old events
    const cutoff = now - this.timeWindow;
    while (this.beatEvents.length > 0 && this.beatEvents[0] < cutoff) this.beatEvents.shift();
    while (this.stepEvents.length > 0 && this.stepEvents[0] < cutoff) this.stepEvents.shift();

    this._draw(now);
  }

  _draw(now) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    if (w === 0 || h === 0) return;

    const mid = h / 2;

    ctx.clearRect(0, 0, w, h);

    // Center divider
    ctx.strokeStyle = 'rgba(37, 37, 69, 0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();

    // Labels
    ctx.font = '9px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(0, 212, 255, 0.4)';
    ctx.fillText('BEATS', 4, 11);
    ctx.fillStyle = 'rgba(255, 107, 53, 0.4)';
    ctx.fillText('STEPS', 4, h - 3);

    // Beat ticks (top half)
    this._drawTicks(ctx, this.beatEvents, now, 2, mid - 2, 0, 212, 255);

    // Step ticks (bottom half)
    this._drawTicks(ctx, this.stepEvents, now, mid + 2, h - 2, 255, 107, 53);
  }

  _drawTicks(ctx, events, now, top, bottom, r, g, b) {
    const w = this.width;
    for (const t of events) {
      const age = now - t;
      if (age < 0 || age > this.timeWindow) continue;

      const x = w * (1 - age / this.timeWindow);
      const alpha = 0.3 + 0.7 * (1 - age / this.timeWindow);

      // Glow
      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha * 0.15})`;
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();

      // Main tick
      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
    }
  }
}


// ─── App Controller ─────────────────────────────────────────────────────────

class App {
  constructor() {
    this.stepDetector = new StepDetector();
    this.audioEngine = new AudioEngine();
    this.tapBPM = new TapBPM();
    this.syncing = false;

    // Playlist state
    this.playlist = []; // [{ file, name, bpm, beatOffset, detecting }]
    this.currentTrackIndex = -1;

    // Beat-step phase sync
    this._phaseCorrection = 0;
    this._currentBeatOffset = undefined;

    this._deferredInstallPrompt = null;

    this._cacheElements();
    this.syncVisualizer = new SyncVisualizer(this.els.syncVizCanvas);
    this._bindEvents();
    this._setupDragDrop();
    this._setupInstall();
    this._startUILoop();

    // Start sync by default
    this._toggleSync();
  }

  _cacheElements() {
    this.els = {
      spmDisplay: document.getElementById('spmDisplay'),
      spmNumber: document.getElementById('spmNumber'),
      spmRing: document.getElementById('spmRing'),
      stepFlash: document.getElementById('stepFlash'),
      trackBPM: document.getElementById('trackBPM'),
      playbackRate: document.getElementById('playbackRate'),
      adjustedBPM: document.getElementById('adjustedBPM'),
      trackName: document.getElementById('trackName'),
      progressBar: document.getElementById('progressBar'),
      progressFill: document.getElementById('progressFill'),
      currentTime: document.getElementById('currentTime'),
      duration: document.getElementById('duration'),
      btnLoadFile: document.getElementById('btnLoadFile'),
      btnPlayPause: document.getElementById('btnPlayPause'),
      btnSync: document.getElementById('btnSync'),
      btnTapBPM: document.getElementById('btnTapBPM'),
      bpmInput: document.getElementById('bpmInput'),
      fileInput: document.getElementById('fileInput'),
      sensitivity: document.getElementById('sensitivity'),
      sensitivityValue: document.getElementById('sensitivityValue'),
      minRate: document.getElementById('minRate'),
      minRateValue: document.getElementById('minRateValue'),
      maxRate: document.getElementById('maxRate'),
      maxRateValue: document.getElementById('maxRateValue'),
      smoothing: document.getElementById('smoothing'),
      smoothingValue: document.getElementById('smoothingValue'),
      simMode: document.getElementById('simMode'),
      btnInstall: document.getElementById('btnInstall'),
      btnPrev: document.getElementById('btnPrev'),
      btnNext: document.getElementById('btnNext'),
      playlist: document.getElementById('playlist'),
      playlistTitle: document.getElementById('playlistTitle'),
      playlistTracks: document.getElementById('playlistTracks'),
      btnClearPlaylist: document.getElementById('btnClearPlaylist'),
      fileInputSingle: document.getElementById('fileInputSingle'),
      dropOverlay: document.getElementById('dropOverlay'),
      syncVizCanvas: document.getElementById('syncVizCanvas'),
    };
  }

  _bindEvents() {
    // File loading — long press or right-click for folder, normal click for files
    this.els.btnLoadFile.addEventListener('click', (e) => {
      if (e.shiftKey) {
        this.els.fileInput.click(); // folder picker
      } else {
        this.els.fileInputSingle.click(); // file picker
      }
    });
    this.els.btnLoadFile.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.els.fileInput.click(); // folder picker
    });
    this.els.fileInput.addEventListener('change', (e) => this._handleFiles(e.target.files));
    this.els.fileInputSingle.addEventListener('change', (e) => this._handleFiles(e.target.files));

    // Playback
    this.els.btnPlayPause.addEventListener('click', () => this._togglePlayback());

    // Prev / Next
    this.els.btnPrev.addEventListener('click', () => this._prevTrack());
    this.els.btnNext.addEventListener('click', () => this._nextTrack());

    // Clear playlist
    this.els.btnClearPlaylist.addEventListener('click', () => this._clearPlaylist());

    // Sync toggle
    this.els.btnSync.addEventListener('click', () => this._toggleSync());

    // Tap BPM
    this.els.btnTapBPM.addEventListener('click', () => this._handleTap());

    // Manual BPM input
    this.els.bpmInput.addEventListener('change', () => {
      const val = parseInt(this.els.bpmInput.value, 10);
      if (val >= 40 && val <= 220) {
        this.audioEngine.originalBPM = val;
        this.els.trackBPM.textContent = val;
        // Also update the playlist entry
        if (this.currentTrackIndex >= 0) {
          this.playlist[this.currentTrackIndex].bpm = val;
          this._renderPlaylist();
        }
      }
    });

    // Progress bar seeking
    this.els.progressBar.addEventListener('click', (e) => {
      const rect = this.els.progressBar.getBoundingClientRect();
      const fraction = (e.clientX - rect.left) / rect.width;
      this.audioEngine.seek(Math.max(0, Math.min(1, fraction)));
    });

    // Audio ended — auto-advance
    this.audioEngine.audio.addEventListener('ended', () => {
      if (this.currentTrackIndex < this.playlist.length - 1) {
        this._playTrack(this.currentTrackIndex + 1);
      } else {
        this._updatePlayPauseIcon(false);
        this.audioEngine.playing = false;
      }
    });

    // Settings
    this.els.sensitivity.addEventListener('input', (e) => {
      this.stepDetector.setThreshold(parseFloat(e.target.value));
      this.els.sensitivityValue.textContent = e.target.value;
    });

    this.els.minRate.addEventListener('input', (e) => {
      this.audioEngine.minRate = parseFloat(e.target.value);
      this.els.minRateValue.textContent = parseFloat(e.target.value).toFixed(2) + 'x';
    });

    this.els.maxRate.addEventListener('input', (e) => {
      this.audioEngine.maxRate = parseFloat(e.target.value);
      this.els.maxRateValue.textContent = parseFloat(e.target.value).toFixed(2) + 'x';
    });

    this.els.smoothing.addEventListener('input', (e) => {
      this.audioEngine.smoothing = parseFloat(e.target.value);
      this.els.smoothingValue.textContent = e.target.value;
    });

    // Step detector callbacks
    this.stepDetector.onStep = () => this._onStep();
    this.stepDetector.onSPMChange = (spm) => this._onSPMChange(spm);

    // Desktop simulation: spacebar = step
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && this.els.simMode.checked && this.syncing) {
        e.preventDefault();
        this.stepDetector.simulateStep();
      }
    });
  }

  // ── Drag & Drop ──

  _setupDragDrop() {
    let dragCounter = 0;

    document.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      this.els.dropOverlay.classList.add('visible');
    });

    document.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        this.els.dropOverlay.classList.remove('visible');
      }
    });

    document.addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    document.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragCounter = 0;
      this.els.dropOverlay.classList.remove('visible');

      const files = await this._getDroppedFiles(e.dataTransfer);
      if (files.length) this._handleFiles(files);
    });
  }

  /** Recursively extract audio files from dropped items (supports folders) */
  async _getDroppedFiles(dataTransfer) {
    const audioExts = /\.(mp3|m4a|aac|ogg|opus|flac|wav|weba|webm)$/i;
    const files = [];

    // Use webkitGetAsEntry for folder support
    const entries = [];
    for (const item of dataTransfer.items) {
      const entry = item.webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }

    if (entries.length > 0) {
      const readEntry = (entry) => new Promise((resolve) => {
        if (entry.isFile) {
          entry.file((f) => {
            if (audioExts.test(f.name)) files.push(f);
            resolve();
          }, () => resolve());
        } else if (entry.isDirectory) {
          const reader = entry.createReader();
          const readBatch = () => {
            reader.readEntries(async (batch) => {
              if (batch.length === 0) { resolve(); return; }
              for (const e of batch) await readEntry(e);
              readBatch(); // keep reading until empty (batched API)
            }, () => resolve());
          };
          readBatch();
        } else {
          resolve();
        }
      });

      for (const entry of entries) await readEntry(entry);
    } else {
      // Fallback: plain file list
      for (const f of dataTransfer.files) {
        if (audioExts.test(f.name)) files.push(f);
      }
    }

    return files;
  }

  // ── Playlist ──

  _handleFiles(fileList) {
    const audioExts = /\.(mp3|m4a|aac|ogg|opus|flac|wav|weba|webm)$/i;
    const newFiles = [];
    for (const f of fileList) {
      if (audioExts.test(f.name)) newFiles.push(f);
    }
    if (newFiles.length === 0) return;

    // Sort by name
    newFiles.sort((a, b) => a.name.localeCompare(b.name));

    const startIndex = this.playlist.length;
    for (const file of newFiles) {
      const name = file.name.replace(/\.[^.]+$/, '');
      this.playlist.push({ file, name, bpm: null, beatOffset: undefined, detecting: false });
    }

    this._updatePlaylistUI();

    // Auto-play first track if nothing is loaded
    if (this.currentTrackIndex < 0) {
      this._playTrack(startIndex);
    }

    // Reset file inputs
    this.els.fileInput.value = '';
    this.els.fileInputSingle.value = '';
  }

  async _detectBPM(index) {
    const track = this.playlist[index];
    if (!track || track.detecting) return;
    track.detecting = true;
    this._renderPlaylist();

    try {
      const result = await BPMDetector.detect(track.file);
      track.bpm = result.bpm;
      track.beatOffset = result.beatOffset;
    } catch {
      track.bpm = null;
      track.beatOffset = undefined;
    }
    track.detecting = false;
    this._renderPlaylist();

    // Update display if this is the current track
    if (index === this.currentTrackIndex && track.bpm) {
      this.audioEngine.originalBPM = track.bpm;
      this.els.bpmInput.value = track.bpm;
      this.els.trackBPM.textContent = track.bpm;
      this._currentBeatOffset = track.beatOffset;
      this.syncVisualizer.setBeatGrid(track.bpm, track.beatOffset);
    }
  }

  async _playTrack(index) {
    if (index < 0 || index >= this.playlist.length) return;
    const track = this.playlist[index];
    this.currentTrackIndex = index;

    try {
      await this.audioEngine.loadFile(track.file);
      this.els.trackName.textContent = track.name;
      this.els.trackName.classList.add('loaded');
      this.els.btnPlayPause.disabled = false;
      this.els.duration.textContent = this._formatTime(this.audioEngine.duration);

      if (track.bpm) {
        this.audioEngine.originalBPM = track.bpm;
        this.els.bpmInput.value = track.bpm;
        this.els.trackBPM.textContent = track.bpm;
        this._currentBeatOffset = track.beatOffset;
        this.syncVisualizer.setBeatGrid(track.bpm, track.beatOffset);
      } else {
        this.audioEngine.originalBPM = 0;
        this.els.bpmInput.value = '';
        this.els.trackBPM.textContent = '--';
        this._currentBeatOffset = undefined;
        this.syncVisualizer.clear();
        // Detect BPM on demand for current track
        if (!track.detecting) this._detectBPM(index);
      }

      this.audioEngine.play();
      this._updatePlayPauseIcon(true);
      this._updateNavButtons();
      this._renderPlaylist();
    } catch {
      this.els.trackName.textContent = 'Error loading track';
    }
  }

  _prevTrack() {
    if (this.currentTrackIndex > 0) {
      this._playTrack(this.currentTrackIndex - 1);
    }
  }

  _nextTrack() {
    if (this.currentTrackIndex < this.playlist.length - 1) {
      this._playTrack(this.currentTrackIndex + 1);
    }
  }

  _clearPlaylist() {
    this.audioEngine.pause();
    this._updatePlayPauseIcon(false);
    this.playlist = [];
    this.currentTrackIndex = -1;
    this._currentBeatOffset = undefined;
    this._phaseCorrection = 0;
    this.syncVisualizer.clear();
    this.els.trackName.textContent = 'No track loaded';
    this.els.trackName.classList.remove('loaded');
    this.els.btnPlayPause.disabled = true;
    this.els.duration.textContent = '0:00';
    this.els.progressFill.style.width = '0%';
    this._updatePlaylistUI();
    this._updateNavButtons();
  }

  _updatePlaylistUI() {
    const hasPlaylist = this.playlist.length > 0;
    this.els.playlist.hidden = !hasPlaylist;
    this.els.playlistTitle.textContent = this.playlist.length + ' track' + (this.playlist.length === 1 ? '' : 's');
    this._renderPlaylist();
    this._updateNavButtons();
  }

  _renderPlaylist() {
    const container = this.els.playlistTracks;
    container.innerHTML = '';
    this.playlist.forEach((track, i) => {
      const row = document.createElement('div');
      row.className = 'playlist-track' + (i === this.currentTrackIndex ? ' active' : '');
      row.innerHTML =
        '<span class="playlist-track-num">' + (i + 1) + '</span>' +
        '<span class="playlist-track-name">' + this._escapeHTML(track.name) + '</span>' +
        '<span class="playlist-track-bpm">' + (track.detecting ? '...' : (track.bpm || '--')) + '</span>';
      row.addEventListener('click', () => this._playTrack(i));
      container.appendChild(row);
    });

    // Scroll active track into view
    const active = container.querySelector('.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  _updateNavButtons() {
    this.els.btnPrev.disabled = this.currentTrackIndex <= 0;
    this.els.btnNext.disabled = this.currentTrackIndex >= this.playlist.length - 1;
  }

  _escapeHTML(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  _togglePlayback() {
    this.audioEngine.toggle();
    this._updatePlayPauseIcon(this.audioEngine.playing);
  }

  _updatePlayPauseIcon(playing) {
    const playIcon = this.els.btnPlayPause.querySelector('.icon-play');
    const pauseIcon = this.els.btnPlayPause.querySelector('.icon-pause');
    playIcon.style.display = playing ? 'none' : 'block';
    pauseIcon.style.display = playing ? 'block' : 'none';
  }

  async _toggleSync() {
    if (this.syncing) {
      this.syncing = false;
      this.stepDetector.stop();
      this.audioEngine.resetRate();
      this._phaseCorrection = 0;
      this.els.btnSync.classList.remove('active');
      this.els.spmDisplay.classList.remove('syncing');
      this.els.spmNumber.textContent = '--';
      this._updateRing(0);
      return;
    }

    try {
      if (!this.els.simMode.checked) {
        await this.stepDetector.start();
      }
      this.syncing = true;
      this.els.btnSync.classList.add('active');
      this.els.spmDisplay.classList.add('syncing');

      // Also start decay timer in sim mode
      if (this.els.simMode.checked) {
        this.stepDetector.active = true;
        this.stepDetector._decayTimer = setInterval(() => this.stepDetector._checkDecay(), 1000);
      }
    } catch (err) {
      alert('Could not access motion sensors: ' + err.message);
    }
  }

  _handleTap() {
    const bpm = this.tapBPM.tap();
    if (bpm) {
      this.audioEngine.originalBPM = bpm;
      this.els.bpmInput.value = bpm;
      this.els.trackBPM.textContent = bpm;
    }
  }

  _onStep() {
    // Flash animation
    const flash = this.els.stepFlash;
    flash.classList.remove('pulse');
    void flash.offsetWidth;
    flash.classList.add('pulse');

    // Record for visualizer
    this.syncVisualizer.recordStep();

    // Phase correction for beat-step sync
    if (this.syncing && this.audioEngine.originalBPM && this._currentBeatOffset !== undefined) {
      const audioTime = this.audioEngine.currentTime;
      const beatPeriod = 60 / this.audioEngine.originalBPM;
      const phase = ((audioTime - this._currentBeatOffset) % beatPeriod + beatPeriod) % beatPeriod;
      let error = phase / beatPeriod;
      if (error > 0.5) error -= 1;

      this._phaseCorrection = -error * 0.4;
      this._updateTargetRate();
    }
  }

  _onSPMChange(spm) {
    this.els.spmNumber.textContent = spm || '--';
    this._updateRing(spm);

    if (this.syncing && spm > 0) {
      this._updateTargetRate();
    } else {
      this.audioEngine.resetRate();
      this._phaseCorrection = 0;
    }
  }

  _updateTargetRate() {
    const spm = this.stepDetector.spm;
    if (!spm || !this.audioEngine.originalBPM) {
      this.audioEngine.resetRate();
      return;
    }

    let rate = spm / this.audioEngine.originalBPM;

    // Apply phase correction if beat grid is available
    if (this._currentBeatOffset !== undefined) {
      rate *= (1 + this._phaseCorrection);
    }

    this.audioEngine.targetRate = Math.max(this.audioEngine.minRate,
                                            Math.min(this.audioEngine.maxRate, rate));
  }

  _updateRing(spm) {
    // Map SPM to ring progress (0 SPM = empty, 200 SPM = full)
    const circumference = 553; // 2 * PI * 88
    const fraction = Math.min(spm / 200, 1);
    this.els.spmRing.style.strokeDashoffset = circumference * (1 - fraction);

    // Change color when syncing actively
    if (spm > 0 && this.syncing) {
      this.els.spmRing.classList.add('active');
    } else {
      this.els.spmRing.classList.remove('active');
    }
  }

  _setupInstall() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this._deferredInstallPrompt = e;
      this.els.btnInstall.hidden = false;
    });

    this.els.btnInstall.addEventListener('click', async () => {
      if (!this._deferredInstallPrompt) return;
      this._deferredInstallPrompt.prompt();
      const { outcome } = await this._deferredInstallPrompt.userChoice;
      if (outcome === 'accepted') {
        this.els.btnInstall.hidden = true;
      }
      this._deferredInstallPrompt = null;
    });

    window.addEventListener('appinstalled', () => {
      this.els.btnInstall.hidden = true;
      this._deferredInstallPrompt = null;
    });
  }

  _startUILoop() {
    const update = () => {
      if (this.audioEngine.playing) {
        this.els.progressFill.style.width = (this.audioEngine.progress * 100) + '%';
        this.els.currentTime.textContent = this._formatTime(this.audioEngine.currentTime);
      }

      // Update BPM displays
      const origBPM = this.audioEngine.originalBPM;
      this.els.trackBPM.textContent = origBPM || '--';
      this.els.playbackRate.textContent = this.audioEngine.currentRate.toFixed(2) + 'x';
      this.els.adjustedBPM.textContent = origBPM
        ? Math.round(origBPM * this.audioEngine.currentRate)
        : '--';

      // Update sync visualizer
      this.syncVisualizer.update(this.audioEngine.currentTime, this.audioEngine.currentRate);

      requestAnimationFrame(update);
    };
    requestAnimationFrame(update);
  }

  _formatTime(seconds) {
    if (!seconds || !isFinite(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
}


// ─── Init ───────────────────────────────────────────────────────────────────

const app = new App();

// Register service worker + auto-reload on update
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    // Check for updates every 60 seconds
    setInterval(() => reg.update(), 60000);

    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', () => {
        // New SW activated and there's already a controller (i.e. this isn't first install)
        if (newWorker.state === 'activated' && navigator.serviceWorker.controller) {
          window.location.reload();
        }
      });
    });
  }).catch(() => {});
}
