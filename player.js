import { SyncClient } from './ircam-sync/client.js';
import { startAudio, Looper, CircleRenderer } from "./player-utils.js";
import config from './config.js'

const audioContext = new AudioContext();
let playerIndex = null;
let playerHasStarted = false;
let playerIsActive = true;

/*********************************************
 * websocket communication
 */
const webSocketUrl = config['websocket-url'];
const socket = new WebSocket(webSocketUrl);
const syncClient = new SyncClient(() => audioContext.currentTime);

socket.addEventListener('open', (event) => {
  sendMessage(['get-params']);
});

// listen to messages from server
socket.addEventListener('message', (event) => {
  const data = event.data;

  if (data.length > 0) {
    const message = JSON.parse(data);

    if (message[0] !== 1) {
      const selector = message[0];

      // dispatch incomming messages
      switch (selector) {
        case 'player-index': {
          playerIndex = message[1];
          displayMessage('Tap screen to start!', true)
          window.addEventListener('touchend', startPlaying);
          break;
        }

        case 'echo': {
          if (looper !== null) {
            const time = message[1];
            const soundParams = message[2];
            looper.start(time, soundParams);
          }

          break;
        }

        case 'clear-all': {
          if (looper !== null) {
            looper.removeAll();
          }

          break;
        }

        case 'clear': {
          if (looper !== null) {
            const index = message[1];
            looper.remove(index);
          }

          break;
        }

        case 'active':
          playerIsActive = message[1];
          displayActiveState(playerIsActive);
          break;

        case 'max-drops':
          setMaxDrops(message[1]);
          break;

        case 'division':
          loopParams.division = message[1];
          break;

        case 'period':
          loopParams.period = message[1];
          break;

        case 'attenuation':
          loopParams.attenuation = decibelToLinear(message[1])
          break;

        case 'off-gain':
          loopParams.offGain = decibelToLinear(message[1]);
          break;

        case 'gain':
          if (looper !== null) {
            const gain = decibelToLinear(message[1]);
            looper.setGain(gain);
          }
          break;

        default:
          console.error(`received invalid message: ${message}`);
          break;
      }
    }
  }
});

function sendMessage(message) {
  const str = JSON.stringify(message);
  socket.send(str);
}

/*********************************************
 * synchronization
 */
let syncOk = false;

async function startSync() {
  return new Promise((resolve, reject) => {
    function statusFunction(report) {
      if (!syncOk && (report.status === 'training' || report.status === 'sync')) {
        syncOk = true;
        resolve();
      }

      // console.log('sync status:', report);
    }

    syncClient.start(syncSendFunction, syncReceiveFunction, statusFunction);
  });
}

function syncSendFunction(pingId, clientPingTime) {
  const request = [
    0, // this is a ping
    pingId,
    clientPingTime,
  ];

  socket.send(JSON.stringify(request));
};

function syncReceiveFunction(callback) {
  socket.addEventListener('message', e => {
    const response = JSON.parse(e.data);

    if (response[0] === 1) { // this is a pong
      const pingId = response[1];
      const clientPingTime = response[2];
      const serverPingTime = response[3];
      const serverPongTime = response[4];

      callback(pingId, clientPingTime, serverPingTime, serverPongTime);
    }
  });
}

/*********************************************
 * audio
 */
const audioBuffers = [];
let numBuffersReady = 0;
let circleRenderer = null;
let looper = null;
let maxDrops = 0;
let loopParams = {
  division: 3,
  period: 7.5,
  attenuation: 0.70710678118655,
  offGain: 0.1,
};

// get promise for web audio check and start
function requestWebAudio() {
  return new Promise((resolve, reject) => {
    if (audioContext) {
      if (audioContext.state !== 'running') {
        audioContext.resume()
          .then(() => resolve())
          .catch(() => reject());
      } else {
        resolve();
      }
    } else {
      displayMessage('Web audio not available', true);
      reject("web audio not available");
    }
  });
}

/*********************************************
 * graphics
 */
const playerTitle = document.getElementById('player-title');
const playerMessage = document.getElementById('player-message');
let canvasWidth = 0;
let canvasHeight = 0;

playerTitle.innerText = config.title;

function adaptCanvasSize() {
  const rect = document.body.getBoundingClientRect();
  canvasWidth = rect.width;
  canvasHeight = rect.height;
  looper.resize(canvasWidth, canvasHeight);
}

