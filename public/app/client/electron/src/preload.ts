import { contextBridge, remote, ipcRenderer } from "electron";
import {
  ElectronWindow,
  AvailableClientUpgrade,
  ClientUpgradeProgress,
} from "@core/types/electron";
import Client from "@core/types/client";

const { dialog, app } = remote;

let progressHandler:
  | ((event: any, progress: ClientUpgradeProgress) => void)
  | undefined;

const exposeInterface: ElectronWindow["electron"] = {
  chooseFilePath: async (title, defaultPath) => {
    const { filePath } = await dialog.showSaveDialog({
      title,
      defaultPath,
    });
    return filePath;
  },

  chooseFile: async (message, filters) => {
    const { filePaths } = await dialog.showOpenDialog({
      message,
      filters,
    });
    if (filePaths.length == 1) {
      return filePaths[0];
    }
    return undefined;
  },

  chooseDir: async (message) => {
    const { filePaths } = await dialog.showOpenDialog({
      message,
      properties: ["openDirectory"],
    });
    if (filePaths.length == 1) {
      return filePaths[0];
    }
    return undefined;
  },

  quit: () => app.quit(),

  registerUpgradeAvailableHandler: (handler) =>
    ipcRenderer.on("upgrade-available", (event, available) => {
      console.log("on upgrade-available", available);

      handler(available as AvailableClientUpgrade);
    }),

  registerUpgradeProgressHandler: (handler) => {
    if (progressHandler) {
      ipcRenderer.off("upgrade-progress", progressHandler);
    }

    progressHandler = (event, progress) => {
      console.log("on upgrade-progress", progress);
      handler(progress as ClientUpgradeProgress);
    };

    ipcRenderer.on("upgrade-progress", progressHandler);
  },

  registerUpgradeCompleteHandler: (handler) =>
    ipcRenderer.on("upgrade-complete", (event) => {
      console.log("on upgrade-complete");
      handler();
    }),

  registerUpgradeErrorHandler: (handler) =>
    ipcRenderer.on("upgrade-error", (event) => {
      console.log("on upgrade-error");
      handler();
    }),

  downloadAndInstallUpgrades: () => ipcRenderer.send("install-update"),

  restartWithLatestVersion: () =>
    ipcRenderer.send("restart-with-latest-version"),

  openStripeForm: (params: Client.CloudBillingStripeFormParams) =>
    ipcRenderer.send(
      "open-stripe-form",
      encodeURIComponent(JSON.stringify(params))
    ),

  closeStripeForm: () => {
    ipcRenderer.send("close-stripe-form");
  },

  registerCloseStripeFormHandler: (handler) => {
    ipcRenderer.on("close-stripe-form", handler);
  },

  deregisterCloseStripeFormHandler: (handler) => {
    ipcRenderer.off("close-stripe-form", handler);
  },

  uiLogger: (batch: { msg: string; data?: any }[]) => {
    ipcRenderer.send("ui-logger", batch);
  },

  reportError: (msg: string, userId: string, email: string) => {
    ipcRenderer.send("report-error", { msg, userId, email });
  },

  registerLostCoreHandler: (handler) => {
    ipcRenderer.on("lost-core-process", handler);
  },

  registerStartedCoreHandler: (handler) => {
    ipcRenderer.on("core-process-alive", handler);
  },
};

contextBridge.exposeInMainWorld("electron", exposeInterface);
