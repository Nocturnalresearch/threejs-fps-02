// audio.js — every sound is procedural WebAudio: no files, no network.
// The context is created lazily on the first user gesture; the master gain
// sits at 0.5. Every method is a no-op until the context exists, so the
// module is safe to call from a headless test.

export function createAudio() {
  const audio = {
    ctx: null,
    master: null,

    ensure() {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return true;
      }
      if (typeof window === 'undefined') return false;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      return true;
    },

    _tone(freq, dur, type, gain, slideTo) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t + dur);
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g);
      g.connect(this.master);
      o.start(t);
      o.stop(t + dur + 0.02);
    },

    _noise(dur, filterFreq, gain, type = 'lowpass') {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const f = this.ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = filterFreq;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(f);
      f.connect(g);
      g.connect(this.master);
      src.start(t);
      src.stop(t + dur);
    },

    // Per-weapon shot: bandpassed noise crack + triangle thump.
    shot(id, dist = 0) {
      if (!this.ctx) return;
      const att = dist > 0 ? Math.max(0.15, 1 - dist / 60) : 1;
      const crack = { pistol: 2600, smg: 3000, rifle: 2200, dmr: 1400 }[id] || 2200;
      this._noise(0.09, crack, 0.5 * att, 'bandpass');
      this._tone(id === 'dmr' ? 120 : 170, 0.08, 'triangle', 0.35 * att, 70);
    },

    enemyShot(dist) {
      if (!this.ctx) return;
      const att = Math.max(0.08, 1 - dist / 55);
      this._noise(0.08, 2000, 0.3 * att, 'bandpass');
      this._tone(150, 0.07, 'triangle', 0.18 * att, 70);
    },

    reload() {
      if (!this.ctx) return;
      this._tone(900, 0.05, 'square', 0.12);
      setTimeout(() => this._tone(1200, 0.05, 'square', 0.12), 180);
    },

    dry() {
      this._tone(1400, 0.04, 'square', 0.1);
    },

    hit(head) {
      this._tone(head ? 2400 : 1500, 0.07, 'sine', 0.25);
    },

    kill() {
      this._tone(880, 0.09, 'sine', 0.25);
      setTimeout(() => this._tone(1318, 0.14, 'sine', 0.25), 90);
    },

    hurt() {
      this._tone(220, 0.15, 'sawtooth', 0.2, 110);
    },

    explosion() {
      this._noise(0.7, 400, 0.9);
      this._tone(70, 0.6, 'sine', 0.6, 32);
    },

    bounce() {
      this._tone(320, 0.05, 'triangle', 0.15, 180);
    },

    beep(final) {
      this._tone(final ? 1760 : 880, final ? 0.18 : 0.07, 'sine', 0.2);
    },

    buy() {
      this._tone(1046, 0.08, 'sine', 0.2);
      setTimeout(() => this._tone(1568, 0.1, 'sine', 0.2), 80);
    },

    deny() {
      this._tone(220, 0.12, 'square', 0.15);
    },

    sting(win) {
      if (!this.ctx) return;
      const notes = win ? [523, 659, 784] : [392, 330, 262];
      notes.forEach((f, i) => {
        setTimeout(() => this._tone(f, 0.22, 'triangle', 0.22), i * 130);
      });
    },
  };
  return audio;
}
