import { SyncServer } from './ircam-sync/server.js';
import express from 'express';
import WebSocket from 'ws';
import http from 'http';
import params from './params.js';

let playerCount = 0;
let readyCount = 0;

/****************************************************************
 * http server
 */
const httpPort = 3000;
const app = express();

const httpServer = http
  .createServer(app)
  .listen(httpPort, () => console.log(`HTTP server listening on port ${httpPort}`));

app.use(express.static('.'));

/****************************************************************
 * websocket server
 */
const webSocketServer = new WebSocket.Server({ server: httpServer });
console.log(`websocket server listening`);

webSocketServer.on('connection', (socket, req) => {
  if (req.url.endsWith('/controller')) {
    // controller clients
    controllerSockets.add(socket);

    sendCurrentParameterValues(socket);
    sendMessage(socket, ['player-count', playerCount, readyCount]);

    socket.on('close', () => {
      controllerSockets.delete(socket);
    });

    socket.on('message', (data) => {
      if (data.length > 0) {
        const message = JSON.parse(data);
        const selector = message[0];

        switch (selector) {
          case 'clear':
            clearAll();
            sendToAllControllers(['clear'], socket);
            break;

          default:
            updateClientParameters(socket, selector, message[1]);
            break;
        }
      } else {
        socket.send(''); // socket pong
      }
    });

  } else {
    // player clients
    const receiveFunction = (callback) => {
      socket.on('message', (data) => {
        const request = JSON.parse(data);

        if (request[0] === 0) { // this is a ping
          const pingId = request[1];
          const clientPingTime = request[2];
          callback(pingId, clientPingTime);
        }
      });
    };

    const sendFunction = (pingId, clientPingTime, serverPingTime, serverPongTime) => {
      const response = [
        1, // this is a pong
        pingId,
        clientPingTime,
        serverPingTime,
        serverPongTime,
      ];

      socket.send(JSON.stringify(response));
    };

    syncServer.start(sendFunction, receiveFunction);

    const playerIndex = addPlayerToList(socket);
    sendMessage(socket, ['player-index', playerIndex]);

    sendToAllControllers(['player-count', ++playerCount, readyCount]);

    socket.on('message', (data) => {
      if (data.length > 0) {
        const message = JSON.parse(data);
        const selector = message[0];

        switch (selector) {
          case 'get-params': {
            sendCurrentParameterValues(socket);

            readyPlayers.add(socket);
            sendToAllControllers(['player-count', playerCount, ++readyCount]);

            break;
          }

          case 'sound': {
            const time = message[1];
            const soundParams = message[2];
            const playerIndex = playerIndices.get(socket);
            triggerEchos(playerIndex, time, soundParams);
            break;
          }

          case 'clear': {
            clearEchoes(playerIndex);
            break;
          }

          default:
            break;
        }
      }
    });

    socket.on('close', () => {
      clearEchoes(playerIndex);

      if (removePlayerFromList(socket) !== null) {
        sendToAllControllers(['player-count', --playerCount, readyCount]);
      }
    });
  }
});

function sendMessage(socket, message) {
  const str = JSON.stringify(message);
  socket.send(str);
}

function sendStrToSet(set, str, except = null) {
  for (let socket of set) {
    if (socket !== null && socket !== except) {
      socket.send(str);
    }
  }
}

/****************************************************************
 * synchronization
 */
const startTime = process.hrtime();
const getTimeFunction = () => {
  const now = process.hrtime(startTime);
  return now[0] + now[1] * 1e-9;
}
const syncServer = new SyncServer(getTimeFunction);

/****************************************************************
 * players
 */
const playerList = [];
const echoPlayerList = [];
const freePlayerIndices = new Set();
const playerIndices = new Map();
const readyPlayers = new Set();

function getFreePlayerIndex() {
  const iter = freePlayerIndices.values();
  const first = iter.next();
  const index = first.value;

  if (index !== undefined) {
    freePlayerIndices.delete(index);
    return index;
  }

  return playerList.length;
}

function addPlayerToList(socket) {
  const playerIndex = getFreePlayerIndex();

  playerList[playerIndex] = socket;
  echoPlayerList[playerIndex] = new Set();
  playerIndices.set(socket, playerIndex);

  return playerIndex;
}

function removePlayerFromList(socket) {
  const playerIndex = playerIndices.get(socket);

  if (playerIndex !== undefined && playerList[playerIndex]) {
    playerList[playerIndex] = null;
    freePlayerIndices.add(playerIndex);

    // clear list
    let lastIndex = playerList.length - 1;
    while (lastIndex >= 0 && playerList[lastIndex] === null) {
      freePlayerIndices.delete(lastIndex);
      playerList.length = lastIndex;
      lastIndex--;
    }

    echoPlayerList[playerIndex] = null;
    playerIndices.delete(socket);

    if (readyPlayers.delete(socket)) {
      sendToAllControllers(['player-count', playerCount, --readyCount]);
    }

    return playerIndex;
  }

  return null;
}

function triggerEchos(playerIndex, time, soundParams) {
  const playerListLength = playerList.length;
  const division = paramValues['division'];
  const numPlayersInLoop = Math.min(division, readyCount);
  const maxEchoPlayers = numPlayersInLoop - 1;

  if (maxEchoPlayers > 0) {
    const period = paramValues['period'];
    const attenuation = decibelToLinear(paramValues['attenuation']);
    const echoPeriod = period / numPlayersInLoop;
    let echoDelay = 0;

    let echoPlayerIndex = (playerIndex + 1) % playerListLength;
    const echoPlayers = [];
    const echoAttenuation = Math.pow(attenuation, 1 / numPlayersInLoop);

    while (echoPlayers.length < maxEchoPlayers && echoPlayerIndex !== playerIndex) {
      const echoPlayer = playerList[echoPlayerIndex];

      if (echoPlayer) {
        echoDelay += echoPeriod;
        soundParams.gain *= echoAttenuation;

        sendMessage(echoPlayer, ['echo', time + echoDelay, soundParams]);
        echoPlayers.push(echoPlayerIndex);
      }

      echoPlayerIndex = (echoPlayerIndex + 1) % playerListLength;
    }

    echoPlayerList[playerIndex] = echoPlayers;
  }
}

function clearEchoes(playerIndex) {
  const echoPlayers = echoPlayerList[playerIndex];

  if (echoPlayers) {
    for (let echoIndex of echoPlayers) {
      const player = playerList[echoIndex];

      if (player) {
        sendMessage(player, ['clear', playerIndex]);
      }
    }
  }
}

function clearAll() {
  for (let player of readyPlayers) {
    sendMessage(player, ['clear-all']);
  }
}

function sendToAllPlayers(message) {
  const str = JSON.stringify(message);
  sendStrToSet(playerList, str);
}

function decibelToLinear(val) {
  return Math.exp(0.11512925464970229 * val); // pow(10, val / 20)
};

/********************************************
 * controller parameters
 */
let controllerSockets = new Set();
const paramsByName = {};
const paramValues = {};

for (let param of params) {
  if (param.def !== undefined) {
    paramsByName[param.name] = param;
    paramValues[param.name] = param.def;
  }
}

function updateClientParameters(socket, selector, value) {
  paramValues[selector] = value;
  sendToAllControllers([selector, value], socket);
  sendToAllPlayers([selector, value]);
}

function sendCurrentParameterValues(socket) {
  for (let name in paramValues) {
    const value = paramValues[name];

    sendMessage(socket, [name, value]);
  }
}

function sendToAllControllers(message, except = null) {
  const str = JSON.stringify(message);
  sendStrToSet(controllerSockets, str, except);
}
