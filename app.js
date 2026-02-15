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

    return best;
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


// ─── App Controller ─────────────────────────────────────────────────────────

class App {
  constructor() {
    this.stepDetector = new StepDetector();
    this.audioEngine = new AudioEngine();
    this.tapBPM = new TapBPM();
    this.syncing = false;

    this._deferredInstallPrompt = null;

    this._cacheElements();
    this._bindEvents();
    this._setupInstall();
    this._startUILoop();
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
    };
  }

  _bindEvents() {
    // File loading
    this.els.btnLoadFile.addEventListener('click', () => this.els.fileInput.click());
    this.els.fileInput.addEventListener('change', (e) => this._loadFile(e));

    // Playback
    this.els.btnPlayPause.addEventListener('click', () => this._togglePlayback());

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
      }
    });

    // Progress bar seeking
    this.els.progressBar.addEventListener('click', (e) => {
      const rect = this.els.progressBar.getBoundingClientRect();
      const fraction = (e.clientX - rect.left) / rect.width;
      this.audioEngine.seek(Math.max(0, Math.min(1, fraction)));
    });

    // Audio ended
    this.audioEngine.audio.addEventListener('ended', () => {
      this._updatePlayPauseIcon(false);
      this.audioEngine.playing = false;
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

  async _loadFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
      await this.audioEngine.loadFile(file);
      this.els.trackName.textContent = this.audioEngine.fileName;
      this.els.trackName.classList.add('loaded');
      this.els.btnPlayPause.disabled = false;
      this.els.duration.textContent = this._formatTime(this.audioEngine.duration);

      // Auto-detect BPM in background
      this.els.trackBPM.textContent = '...';
      BPMDetector.detect(file).then((bpm) => {
        this.audioEngine.originalBPM = bpm;
        this.els.bpmInput.value = bpm;
        this.els.trackBPM.textContent = bpm;
      }).catch(() => {
        this.els.trackBPM.textContent = '--';
      });
    } catch (err) {
      this.els.trackName.textContent = 'Error loading file';
    }

    // Reset file input so the same file can be re-selected
    event.target.value = '';
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
    // Force reflow to restart animation
    void flash.offsetWidth;
    flash.classList.add('pulse');
  }

  _onSPMChange(spm) {
    this.els.spmNumber.textContent = spm || '--';
    this._updateRing(spm);

    if (this.syncing && spm > 0) {
      this.audioEngine.setTargetBPM(spm);
    } else {
      this.audioEngine.resetRate();
    }
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

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
