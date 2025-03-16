const AudioContext = window.AudioContext || window.webkitAudioContext;
let audioContext = null;
let getSyncTime = null;
let getAudioTime = null;
let scheduler = null;
let startTime = null;

export function startAudio(context, syncTimeFunction, convertTimeFunction) {
  audioContext = context
  getSyncTime = syncTimeFunction;
  getAudioTime = convertTimeFunction;

  if (scheduler === null) {
    scheduler = new SimpleScheduler();
  }

  startTime = audioContext.currentTime;
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
    this.synth = new FmSynth();

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
    const audioTime = getAudioTime(time);
    this.synth.trigger(audioTime, soundParams, !loop.local);

    // trigger circle
    this.renderer.trigger(soundParams.index, soundParams.x, soundParams.y, {
      color: soundParams.index,
      opacity: Math.sqrt(soundParams.gain),
      duration: 0.8 * soundParams.duration,
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
let refFreq = 440;
let refPitch = 6900;

function setTuning(freq = 440, pitch = 6900) {
  refFreq = freq;
  refPitch = pitch;
}

function pitchToFreq(pitch) {
  return refFreq * Math.exp(0.0005776226504666211 * (pitch - refPitch)); // pow(2, val / 1200)
}

class FmSynth {
  constructor() {
    this.modIndex = 1; // moduation index
    this.freqRatio = 1.001; // modulator frequency / carrier frequency
    // this.freqRatio = 1.414213562373095; // modulator frequency / carrier frequency
    // this.freqRatio = 1.6180339886256; // modulator frequency / carrier frequency
    // this.freqRatio = 1.001; // modulator frequency / carrier frequency

    this.attack = 0.001;
    this.attackRatio = 1; // modulator attack time / carrier attack time (< 1)

    this.durationRatio = 0.333; // modulator duration / carrier duration (< 1)

    this.detune = 0;
    this.voiceGain = 1 / 12;

    this.output = audioContext.createGain();
    this.output.connect(audioContext.destination);
    this.output.gain.value = this.voiceGain;
  }

  trigger(time, params, echo = false) {
    const pitch = params.pitch;
    const duration = params.duration;
    const detune = 10;
    const attack = Math.min(this.attack, duration);
    const carFreq = pitchToFreq(pitch);
    const carDetune = detune * Math.random();

    time = Math.max(time, audioContext.currentTime + 0.005);

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

    const modIndex = this.modIndex * Math.pow(4, params.x - 1) * Math.pow(2, (2 * params.y - 1));

    if (modIndex !== 0) {
      const modFreq = carFreq * this.freqRatio;
      const modDetune = detune * Math.random();
      const modDuration = duration * this.durationRatio;
      const modAttack = Math.min(attack * this.attackRatio, modDuration);
  
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

    // console.log(time, audioContext.currentTime, time - audioContext.currentTime);
  }

  setGain(value) {
    this.output.gain.value = this.voiceGain * value;
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

      for (let i = 0; i < this.circles.length; i++)
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