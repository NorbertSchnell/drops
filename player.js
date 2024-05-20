import { SyncClient } from './ircam-sync/client.js';
import { startAudio, Looper, CircleRenderer } from "./player-utils.js";
import config from './config.js'

const audioContext = new AudioContext();
let playerIndex = null;
let playerHasStarted = false;
let playerIsActive = true;

const audioFiles = [
  '01-drops-A-C2.mp3',
  '01-drops-B-C2.mp3',
  '02-drops-A-E2.mp3',
  '02-drops-B-E2.mp3',
  '03-drops-A-G2.mp3',
  '03-drops-B-G2.mp3',
  '04-drops-A-A2.mp3',
  '04-drops-B-A2.mp3',
  '05-drops-A-C3.mp3',
  '05-drops-B-C3.mp3',
  '06-drops-A-D3.mp3',
  '06-drops-B-D3.mp3',
  '07-drops-A-G3.mp3',
  '07-drops-B-G3.mp3',
  '08-drops-A-A3.mp3',
  '08-drops-B-A3.mp3',
  '09-drops-A-C4.mp3',
  '09-drops-B-C4.mp3',
  '10-drops-A-E4.mp3',
  '10-drops-B-E4.mp3',
  '11-drops-A-A4.mp3',
  '11-drops-B-A4.mp3',
  '12-drops-A-C5.mp3',
  '12-drops-B-C5.mp3'
];

/*********************************************
 * websocket communication
 */
const webSocketAddr = config['server-addr'];
const webSocketPort = config['server-port'];
const socket = new WebSocket(`ws://${webSocketAddr}:${webSocketPort}`);
const syncClient = new SyncClient(() => 0.001 * performance.now());

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

// get promise that resolves when all audio files are loaded
function loadAudioFiles() {
  numBuffersReady = 0;

  return new Promise((resolve, reject) => {
    // load audio files into audio buffers
    for (let i = 0; i < audioFiles.length; i++) {
      fetch('sounds/' + audioFiles[i])
        .then(data => data.arrayBuffer())
        .then(arrayBuffer => audioContext.decodeAudioData(arrayBuffer))
        .then(decodedAudio => {
          audioBuffers[i] = decodedAudio;
          numBuffersReady++;
          if (numBuffersReady === audioFiles.length) {
            resolve();
          }
        });
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
async function startPlaying() {
  window.removeEventListener('touchend', startPlaying);

  displayMessage('Checking for audio...', true);
  await requestWebAudio();

  displayMessage('Loading audio...', true);
  await loadAudioFiles();

  displayMessage('Synchronizing...', true);
  await startSync();

  const syncTimeFunction = () => syncClient.getSyncTime();
  startAudio(audioContext, syncTimeFunction, audioBuffers);

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
    const soundParams = {
      index: playerIndex,
      gain: 1,
      x: x,
      y: y,
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
