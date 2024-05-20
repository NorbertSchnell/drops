let audioContext = null;
let getSyncTime = null;
let scheduler = null;

export function startAudio(ac, timeFunction, buffers) {
  audioContext = ac
  getSyncTime = timeFunction;

  if (scheduler === null) {
    scheduler = new SimpleScheduler();
  }

  if (audioBuffers === null) {
    audioBuffers = buffers;
  }
}

/*************************************************
 * sequence loop
 */
class TimeEngine {
  constructor() {
    this.master = null;
  }

  get currentTime() {
    if (this.master)
      return this.master.currentTime;

    return undefined;
  }

  resetTime(time = undefined) {
    if (this.master)
      this.master.resetEngineTime(this, time);
  }

  resetPosition(position = undefined) {
    if (this.master)
      this.master.resetEnginePosition(this, position);
  }
}

class SimpleScheduler {
  constructor(options = {}) {
    this.__engines = new Set();

    this.__schedEngines = [];
    this.__schedTimes = [];

    this.__currentTime = null;
    this.__timeout = null;

    this.period = options.period || 0.025;
    this.lookahead = options.lookahead || 0.1;
  }

  __scheduleEngine(engine, time) {
    this.__schedEngines.push(engine);
    this.__schedTimes.push(time);
  }

  __rescheduleEngine(engine, time) {
    const index = this.__schedEngines.indexOf(engine);

    if (index >= 0) {
      if (time !== Infinity) {
        this.__schedTimes[index] = time;
      } else {
        this.__schedEngines.splice(index, 1);
        this.__schedTimes.splice(index, 1);
      }
    } else if (time < Infinity) {
      this.__schedEngines.push(engine);
      this.__schedTimes.push(time);
    }
  }

  __unscheduleEngine(engine) {
    const index = this.__schedEngines.indexOf(engine);

    if (index >= 0) {
      this.__schedEngines.splice(index, 1);
      this.__schedTimes.splice(index, 1);
    }
  }

  __resetTick() {
    if (this.__schedEngines.length > 0) {
      if (!this.__timeout) {
        this.__tick();
      }
    } else if (this.__timeout) {
      clearTimeout(this.__timeout);
      this.__timeout = null;
    }
  }

  __tick() {
    const currentTime = getSyncTime();
    let i = 0;

    while (i < this.__schedEngines.length) {
      const engine = this.__schedEngines[i];
      let time = this.__schedTimes[i];

      while (time && time <= currentTime + this.lookahead) {
        time = Math.max(time, currentTime);
        this.__currentTime = time;
        time = engine.advanceTime(time);
      }

      if (time && time < Infinity) {
        this.__schedTimes[i++] = time;
      } else {
        this.__unscheduleEngine(engine);

        // remove engine from scheduler
        if (!time) {
          engine.master = null;
          this.__engines.delete(engine);
        }
      }
    }

    this.__currentTime = null;
    this.__timeout = null;

    if (this.__schedEngines.length > 0) {
      this.__timeout = setTimeout(() => {
        this.__tick();
      }, this.period * 1000);
    }
  }

  get currentTime() {
    return this.__currentTime || getSyncTime() + this.lookahead;
  }

  add(engine, time = this.currentTime) {
    if (engine.master)
      throw new Error("object has already been added to a master");

    // set master and add to array
    engine.master = this;
    this.__engines.add(engine);

    // schedule engine
    this.__scheduleEngine(engine, time);
    this.__resetTick();
  }

  remove(engine) {
    if (!engine.master || engine.master !== this)
      throw new Error("engine has not been added to this scheduler");

    // reset master and remove from array
    engine.master = null;
    this.__engines.delete(engine);

    // unschedule engine
    this.__unscheduleEngine(engine);
    this.__resetTick();
  }

  resetEngineTime(engine, time = this.currentTime) {
    this.__rescheduleEngine(engine, time);
    this.__resetTick();
  }

  has(engine) {
    return this.__engines.has(engine);
  }

  clear() {
    if (this.__timeout) {
      clearTimeout(this.__timeout);
      this.__timeout = null;
    }

    this.__schedEngines.length = 0;
    this.__schedTimes.length = 0;
  }
}

// loop corresponding to a single drop
class Loop extends TimeEngine {
  constructor(looper, soundParams, local = false) {
    super();

    this.looper = looper;
    this.soundParams = soundParams; // drop parameters
    this.local = local; // drop is triggered localy and not an echo
  }

  advanceTime(time) {
    return this.looper.advanceLoop(time, this); // just call daddy
  }
}