function displayMessage(text, title = false) {
  if (title) {
    playerTitle.style.opacity = 1;
    playerMessage.classList.add('bottom');
  } else {
    playerTitle.style.opacity = 0;
    playerMessage.classList.remove('bottom');
  }

  playerMessage.innerHTML = text;
}

/*********************************************
 * player
 */
// const pitchScales = [
//   [4800, 5200, 5700, 5900, 6200, 6700, 7200, 7600, 8100, 8300, 8600, 9100, 9600],
//   [4800, 5300, 5700, 5900, 6200, 6700, 7200, 7700, 8100, 8300, 8600, 9100, 9600],
//   [4800, 5300, 5700, 5800, 6200, 6700, 7200, 7700, 8100, 8200, 8600, 9100, 9600],
//   [4800, 5300, 5700, 5800, 6300, 6700, 7200, 7700, 8100, 8200, 8700, 9100, 9600],
//   [4800, 5300, 5600, 5800, 6300, 6700, 7200, 7700, 8000, 8200, 8700, 9100, 9600],
//   [4900, 5300, 5600, 5800, 6300, 6700, 7300, 7700, 8000, 8200, 8700, 9100, 9700],
//   [4900, 5300, 5600, 5800, 6300, 6600, 7300, 7700, 8000, 8200, 8700, 9000, 9700],
//   [4900, 5300, 5600, 5900, 6300, 6600, 7300, 7700, 8000, 8300, 8700, 9000, 9700],
//   [4900, 5200, 5600, 5900, 6300, 6600, 7300, 7600, 8000, 8300, 8700, 9000, 9700],
//   [4900, 5200, 5700, 5900, 6300, 6600, 7300, 7600, 8100, 8300, 8700, 9000, 9700],
//   [4900, 5200, 5700, 5900, 6200, 6600, 7300, 7600, 8100, 8300, 8600, 9000, 9700],
//   [4900, 5200, 5700, 5900, 6200, 6700, 7300, 7600, 8100, 8300, 8600, 9100, 9700],
// ];

const pitchScales = [
  [4800, 5000, 5200, 5500, 5700, 6000, 6200, 6400, 6700, 6900, 7200, 7400, 7600, 7900, 8100, 8400, 8600, 8800, 9100, 9300],
  [4900, 5000, 5200, 5500, 5700, 6100, 6200, 6400, 6700, 6900, 7300, 7400, 7600, 7900, 8100, 8500, 8600, 8800, 9100, 9300],
  [4900, 5000, 5200, 5400, 5700, 6100, 6200, 6400, 6600, 6900, 7300, 7400, 7600, 7800, 8100, 8500, 8600, 8800, 9000, 9300],
  [4900, 5100, 5200, 5400, 5700, 6100, 6300, 6400, 6600, 6900, 7300, 7500, 7600, 7800, 8100, 8500, 8700, 8800, 9000, 9300],
  [4900, 5100, 5200, 5400, 5600, 6100, 6300, 6400, 6600, 6800, 7300, 7500, 7600, 7800, 8000, 8500, 8700, 8800, 9000, 9200],
  [4800, 5100, 5300, 5500, 5700, 6000, 6300, 6500, 6700, 6900, 7200, 7500, 7700, 7900, 8100, 8400, 8700, 8900, 9100, 9300],
  [4800, 5000, 5300, 5500, 5700, 6000, 6200, 6500, 6700, 6900, 7200, 7400, 7700, 7900, 8100, 8400, 8600, 8900, 9100, 9300],
];

const scaleDuration = 60; // change scale periodically (in sec)

function getPitches() {
  const time = syncClient.getSyncTime();
  const scaleIndex = Math.floor(time / scaleDuration) % pitchScales.length;
  return pitchScales[scaleIndex];
}

async function startPlaying() {
  window.removeEventListener('touchend', startPlaying);

  displayMessage('Checking for audio...', true);
  await requestWebAudio();

  displayMessage('Synchronizing...', true);
  await startSync();

  const syncTimeFunction = () => syncClient.getSyncTime();
  const convertTimeFunction = (time) => syncClient.getLocalTime(time);
  startAudio(audioContext, syncTimeFunction, convertTimeFunction, audioBuffers);

  if (looper === null && circleRenderer === null) {
    circleRenderer = new CircleRenderer();
    looper = new Looper(circleRenderer, loopParams, updateCount);
  }

  window.addEventListener('resize', adaptCanvasSize);
  adaptCanvasSize();

  playerHasStarted = true;
  displayMessage('Ready!', true);
  enablePointerEvents();
  updateCount();
}

