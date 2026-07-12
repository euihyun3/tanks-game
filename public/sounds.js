// sounds.js — synthesized retro/arcade sound effects (Web Audio API, no files).
// Exposes window.SFX. Call SFX.init() from a user gesture (click/keydown) first;
// all other methods silently no-op until the AudioContext exists and is running.
(function () {
  'use strict';

  var ctx = null;        // shared AudioContext
  var master = null;     // master gain (~0.3)
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

  // Oscillator with a pitch ramp and exponential-ish gain envelope.
  function tone(opts) {
    var t0 = ctx.currentTime + (opts.delay || 0);
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(opts.freq, t0);
    if (opts.freqEnd) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(opts.freqEnd, 1), t0 + opts.dur);
    }
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(opts.vol || 0.5, t0 + (opts.attack || 0.01));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + opts.dur + 0.05);
  }

  // White-noise burst, optionally through a lowpass filter (with sweep).
  function noise(opts) {
    var t0 = ctx.currentTime + (opts.delay || 0);
    var src = ctx.createBufferSource();
    src.buffer = getNoiseBuffer();
    var gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(opts.vol || 0.5, t0 + (opts.attack || 0.005));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    var last = src;
    if (opts.filterFreq) {
      var filter = ctx.createBiquadFilter();
      filter.type = opts.filterType || 'lowpass';
      filter.frequency.setValueAtTime(opts.filterFreq, t0);
      if (opts.filterEnd) {
        filter.frequency.exponentialRampToValueAtTime(Math.max(opts.filterEnd, 20), t0 + opts.dur);
      }
      src.connect(filter);
      last = filter;
    }
    last.connect(gain);
    gain.connect(master);
    src.start(t0);
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

    // Cannon shot: deep pitch-drop thump + short noise crack.
    fire: function () {
      if (!ready()) return;
      try {
        tone({ type: 'triangle', freq: 120, freqEnd: 40, dur: 0.25, vol: 0.9, attack: 0.005 });
        tone({ type: 'sine', freq: 100, freqEnd: 35, dur: 0.2, vol: 0.7, attack: 0.005 });
        noise({ dur: 0.12, vol: 0.5, filterFreq: 2500, filterEnd: 400 });
      } catch (e) {}
    },

    // Explosion: lowpass-swept noise boom + low sine rumble.
    explosion: function () {
      if (!ready()) return;
      try {
        noise({ dur: 0.6, vol: 1.0, attack: 0.01, filterFreq: 3000, filterEnd: 80 });
        tone({ type: 'sine', freq: 90, freqEnd: 25, dur: 0.6, vol: 0.9, attack: 0.01 });
        // brief crack on top for punch
        noise({ dur: 0.08, vol: 0.4, filterFreq: 6000, filterEnd: 1500 });
      } catch (e) {}
    },

    // Start rising charge-up tone (sustains until chargeStop()).
    charge: function () {
      if (!ready() || chargeNodes) return;
      try {
        var t0 = ctx.currentTime;
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(200, t0);
        osc.frequency.linearRampToValueAtTime(800, t0 + 2.5); // rises over ~2.5s, then holds
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.05); // quiet
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

    // Your-turn notification: pleasant two-note ding.
    turn: function () {
      if (!ready()) return;
      try {
        tone({ type: 'sine', freq: 660, dur: 0.15, vol: 0.4 });          // E5
        tone({ type: 'sine', freq: 880, dur: 0.25, vol: 0.4, delay: 0.12 }); // A5
      } catch (e) {}
    },

    // Victory fanfare: four ascending notes (C major-ish).
    win: function () {
      if (!ready()) return;
      try {
        var notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
        for (var i = 0; i < notes.length; i++) {
          tone({ type: 'square', freq: notes[i], dur: i === 3 ? 0.45 : 0.18, vol: 0.3, delay: i * 0.14 });
          tone({ type: 'triangle', freq: notes[i] / 2, dur: i === 3 ? 0.45 : 0.18, vol: 0.25, delay: i * 0.14 });
        }
      } catch (e) {}
    },

    // Small metallic clank for tank damage.
    hit: function () {
      if (!ready()) return;
      try {
        // slightly detuned high squares = metallic ring
        tone({ type: 'square', freq: 1250, freqEnd: 900, dur: 0.1, vol: 0.25, attack: 0.002 });
        tone({ type: 'square', freq: 1780, freqEnd: 1300, dur: 0.08, vol: 0.18, attack: 0.002 });
        noise({ dur: 0.05, vol: 0.3, filterFreq: 5000, filterType: 'highpass' });
      } catch (e) {}
    }
  };
})();