export class Looper {
  constructor(renderer, loopParams, updateCount = null) {
    this.renderer = new CircleRenderer();
    // this.synth = new SampleSynth(audioBuffers);
    this.synth = new FmSynth();
    // this.synth = new ModalSynth();

    this.loopParams = loopParams;
    this.updateCount = updateCount; // function to call to update drop counter display

    this.loops = new Set(); // set of current drop loops
    this.numLocalLoops = 0; // number of used drops
  }

  // start new loop
  start(time, soundParams, local = false) {
    const loop = new Loop(this, soundParams, local); // create new loop

    this.loops.add(loop); // add loop to set
    scheduler.add(loop, time); // add loop to scheduler

    if (local) {
      this.numLocalLoops++; // increment used drops
      this.updateCount(); // update drop counter display
    }
  }

  // called each loop (in scheduler)
  advanceLoop(time, loop) {
    const soundParams = loop.soundParams;
    const loopParams = this.loopParams;

    // eliminate loop when vanished
    if (soundParams.gain < loopParams.offGain) {
      this.loops.delete(loop); // delete loop from set

      if (loop.local) {
        this.numLocalLoops--; // decrement used drops
        this.updateCount(); // update drop counter display
      }

      return null; // remove looper from scheduler
    }

    // trigger sound
    const audioTime = audioContext.currentTime;
    const duration = this.synth.trigger(audioTime, soundParams, !loop.local);

    // trigger circle
    this.renderer.trigger(soundParams.index, soundParams.x, soundParams.y, {
      color: soundParams.index,
      opacity: Math.sqrt(soundParams.gain),
      duration: duration,
      velocity: 40 + soundParams.gain * 80,
    });

    // apply attenuation
    soundParams.gain *= loopParams.attenuation;

    // return next time
    return time + loopParams.period;
  }

  // remove loop by index
  remove(index) {
    for (let loop of this.loops) {
      if (loop.soundParams.index === index) {
        scheduler.remove(loop); // remove loop from scheduler

        if (loop.local) {
          this.numLocalLoops--; // decrement used drops
          this.renderer.remove(index); // remove circle from renderer
        }

        this.loops.delete(loop); // delete loop from set
      }
    }

    this.updateCount(); // update drop counter display
  }

  // remove all loops (for clear in controller)
  removeAll() {
    // remove all loops from scheduler
    for (let loop of this.loops)
      scheduler.remove(loop);

    this.loops.clear(); // clear set
    this.numLocalLoops = 0; // reset used drops

    this.updateCount(); // update drop counter display
  }

  resize(canvasWidth, canvasHeight) {
    this.renderer.resize(canvasWidth, canvasHeight);
  }

  setGain(value) {
    this.synth.setGain(value);
  }
}

/*************************************************
 * synth
 */
let audioBuffers = null;
const pitches = [4800, 5000, 6400, 6600, 6800, 7000, 7200, 7400, 7600, 7800, 8000, 8200, 8400];

var refFreq = 440;
var refPitch = 6900;

function setTuning(freq = 440, pitch = 6900) {
  refFreq = freq;
  refPitch = pitch;
}

function pitchToFreq(pitch) {
  return refFreq * Math.exp(0.0005776226504666211 * (pitch - refPitch)); // pow(2, val / 1200)
}

////////////////////////////////////////////////////////////////////////////////////////////////////
class SampleSynth {
  constructor(audioBuffers) {
    this.audioBuffers = audioBuffers;
    this.output = audioContext.createGain();
    this.output.connect(audioContext.destination);
    this.output.gain.value = 1;
  }

  trigger(time, params, echo = false) {
    const audioBuffers = this.audioBuffers;
    let duration = 0;

    if (audioBuffers && audioBuffers.length > 0) {
      const x = params.x || 0.5;
      const y = params.y || 0.5;

      const index = Math.floor((1 - y) * 12);
      const b1 = audioBuffers[2 * index];

      duration += (1 - x) * b1.duration;

      const g1 = audioContext.createGain();
      g1.connect(this.output);
      g1.gain.value = (1 - x) * params.gain;

      const s1 = audioContext.createBufferSource();
      s1.buffer = b1;
      s1.connect(g1);
      s1.start(time);

      const b2 = audioBuffers[2 * index + 1];
      duration += x * b2.duration;

      const g2 = audioContext.createGain();
      g2.connect(this.output);
      g2.gain.value = x * params.gain;

      const s2 = audioContext.createBufferSource();
      s2.buffer = b2;
      s2.connect(g2);
      s2.start(time);
    }

    return duration;
  }