function displayActiveState(active) {
  if (playerHasStarted) {
    if (active) {
      enablePointerEvents();
      updateCount();
    } else {
      disablePointerEvents();
      displayMessage(`<p><span class="big">Thanks!</span></p>`);
    }
  }
}

function triggerSound(x, y) {
  if (looper.numLocalLoops < maxDrops) {
    const pitches = getPitches();
    const pitchIndex = Math.floor((1 - y) * pitches.length);
    const pitch = pitches[pitchIndex];
    const duration = (0.5 + 1.5 * x);

    const soundParams = {
      index: playerIndex,
      x, y,
      gain: 1,
      pitch, duration,
    };

    let time = syncClient.getSyncTime();

    looper.start(time, soundParams, true);
    sendMessage(['sound', time, soundParams]);
  }
}

function clearSound() {
  // remove at own looper
  looper.remove(playerIndex);

  // remove at other players
  sendMessage(['clear']);
}

function setMaxDrops(value) {
  if (value !== maxDrops) {
    maxDrops = value;
    updateCount();
  }
}

function updateCount() {
  if (playerHasStarted && playerIsActive) {
    const numAvailable = Math.max(0, maxDrops - looper.numLocalLoops);
    let htmlContent = null;

    if (numAvailable > 0) {
      const numStr = (numAvailable === maxDrops) ?
        `<span class="huge">${numAvailable}</span>` :
        `<span class="huge">${numAvailable} of ${maxDrops}</span>`;
      const dropStr = (numAvailable === 1) ? 'drop' : 'drops';

      htmlContent = `<p>You have<br />${numStr}<br />${dropStr} to play</p>`;
    } else {
      htmlContent = `<span class="big">Listen!</span>`;
    }


    displayMessage(htmlContent);
  }
}

function decibelToLinear(val) {
  return Math.exp(0.11512925464970229 * val); // pow(10, val / 20)
};

/*********************************************
 * touch events
 */
const pointers = new Map();

function enablePointerEvents() {
  window.addEventListener('touchstart', onPointerStart);
  window.addEventListener('touchmove', onPointerMove);
  window.addEventListener('touchend', onPointerEnd);
  window.addEventListener('touchcancel', onPointerEnd);
}

function disablePointerEvents() {
  window.removeEventListener('touchstart', onPointerStart);
  window.removeEventListener('touchmove', onPointerMove);
  window.removeEventListener('touchend', onPointerEnd);
  window.removeEventListener('touchcancel', onPointerEnd);
}

function onPointerStart(e) {
  const time = 0.001 * performance.now();

  for (let touch of e.changedTouches) {
    const id = touch.indentifier;
    const x = touch.pageX / canvasWidth;
    const y = touch.pageY / canvasHeight;
    pointers.set(id, { time, x, y, dist: 0 });
  }

  e.preventDefault();
}

function onPointerMove(e) {
  const time = 0.001 * performance.now();

  for (let touch of e.changedTouches) {
    const id = touch.indentifier;
    const x = touch.pageX / canvasWidth;
    const y = touch.pageY / canvasHeight;
    const pointer = pointers.get(id);

    if (pointer) {
      const dT = time - pointer.time;
      const dX = x - pointer.x;
      const dY = y - pointer.y;
      const dist = pointer.dist + Math.sqrt(dX * dX + dY * dY);
      const speed = dist / dT;

      pointer.dist = dist;

      if (dist > 5 && speed > 10) {
        clearSound();
        pointers.delete(id);
      }
    }
  }

  e.preventDefault();
}

function onPointerEnd(e) {
  const time = 0.001 * performance.now();

  for (let touch of e.changedTouches) {
    const id = touch.indentifier;
    const x = touch.pageX / canvasWidth;
    const y = touch.pageY / canvasHeight;
    const pointer = pointers.get(id);

    if (pointer) {
      const dT = time - pointer.time;
      const dX = x - pointer.x;
      const dY = y - pointer.y;
      const dist = pointer.dist + Math.sqrt(dX * dX + dY * dY);

      if (dist < 0.1) {
        triggerSound(x, y);
      }

      pointers.delete(id);
    }
  }

  e.preventDefault();
}
