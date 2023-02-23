import { Client } from "../../types";
import crossFetch, { FetchRequestInit } from "../utils/cross_fetch";
import { toSearchParams } from "../utils/url";
import { v4 as uuid } from "uuid";

export const clientId = uuid(), // unique per client (ephemeral)
  CORE_PROC_PORT = "19047",
  coreMethod = async (
    method: string,
    encryptedAuthToken?: string,
    args?: FetchRequestInit,
    query?: Record<string, string | string[]>
  ) => {
    return crossFetch(
      `http://localhost:${CORE_PROC_PORT}/${method}${
        query ? "?" + toSearchParams(query) : ""
      }`,
      {
        ...(args ?? {}),
        headers: {
          ...(args?.headers ?? {}),
          // in the browser / electron, user-agent is set via args to browser process
          // so this only applies on node
          ...(typeof window == "undefined" && encryptedAuthToken
            ? {
                "User-Agent": `${Client.CORE_PROC_AGENT_NAME}|Node|${encryptedAuthToken}`,
              }
            : {}),
        },
      }
    );
  },
  coreMethodJson = <T extends {}>(
    method: string,
    encryptedAuthToken?: string,
    args?: FetchRequestInit,
    query?: Record<string, string | string[]>
  ) =>
    coreMethod(method, encryptedAuthToken, args, query).then(
      (res) =>
        res
          .json()
          .then((json) => ({ ...json, status: res.status })) as Promise<T>
    ),
  isAlive = (timeout?: number) =>
    coreMethod("alive", undefined, { timeout: timeout ?? 5000 })
      .then((res) => {
        if (!res.ok) {
          return false;
        }

        return res.json().then((json) => json.cliVersion);
      })
      .catch((err) => {
        return false;
      }),
  isInline = (timeout?: number) =>
    coreMethod("inline", undefined, { timeout: timeout ?? 5000 })
      .then((res) => {
        if (!res.ok) {
          return false;
        }

        return res.json().then((json) => json.isInline);
      })
      .catch((err) => {
        return false;
      }),
  stop = async () => {
    try {
      const res = await coreMethod("stop", undefined, { timeout: 2000 });

      if (!res.ok) {
        return false;
      }
    } catch (err) {
      return false;
    }

    while (await isAlive()) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    return true;
  },
  fetchState = (
    accountIdOrCliKey?: string,
    encryptedAuthToken?: string,
    keys?: (keyof Client.State)[]
  ) =>
    coreMethodJson<Client.State>("state", encryptedAuthToken, undefined, {
      clientId,
      ...(accountIdOrCliKey ? { accountIdOrCliKey } : {}),
      ...(keys ? { keys: keys as string[] } : {}),
    }),
  dispatchCore = async <
    T extends Client.Action.EnvkeyAction,
    ReturnFullStateType extends boolean = false
  >(
    action: Client.Action.DispatchAction<T>,
    clientParams: Client.ClientParams<"cli" | "app">,
    accountIdOrCliKey: string | undefined,
    hostUrlOverride?: string,
    encryptedAuthToken?: string,
    returnFullState?: ReturnFullStateType
  ) =>
    coreMethodJson<Client.CoreDispatchResult<ReturnFullStateType>>(
      "action",
      encryptedAuthToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          context: {
            client: clientParams,
            accountIdOrCliKey,
            clientId,
            hostUrl: hostUrlOverride,
          },
          returnFullState,
        }),
      },
      undefined
    );
