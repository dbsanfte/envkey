import { log } from "@core/lib/utils/logger";
import WebSocket from "isomorphic-ws";
import { Client, Api } from "@core/types";
import { getApiAuthParams } from "@core/lib/client";
import { wait } from "@core/lib/utils/wait";
import * as R from "ramda";
import { sendWorkerToMainMessage } from "./proc_status_worker";

const CONNECTION_TIMEOUT = 5000,
  CONNECT_MAX_JITTER = 1000 * 3, // 3 seconds
  RETRY_BASE_DELAY = 5000,
  PING_INTERVAL = 10000,
  PING_TIMEOUT = 9000,
  sockets: Record<string, WebSocket> = {},
  retryTimeouts: Record<string, ReturnType<typeof setTimeout>> = {},
  receivedPong: Record<string, boolean> = {};

let socketPingLoopTimeout: NodeJS.Timeout | undefined;

export const resolveOrgSockets = async (
    state: Client.OrgSocketStateSlice,
    skipJitter?: boolean
  ) => {
    if (state.locked || state.networkUnreachable) {
      closeAllOrgSockets();
      return;
    }

    const promises: Promise<any>[] = [];

    for (let account of Object.values(state.orgUserAccounts)) {
      if (!account) {
        continue;
      }
      if (
        account.token &&
        !sockets[account.userId] &&
        !retryTimeouts[account.userId]
      ) {
        promises.push(connectSocket(state, account.userId, -1, skipJitter));
      } else if (!account.token) {
        clearSocket(account.userId, true);
      }
    }

    if (promises.length > 0) {
      await Promise.all(promises);
    }
  },
  closeAllOrgSockets = () => {
    for (let userId in sockets) {
      clearSocket(userId);
    }
  },
  clearSocket = (userId: string, silent = false) => {
    // log("clearing socket " + userId, { silent });
    const socket = sockets[userId];
    if (socket) {
      if (!silent) {
        log("Closing web socket:", { userId });
      }
      try {
        socket.removeAllListeners();
        socket.close();
      } catch (err) {
        log("Error clearing socket: ", { err, userId });
      }

      delete sockets[userId];
    }
    clearRetryTimeout(userId);
  },
  stopSocketPingLoop = () => {
    if (socketPingLoopTimeout) {
      clearTimeout(socketPingLoopTimeout);
      socketPingLoopTimeout = undefined;
    }
  },
  socketPingLoop = () => {
    R.toPairs(sockets).forEach(([userId, socket]) => {
      if (socket.readyState != WebSocket.OPEN) {
        return;
      }
      socket.ping((err: Error | null) => {
        if (err) {
          log(`Socket error on ping. closing...`, { err, userId });
          clearSocket(userId);
        } else {
          receivedPong[userId] = false;
          setTimeout(() => {
            if (!receivedPong[userId]) {
              log(`Socket ping timed out. closing...`, { userId });
              socket.close();
              delete receivedPong[userId];
              sendWorkerToMainMessage({ type: "refreshSession", userId });
            }
          }, PING_TIMEOUT);
        }
      });
    });

    socketPingLoopTimeout = setTimeout(socketPingLoop, PING_INTERVAL);
  };

