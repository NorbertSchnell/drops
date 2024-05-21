import paramConfig from './params.js'
import config from './config.js'

const playerCountElem = document.getElementById('player-count');
const readyCountElem = document.getElementById('ready-count');
const controllerContainer = document.getElementById('controller-container');
/*********************************************
 * websocket communication
 */
const webSocketUrl = config['websocket-url'];
const socket = new WebSocket(`${webSocketUrl}controller`);

// listen to opening websocket connections
socket.addEventListener('open', (event) => {
  // send regular ping messages
  setInterval(() => {
    if (socket.readyState == socket.OPEN) {
      socket.send('');
    }
  }, 10000);
});

// listen to messages from server
socket.addEventListener('message', (event) => {
  const data = event.data;

  if (data.length > 0) {
    const message = JSON.parse(data);
    const selector = message[0];
    const value = message[1];

    // dispatch incomming messages
    switch (selector) {
      case 'player-count':
        playerCountElem.innerHTML = value;
        readyCountElem.innerHTML = message[2];
        break;

      case 'active':
        setToggle(selector, value, false);
        break;

      case 'max-drops':
      case 'division':
      case 'period':
      case 'attenuation':
      case 'off-gain':
      case 'gain':
        setParameter(selector, value, false);
        break;

      case 'clear':
        pushButton(selector, false);
        break;

      default:
        console.error(`received invalid message: ${message}`);
        break;
    }
  }
});

function sendMessage(message) {
  const str = JSON.stringify(message);
  socket.send(str);
}

/*********************************************
 * control
 */
const controllerElements = new Map();
let target = null;

for (let param of paramConfig) {
  const name = param.name;
  const container = document.querySelector(`div[data-name=${name}]`);
  const frame = container.querySelector(`.slider`) || container.querySelector(`.toggle`) || container.querySelector(`.button`);
  const slider = container.querySelector(`.slider-value`);
  const number = container.querySelector(`.number`);
  const elems = { param, container, frame, slider, number };

  controllerElements.set(name, elems);
}

addPointerListeners();

function addPointerListeners() {
  window.addEventListener('touchstart', onPointerStart);
  window.addEventListener('touchmove', onPointerMove);
  window.addEventListener('touchend', onPointerEnd);
  window.addEventListener('touchcancel', onPointerEnd);
  window.addEventListener('mousedown', onPointerStart);
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mouseup', onPointerEnd);
}

function onPointerStart(e) {
  const x = e.changedTouches ? e.changedTouches[0].pageX : e.pageX;
  const y = e.changedTouches ? e.changedTouches[0].pageY : e.pageY;

  target = document.elementFromPoint(x, y);

  const name = target.dataset.name || target.parentNode.dataset.name;
  const norm = getTouchPosition(target, x);

  switch (target.className) {
    case 'slider':
      setParameterNormalized(name, norm, true);
      break;
    case 'label':
      resetParameter(name, true);
      break;
    case 'toggle':
      setToggle(name, null, true);
      break;
    case 'button':
      pushButton(name, true);
      break;
  }
}

function onPointerMove(e) {
  if (target !== null && target.className === 'slider') {
    const x = e.changedTouches ? e.changedTouches[0].pageX : e.pageX;
    const name = target.dataset.name || target.parentNode.dataset.name;
    const norm = getTouchPosition(target, x);
    setParameterNormalized(name, norm, true);
  }
}

function onPointerEnd(e) {
  target = null;
}

function getTouchPosition(target, x) {
  const rect = target.getBoundingClientRect();
  const norm = (x - rect.x) / rect.width;
  return Math.max(0, Math.min(1, norm));
}

function setParameter(name, value, send = false) {
  const elems = controllerElements.get(name);

  if (elems) {
    const param = elems.param;
    const norm = (value - param.min) / (param.max - param.min);
    updateNumericParameter(name, elems, value, norm, send);
  }
}

function setParameterNormalized(name, norm, send = false) {
  const elems = controllerElements.get(name);

  if (elems) {
    const param = elems.param;

    switch (elems.frame.className) {
      case 'slider': {
        const value = (param.max - param.min) * norm + param.min;
        updateNumericParameter(name, elems, value, norm, send);
      }
      default:
        break;
    }
  }
}

function resetParameter(name, send = false) {
  const elems = controllerElements.get(name);

  if (elems) {
    const param = elems.param;

    switch (elems.frame.className) {
      case 'slider': {
        const norm = (param.def - param.min) / (param.max - param.min);
        const value = (param.max - param.min) * norm + param.min;
        updateNumericParameter(name, elems, value, norm, send);
        break;
      }
      case 'toggle': {
        updateBooleanParameter(name, elems, param.def, send);
        break;
      }
      default:
        break;
    }
  }
}

function setToggle(name, value = null, send = false) {
  const elems = controllerElements.get(name);

  if (elems) {
    if (value === null) {
      const frame = elems.frame;
      value = (frame.dataset.active === 'false'); // toggle value
    }

    updateBooleanParameter(name, elems, value, send);
  }
}

function pushButton(name, send) {
  const elems = controllerElements.get(name);

  if (elems) {
    const frame = elems.frame;

    frame.classList.add('active');
    setTimeout(() => frame.classList.remove('active'), 200);

    if (send) {
      sendMessage([name]);
    }
  }
}

function updateNumericParameter(name, elems, value, norm, send = false) {
  const param = elems.param;
  const sliderElem = elems.slider;
  const numberElem = elems.number;
  const quantValue = Math.round(value / param.step);
  value = quantValue * param.step;


  if (param.min >= 0) {
    sliderElem.style.width = `${100 * norm}%`;
    sliderElem.style.left = 0;
  } else {
    const lowerHalf = -param.min / (param.max - param.min);

    if (norm >= lowerHalf) {
      sliderElem.style.width = `${100 * (norm - lowerHalf)}%`;
      sliderElem.style.left = `${100 * lowerHalf}%`;
    } else {
      sliderElem.style.width = `${100 * (lowerHalf - norm)}%`;
      sliderElem.style.left = `${100 * norm}%`;
    }
  }

  const decimals = -Math.floor(Math.log10(param.step));
  numberElem.innerText = value.toFixed(decimals);

  if (send) {
    sendMessage([name, value]);
  }
}

function updateBooleanParameter(name, elems, value, send = false) {
  const toggleElem = elems.frame;
  toggleElem.dataset.active = value;

  if (send) {
    sendMessage([name, value]);
  }
}

