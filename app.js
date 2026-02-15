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
   * Detect BPM using multi-band onset detection + comb filter autocorrelation.
   * Analyzes multiple frequency bands independently, then combines scores.
   */
  static async detect(file) {
    const arrayBuffer = await file.arrayBuffer();
    const audioCtx = new OfflineAudioContext(1, 1, 44100);
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

    const sampleRate = audioBuffer.sampleRate;
    const totalSamples = audioBuffer.length;

    // Analyze up to 45s, starting 10% in to skip intros
    const startSample = Math.floor(totalSamples * 0.1);
    const analyzeSamples = Math.min(
      Math.floor(45 * sampleRate),
      totalSamples - startSample
    );
    const raw = audioBuffer.getChannelData(0).slice(startSample, startSample + analyzeSamples);

    // --- 1. Multi-band filtering using single-pole IIR filters ---
    // Split into 3 bands: bass (<200Hz), mid (200-2000Hz), treble (>2000Hz)
    const lowPass = BPMDetector._lowPassFilter(raw, sampleRate, 200);
    const midFull = BPMDetector._lowPassFilter(raw, sampleRate, 2000);
    const mid = new Float32Array(midFull.length);
    for (let i = 0; i < mid.length; i++) mid[i] = midFull[i] - lowPass[i];
    const hi = new Float32Array(raw.length);
    for (let i = 0; i < hi.length; i++) hi[i] = raw[i] - midFull[i];

    // --- 2. Compute onset functions per band ---
    // Use ~10ms hop for ~100 onsets/sec
    const hopSamples = Math.floor(sampleRate * 0.01);
    const winSamples = Math.floor(sampleRate * 0.025);

    const bands = [lowPass, mid, hi];
    const bandWeights = [1.5, 1.0, 0.7]; // bass weighted more heavily
    const bandOnsets = bands.map(band => BPMDetector._onsetEnvelope(band, winSamples, hopSamples));

    // --- 3. Comb filter autocorrelation per band ---
    const onsetRate = sampleRate / hopSamples;
    const minBPM = 60, maxBPM = 200;
    const minLag = Math.floor((60 / maxBPM) * onsetRate);
    const maxLag = Math.ceil((60 / minBPM) * onsetRate);

    // Score each integer BPM candidate
    const scores = new Float64Array(maxBPM - minBPM + 1);

    for (let b = 0; b < bands.length; b++) {
      const onset = bandOnsets[b];
      const n = onset.length;
      const weight = bandWeights[b];

      // Compute raw autocorrelation for this band
      const acf = new Float64Array(maxLag + 1);
      for (let lag = minLag; lag <= maxLag; lag++) {
        let sum = 0;
        for (let i = 0; i + lag < n; i++) {
          sum += onset[i] * onset[i + lag];
        }
        acf[lag] = sum / (n - lag);
      }

      // Comb filter: for each BPM, sum autocorrelation at lag multiples
      for (let bpm = minBPM; bpm <= maxBPM; bpm++) {
        const baseLag = (60 * onsetRate) / bpm;
        let score = 0;
        // Check harmonics 1x through 4x
        for (let h = 1; h <= 4; h++) {
          const hLag = Math.round(baseLag * h);
          if (hLag <= maxLag) {
            // Weight lower harmonics more
            score += acf[hLag] * (1 / h);
          }
        }
        scores[bpm - minBPM] += score * weight;
      }
    }

    // --- 4. Apply perceptual tempo weighting ---
    // People perceive tempos near 120 BPM most naturally.
    // Use a Gaussian centered at 120 BPM to slightly prefer common tempos.
    for (let bpm = minBPM; bpm <= maxBPM; bpm++) {
      const dist = (bpm - 120) / 50;
      scores[bpm - minBPM] *= Math.exp(-0.5 * dist * dist) * 0.3 + 0.7;
    }

    // --- 5. Find best BPM ---
    let bestBPM = 120;
    let bestScore = -Infinity;
    for (let bpm = minBPM; bpm <= maxBPM; bpm++) {
      if (scores[bpm - minBPM] > bestScore) {
        bestScore = scores[bpm - minBPM];
        bestBPM = bpm;
      }
    }

    // --- 6. Resolve octave ambiguity ---
    // Check if half or double tempo scores nearly as well
    const halfBPM = Math.round(bestBPM / 2);
    const dblBPM = Math.round(bestBPM * 2);

    if (halfBPM >= minBPM) {
      const halfScore = scores[halfBPM - minBPM];
      // Prefer half-time if it's at least 80% as strong and in comfortable range
      if (halfScore > bestScore * 0.8 && halfBPM >= 80) {
        bestBPM = halfBPM;
      }
    }
    if (dblBPM <= maxBPM) {
      const dblScore = scores[dblBPM - minBPM];
      // Prefer double-time only if significantly stronger
      if (dblScore > bestScore * 1.3) {
        bestBPM = dblBPM;
      }
    }

    return bestBPM;
  }

  /** Single-pole IIR low-pass filter */
  static _lowPassFilter(data, sampleRate, cutoffHz) {
    const rc = 1 / (2 * Math.PI * cutoffHz);
    const dt = 1 / sampleRate;
    const alpha = dt / (rc + dt);
    const out = new Float32Array(data.length);
    out[0] = data[0];
    for (let i = 1; i < data.length; i++) {
      out[i] = out[i - 1] + alpha * (data[i] - out[i - 1]);
    }
    return out;
  }

  /** Compute onset strength envelope: energy difference, half-wave rectified */
  static _onsetEnvelope(samples, windowSize, hopSize) {
    const numFrames = Math.floor((samples.length - windowSize) / hopSize);
    if (numFrames < 2) return new Float32Array(0);

    // Compute RMS energy per frame
    const energy = new Float32Array(numFrames);
    for (let f = 0; f < numFrames; f++) {
      const start = f * hopSize;
      let sum = 0;
      for (let i = 0; i < windowSize; i++) {
        sum += samples[start + i] ** 2;
      }
      energy[f] = Math.sqrt(sum / windowSize);
    }

    // Onset = positive energy difference (half-wave rectified)
    const onset = new Float32Array(numFrames);
    for (let i = 1; i < numFrames; i++) {
      onset[i] = Math.max(0, energy[i] - energy[i - 1]);
    }

    // Adaptive thresholding: subtract local mean to suppress constant-energy sections
    const meanWindow = 15;
    for (let i = 0; i < numFrames; i++) {
      const lo = Math.max(0, i - meanWindow);
      const hi = Math.min(numFrames, i + meanWindow + 1);
      let mean = 0;
      for (let j = lo; j < hi; j++) mean += onset[j];
      mean /= (hi - lo);
      onset[i] = Math.max(0, onset[i] - mean);
    }

    return onset;
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