const connectSocket = async (
    state: Client.OrgSocketStateSlice,
    userId: string,
    reconnectAttempt = -1,
    skipJitter?: boolean
  ) => {
    const account = state.orgUserAccounts[userId];

    if (!account || !account.token) {
      clearSocket(userId, reconnectAttempt > 0);
      return;
    }

    const endpoint = "wss://" + account.hostUrl;

    if (!skipJitter) {
      await wait(CONNECT_MAX_JITTER);
    }

    const socket = new WebSocket(endpoint, {
      headers: {
        authorization: JSON.stringify(getApiAuthParams(account)),
      },
      timeout: CONNECTION_TIMEOUT,
    });

    socket.on("pong", () => {
      if (receivedPong[userId] === false) {
        receivedPong[userId] = true;
      }
    });

    // getReconnectAttempt allows event listeners, defined below, to access the
    // the value reconnectAttempt in this scope. This value is managed and reset
    // inside connectSocket and not in any of the listeners, but it needs to be
    // available at its current value to those listeners
    const getReconnectAttempt = () => {
      reconnectAttempt++;
      return reconnectAttempt;
    };

    const logSocketData = {
      socketUrl: socket.url,
      org: `${account.orgName}|${account.orgId}`,
      email: account.email,
      userId: account.userId,
    };
    // This is a bit too spammy... uncomment for debugging purposes
    // log("Connecting to Api socket server", {
    //   reconnectAttempt,
    //   ...logSocketData,
    // });

    sockets[account.userId] = socket;
    clearRetryTimeout(account.userId);

    socket.addEventListener("open", () => {
      log("Socket connected", { reconnectAttempt, ...logSocketData });

      if (reconnectAttempt > -1) {
        sendWorkerToMainMessage({ type: "refreshSession", userId });
      }

      reconnectAttempt = -1;
    });

    socket.addEventListener("message", getOnSocketUpdate(account));
    socket.addEventListener(
      "close",
      getOnSocketClosed("close", state, account, getReconnectAttempt)
    );
    socket.addEventListener(
      "error",
      getOnSocketClosed("error", state, account, getReconnectAttempt)
    );
  },
  getOnSocketUpdate =
    (account: Client.ClientUserAuth) => (evt: WebSocket.MessageEvent) => {
      log("Received update message for org:", {
        fromSocketUrl: evt.target.url,
        org: account.orgName,
        email: account.email,
        userId: account.userId,
      });
      const message = JSON.parse(
        evt.data.toString()
      ) as Api.OrgSocketUpdateMessage;
      sendWorkerToMainMessage({ type: "accountUpdated", message, account });
    },
  clearRetryTimeout = (userId: string) => {
    if (retryTimeouts[userId]) {
      clearTimeout(retryTimeouts[userId]);
      delete retryTimeouts[userId];
    }
  },
  getOnSocketClosed =
    (
      type: "close" | "error",
      state: Client.OrgSocketStateSlice,
      account: Client.ClientUserAuth,
      getReconnectAttempt: () => number
    ) =>
    (evt: WebSocket.CloseEvent | WebSocket.ErrorEvent) => {
      const reconnectAttempt = getReconnectAttempt();

      const logAccountData = {
        org: account.orgName,
        email: account.email,
        userId: account.userId,
      };

      if (reconnectAttempt == 0) {
        const logSocketData = {
          ...logAccountData,
          message: "message" in evt ? evt.message : undefined,
        };
        log(`Socket received ${type} event`, logSocketData);
      }

      clearSocket(account.userId, reconnectAttempt > 0);

      let throttled = false;
      let alwaysFetchSession = false;
      let shouldRetry = true;
      let timeoutMultiplier = 1;
      if (
        ("message" in evt && evt.message.endsWith("401")) ||
        ("code" in evt && evt.code === 4001)
      ) {
        // don't retry when response is unauthorized
        log("Socket connection unauthorized. Won't retry.", logAccountData);
        shouldRetry = false;
        alwaysFetchSession = true;
      } else if ("message" in evt && evt.message.endsWith("429")) {
        throttled = true;
        timeoutMultiplier = 100;
        log(
          `Socket connection attempt throttled. Will retry connection every ${
            RETRY_BASE_DELAY * timeoutMultiplier
          }ms + jitter`,
          logAccountData
        );
      } else if ("message" in evt && evt.message.includes("ENOTFOUND")) {
        timeoutMultiplier = 100;
        log(
          `Socket server isn't reachable. Will retry connection every ${
            RETRY_BASE_DELAY * timeoutMultiplier
          }ms + jitter.`,
          logAccountData
        );
      } else if (reconnectAttempt == 0) {
        log(
          `Will retry connection every ${RETRY_BASE_DELAY}ms + jitter`,
          logAccountData
        );
      }

      sendWorkerToMainMessage({
        type: "refreshSession",
        userId: account.userId,
        abortIfError: !alwaysFetchSession,
      });

      if (shouldRetry) {
        retryTimeouts[account.userId] = setTimeout(
          () => connectSocket(state, account.userId, reconnectAttempt),
          RETRY_BASE_DELAY * timeoutMultiplier
        );
      }
    };
