// sounds.js — synthesized 8-bit/chiptune (NES-style) sound effects (Web Audio API, no files).
// Square + triangle oscillators and a noise buffer only; stepped/quantized pitch
// sweeps instead of smooth glides for that retro feel.
// Exposes window.SFX. Call SFX.init() from a user gesture (click/keydown) first;
// all other methods silently no-op until the AudioContext exists and is running.
(function () {
  'use strict';

  var ctx = null;         // shared AudioContext
  var master = null;      // master gain (~0.3)
  var noiseBuffer = null; // cached 1s white-noise buffer
  var chargeNodes = null; // { osc, gain } while charge tone is active

  function ready() {
    return !!(ctx && ctx.state === 'running' && master);
  }

  function getNoiseBuffer() {
    if (!noiseBuffer) {
      var len = ctx.sampleRate; // 1 second
      noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
      var data = noiseBuffer.getChannelData(0);
      for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    return noiseBuffer;
  }

  // ---- helpers -------------------------------------------------------------

  // Single note: square/triangle oscillator with a fast decay envelope.
  function tone(opts) {
    var t0 = ctx.currentTime + (opts.delay || 0);
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = opts.type || 'square';
    osc.frequency.setValueAtTime(opts.freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(opts.vol || 0.5, t0 + (opts.attack || 0.005));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + opts.dur + 0.05);
    return osc;
  }

  // Oscillator whose pitch STEPS (quantized) from freqStart to freqEnd over dur,
  // in `steps` discrete jumps — the classic NES pitch-sweep sound.
  function steppedTone(opts) {
    var t0 = ctx.currentTime + (opts.delay || 0);
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = opts.type || 'square';
    var steps = opts.steps || 8;
    var i;
    for (i = 0; i < steps; i++) {
      // geometric interpolation so the sweep sounds even in pitch
      var f = opts.freqStart * Math.pow(opts.freqEnd / opts.freqStart, i / (steps - 1));
      osc.frequency.setValueAtTime(Math.max(f, 1), t0 + (opts.dur * i) / steps);
    }
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(opts.vol || 0.5, t0 + (opts.attack || 0.005));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + opts.dur + 0.05);
  }

  // White-noise burst, optionally through a filter. If `stepsEnd` is given the
  // lowpass frequency STEPS down (NES noise-channel style) instead of gliding.
  function noise(opts) {
    var t0 = ctx.currentTime + (opts.delay || 0);
    var src = ctx.createBufferSource();
    src.buffer = getNoiseBuffer();
    // random start offset so rapid repeated bursts don't sound identical
    var offset = Math.random() * 0.5;
    var gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(opts.vol || 0.5, t0 + (opts.attack || 0.003));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    var last = src;
    if (opts.filterFreq) {
      var filter = ctx.createBiquadFilter();
      filter.type = opts.filterType || 'lowpass';
      if (opts.filterSteps && opts.filterEnd) {
        var n = opts.filterSteps;
        for (var i = 0; i < n; i++) {
          var f = opts.filterFreq * Math.pow(opts.filterEnd / opts.filterFreq, i / (n - 1));
          filter.frequency.setValueAtTime(Math.max(f, 20), t0 + (opts.dur * i) / n);
        }
      } else {
        filter.frequency.setValueAtTime(opts.filterFreq, t0);
        if (opts.filterEnd) {
          filter.frequency.exponentialRampToValueAtTime(Math.max(opts.filterEnd, 20), t0 + opts.dur);
        }
      }
      src.connect(filter);
      last = filter;
    }
    last.connect(gain);
    gain.connect(master);
    src.start(t0, offset);
    src.stop(t0 + opts.dur + 0.05);
  }

  // ---- public API ----------------------------------------------------------

  window.SFX = {
    // Create/resume the AudioContext. Idempotent; call from a user gesture.
    init: function () {
      try {
        if (!ctx) {
          var AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return;
          ctx = new AC();
          master = ctx.createGain();
          master.gain.value = 0.3;
          master.connect(ctx.destination);
        }
        if (ctx.state === 'suspended') {
          ctx.resume().catch(function () {});
        }
      } catch (e) { /* audio unavailable; stay silent */ }
    },

    // Cannon shot: punchy square blast stepping down ~200→50Hz + noise tick.
    fire: function () {
      if (!ready()) return;
      try {
        steppedTone({ type: 'square', freqStart: 200, freqEnd: 50, steps: 10, dur: 0.2, vol: 0.8, attack: 0.003 });
        steppedTone({ type: 'triangle', freqStart: 160, freqEnd: 40, steps: 8, dur: 0.18, vol: 0.6, attack: 0.003 });
        noise({ dur: 0.05, vol: 0.4, filterFreq: 3000, filterEnd: 800 });
      } catch (e) {}
    },

    // Explosion: NES-noise-channel boom — stepped lowpass sweep + triangle rumble.
    explosion: function () {
      if (!ready()) return;
      try {
        noise({ dur: 0.5, vol: 1.0, attack: 0.008, filterFreq: 2800, filterEnd: 90, filterSteps: 8 });
        steppedTone({ type: 'triangle', freqStart: 100, freqEnd: 28, steps: 6, dur: 0.5, vol: 0.9, attack: 0.008 });
        // short bright crack on top for punch
        noise({ dur: 0.07, vol: 0.4, filterFreq: 6000, filterEnd: 2000 });
      } catch (e) {}
    },

    // Start rising stepped charge-up square (sustains until chargeStop()).
    charge: function () {
      if (!ready() || chargeNodes) return;
      try {
        var t0 = ctx.currentTime;
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'square';
        // stepped semitone-ish rise 150→900Hz over ~2.5s, then holds at top
        var steps = 24;
        var riseDur = 2.5;
        for (var i = 0; i <= steps; i++) {
          var f = 150 * Math.pow(900 / 150, i / steps);
          osc.frequency.setValueAtTime(f, t0 + (riseDur * i) / steps);
        }
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.08, t0 + 0.05); // quiet
        osc.connect(gain);
        gain.connect(master);
        osc.start(t0);
        chargeNodes = { osc: osc, gain: gain };
      } catch (e) { chargeNodes = null; }
    },

    // Stop the charge tone cleanly (short gain ramp, no click).
    chargeStop: function () {
      if (!chargeNodes) return;
      try {
        var t0 = ctx.currentTime;
        var g = chargeNodes.gain.gain;
        g.cancelScheduledValues(t0);
        g.setValueAtTime(Math.max(g.value, 0.0001), t0);
        g.exponentialRampToValueAtTime(0.0001, t0 + 0.06);
        chargeNodes.osc.stop(t0 + 0.1);
      } catch (e) {}
      chargeNodes = null;
    },

    // Your-turn notification: cheerful two-note square chirp.
    turn: function () {
      if (!ready()) return;
      try {
        tone({ type: 'square', freq: 659.25, dur: 0.09, vol: 0.3 });               // E5
        tone({ type: 'square', freq: 987.77, dur: 0.16, vol: 0.3, delay: 0.09 }); // B5
      } catch (e) {}
    },

    // Victory fanfare: 6-note chiptune run — square lead + triangle bass an octave down.
    win: function () {
      if (!ready()) return;
      try {
        var notes = [523.25, 523.25, 659.25, 783.99, 659.25, 1046.5]; // C5 C5 E5 G5 E5 C6
        var durs = [0.1, 0.1, 0.12, 0.12, 0.1, 0.5];
        var t = 0;
        for (var i = 0; i < notes.length; i++) {
          tone({ type: 'square', freq: notes[i], dur: durs[i], vol: 0.3, delay: t });
          tone({ type: 'triangle', freq: notes[i] / 2, dur: durs[i], vol: 0.3, delay: t });
          t += durs[i] + 0.02;
        }
      } catch (e) {}
    },

    // Short metallic square blip for tank damage.
    hit: function () {
      if (!ready()) return;
      try {
        steppedTone({ type: 'square', freqStart: 1320, freqEnd: 880, steps: 3, dur: 0.08, vol: 0.28, attack: 0.002 });
        steppedTone({ type: 'square', freqStart: 1870, freqEnd: 1245, steps: 3, dur: 0.06, vol: 0.18, attack: 0.002 });
        noise({ dur: 0.04, vol: 0.25, filterFreq: 5000, filterType: 'highpass' });
      } catch (e) {}
    },

    // Machine-gun tat: tiny square blip + noise tick, random pitch per shot.
    // Kept very cheap (2 nodes worth of sound, <=80ms) — called ~7x/sec.
    mg: function () {
      if (!ready()) return;
      try {
        var f = 440 + Math.random() * 120; // slight variation so bursts aren't robotic
        steppedTone({ type: 'square', freqStart: f, freqEnd: f * 0.45, steps: 3, dur: 0.06, vol: 0.3, attack: 0.002 });
        noise({ dur: 0.03, vol: 0.25, filterFreq: 4000, filterEnd: 1200 });
      } catch (e) {}
    },

    // Coin/1-up pickup: classic ascending two-note square arpeggio (B5 -> E6).
    pickup: function () {
      if (!ready()) return;
      try {
        tone({ type: 'square', freq: 987.77, dur: 0.08, vol: 0.3, attack: 0.002 });               // B5
        tone({ type: 'square', freq: 1318.5, dur: 0.28, vol: 0.3, attack: 0.002, delay: 0.08 }); // E6
      } catch (e) {}
    },

    // Flamethrower whoosh: filtered noise sweeping up then down + low triangle.
    flame: function () {
      if (!ready()) return;
      try {
        noise({ dur: 0.2, vol: 0.55, attack: 0.03, filterFreq: 400, filterEnd: 2200, filterSteps: 5 });
        noise({ dur: 0.2, vol: 0.55, attack: 0.01, delay: 0.2, filterFreq: 2200, filterEnd: 300, filterSteps: 5 });
        steppedTone({ type: 'triangle', freqStart: 70, freqEnd: 45, steps: 4, dur: 0.4, vol: 0.35, attack: 0.02 });
      } catch (e) {}
    },

    // Scatter shot: quick cluster of 3-4 tiny pops with slight random delays.
    scatter: function () {
      if (!ready()) return;
      try {
        var pops = 3 + Math.floor(Math.random() * 2); // 3 or 4
        var t = 0;
        for (var i = 0; i < pops; i++) {
          var f = 500 + Math.random() * 300;
          steppedTone({ type: 'square', freqStart: f, freqEnd: f * 0.4, steps: 3, dur: 0.05, vol: 0.25, attack: 0.002, delay: t });
          noise({ dur: 0.03, vol: 0.2, filterFreq: 3500, filterEnd: 1000, delay: t });
          t += 0.04 + Math.random() * 0.03; // total stays <= ~0.25s
        }
      } catch (e) {}
    }
  };
})();