  setGain(value) {
    this.output.gain.value = value;
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////
class FmSynth {
  constructor() {
    this.modIndex = 1; // moduation index
    // this.freqRatio = 1.6180339886256; // modulator frequency / carrier frequency
    this.freqRatio = 1.414213562373095; // modulator frequency / carrier frequency
    // this.freqRatio = 1.001; // modulator frequency / carrier frequency

    this.attack = 0.001;
    this.attackRatio = 1; // modulator attack time / carrier attack time (< 1)

    this.duration = 2;
    this.durationRatio = 0.333; // modulator duration / carrier duration (< 1)

    this.detune = 0;
    this.voiceGain = 0.5;

    this.output = audioContext.createGain();
    this.output.connect(audioContext.destination);
    this.output.gain.value = this.voiceGain;
  }

  trigger(time, params, echo = false) {
    const now = audioContext.currentTime;
    const x = Math.max(0, Math.min(1, params.x));
    const y = Math.max(0, Math.min(1, (1 - params.y)));
    const pitchIndex = Math.floor(y * pitches.length);
    const pitch = pitches[pitchIndex];
    const detune = 20;
    const duration = Math.pow(2, 2 * x - 1) * this.duration;
    const attack = Math.min(this.attack, duration);

    const carFreq = pitchToFreq(pitch);
    const carDetune = detune * Math.random();

    const modFreq = carFreq * this.freqRatio;
    const modDetune = detune * Math.random();
    const modDuration = duration * this.durationRatio;
    const modAttack = Math.min(attack * this.attackRatio, modDuration);
    const modIndex = this.modIndex;

    const carEnv = audioContext.createGain();
    carEnv.connect(this.output);
    carEnv.gain.value = 0;
    carEnv.gain.setValueAtTime(0, time);
    carEnv.gain.linearRampToValueAtTime(params.gain, time + attack);
    carEnv.gain.exponentialRampToValueAtTime(0.001, time + duration - 0.01);
    carEnv.gain.linearRampToValueAtTime(0, time + duration);

    const carOsc = audioContext.createOscillator();
    carOsc.connect(carEnv);
    carOsc.type = 'sine';
    carOsc.frequency.value = carFreq;
    carOsc.detune.value = carDetune;
    carOsc.start(time);
    carOsc.stop(time + duration);

    if (modIndex !== 0) {
      const modEnv = audioContext.createGain();
      modEnv.connect(carOsc.frequency);
      modEnv.gain.value = 0;
      modEnv.gain.setValueAtTime(0, time);
      modEnv.gain.linearRampToValueAtTime(carFreq * modIndex, time + modAttack);
      modEnv.gain.exponentialRampToValueAtTime(0.001, time + modDuration - 0.01);
      modEnv.gain.linearRampToValueAtTime(0, time + modDuration);

      const modOsc = audioContext.createOscillator();
      modOsc.connect(modEnv);
      modOsc.type = 'sine';
      modOsc.frequency.value = modFreq;
      modOsc.detune.value = modDetune;
      modOsc.start(time);
      modOsc.stop(time + modDuration);
    }

    return duration;
  }

  setGain(value) {
    this.output.gain.value = this.voiceGain * value;
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////
class ModalSynth {
  constructor() {
    this.partials = [{
      amplitude: 1,
      attack: 0.004,
      duration: 4,
      detune: 0,
    }, {
      amplitude: 1 / 2,
      attack: 0.002,
      duration: 2,
      detune: 10,
    }, {
      amplitude: 1 / 4,
      attack: 0.001,
      duration: 1,
      detune: 20,
    }, {
      amplitude: 1 / 8,
      attack: 0.001,
      duration: 1,
      detune: 20,
    }, {
      amplitude: 1 / 16,
      attack: 0.001,
      duration: 1,
      detune: 20,
    }, {
      amplitude: 1 / 32,
      attack: 0.001,
      duration: 1,
      detune: 20,
    }];

    this.output = audioContext.createGain();
    this.output.connect(audioContext.destination);
    this.output.gain.value = 1;
  }

  trigger(time, params, echo = false) {
    const x = params.x || 0.5;
    const y = params.y || 0.5;
    const index = Math.floor(Math.max(0, Math.min(1, (1 - y))) * pitches.length);
    const pitch = pitches[index];
    const fundamental = pitchToFreq(pitch);
    const durationFactor = Math.max(0, Math.min(1, x));
    const nyquistFreq = 0.5 * audioContext.sampleRate;
    const partials = this.partials;
    let maxDuration = 0;

    for (var i = 0; i < partials.length; i++) {
      let partial = partials[i];

      if (partial) {
        let freq = fundamental * (i + 1);
        let amp = partial.amplitude || 1;
        let attack = partial.attack || 0.001;
        let duration = (0.5 + 1.5 * durationFactor) * partial.duration || 1;
        let detune = partial.detune || 0;

        if (attack > duration)
          attack = duration;

        if (maxDuration < duration)
          maxDuration = duration;

        if (freq < nyquistFreq) {
          var env = audioContext.createGain();
          env.connect(this.output);
          env.gain.value = 0;
          env.gain.setValueAtTime(0, time);
          env.gain.linearRampToValueAtTime(amp, time + attack);
          env.gain.exponentialRampToValueAtTime(0.0001, time + duration);

          var osc = audioContext.createOscillator();
          osc.connect(env);
          osc.type = 'sine';
          osc.frequency.value = freq;
          osc.detune.value = detune * Math.random();
          osc.start(time);
          osc.stop(time + duration);
        }
      }
    }

    return maxDuration;
  }

  setGain(value) {
    this.output.gain.value = value;
  }
}

/*************************************************
 * graphics
 */
const colorMap = [
  '#44C7F1', '#37C000', '#F5D900', '#F39300',
  '#EC5D57', '#B36AE2', '#00FDFF', '#FF80BE',
  '#CAFA79', '#FFFF64', '#FF9EFF', '#007AFF'
];

class Circle {
  constructor(id, x, y, options) {
    this.id = id;
    this.x = x;
    this.y = y;

    this.opacity = options.opacity || 1;
    this.color = colorMap[(options.color || 0) % colorMap.length];

    this.growthVelocity = options.velocity || 50; // pixels / sec
    this.minVelocity = 50; // if gain is < 0.25 => constant growth
    this.friction = -50; // pixels / sec

    this.setDuration(options.duration);

    this.radius = 0;
    this.coordinates = {};
    this.isDead = false;
  }

  setDuration(time) {
    this.lifeTime = time;
    this.opacityScale = this.opacity / this.lifeTime;
  }

  update(dt, w, h) {
    // update coordinates - screen orientation
    this.coordinates.x = this.x * w;
    this.coordinates.y = this.y * h;

    this.lifeTime -= dt;
    this.opacity = this.opacityScale * this.lifeTime;

    if (this.growthVelocity > this.minVelocity)
      this.growthVelocity += (this.friction * dt);

    this.radius += this.growthVelocity * dt;

    if (this.lifeTime < 0)
      this.isDead = true;
  }

  render(ctx) {
    if (!this.isDead) {
      ctx.save();
      ctx.beginPath();
      ctx.fillStyle = this.color;
      ctx.globalAlpha = this.opacity;
      ctx.arc(this.coordinates.x, this.coordinates.y, Math.round(this.radius), 0, Math.PI * 2, false);
      ctx.fill();
      ctx.closePath();
      ctx.restore();
    }
  }
}

export class CircleRenderer {
  constructor() {
    this.circles = [];
    this.lastTime = null;

    this.canvasWidth = 0;
    this.canvasHeight = 0;
    this.canvas = document.getElementById('canvas');
    this.context = this.canvas.getContext('2d');

    this.render = this.render.bind(this);
  }

  resize(canvasWidth, canvasHeight) {
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;

    this.canvas.width = canvasWidth;
    this.canvas.height = canvasHeight;
  }

  render(time) {
    const ctx = this.context;

    time *= 0.001;

    if (this.lastTime !== null) {
      const dt = time - this.lastTime;
      const width = this.canvasWidth;
      const height = this.canvasHeight;

      // update and remove dead circles
      for (let i = this.circles.length - 1; i >= 0; i--) {
        const circle = this.circles[i];
        circle.update(dt, width, height);

        if (circle.isDead)
          this.circles.splice(i, 1);
      }

      // render circles
      ctx.save();
      ctx.clearRect(0, 0, width, height);

      for (var i = 0; i < this.circles.length; i++)
        this.circles[i].render(ctx);

      ctx.restore();
    }

    this.lastTime = time;

    if (this.circles.length > 0) {
      requestAnimationFrame(this.render);
    }
  }

  trigger(id, x, y, options) {
    if (this.circles.length === 0) {
      this.lastTime = null;
      requestAnimationFrame(this.render);
    }

    const circle = new Circle(id, x, y, options);
    this.circles.push(circle);
  }

  remove(id) {
    this.circles.forEach((circle) => {
      if (circle.id === id)
        circle.isDead = true;
    });
  }
}