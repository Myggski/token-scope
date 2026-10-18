const { contextBridge, ipcRenderer } = require("electron");


contextBridge.exposeInMainWorld("tokenscope", {
  load: () => ipcRenderer.invoke("data:load"),
  readStore: () => ipcRenderer.invoke("store:read"),
  setSettings: (changes) => ipcRenderer.invoke("settings:set", changes),
  setFavorite: (id, on) => ipcRenderer.invoke("favorite:set", id, on),
  syncJobs: () => ipcRenderer.invoke("jobs:sync"),
  deleteJob: (id) => ipcRenderer.invoke("job:delete", id),
  setJobModels: (jobId, modelIds) => ipcRenderer.invoke("job:setModels", jobId, modelIds),
  aiLaunch: () => ipcRenderer.invoke("ai:launch"),
  copy: (text) => ipcRenderer.invoke("clipboard:write", text),
  openDataFolder: () => ipcRenderer.invoke("data:openFolder"),
  clearData: (kind) => ipcRenderer.invoke("data:clear", kind),
  historySources: () => ipcRenderer.invoke("history:sources"),
  setTracking: (id, enabled) => ipcRenderer.invoke("history:setTracking", id, enabled),
  historyList: () => ipcRenderer.invoke("history:list"),
  setHistoryKeep: (days) => ipcRenderer.invoke("history:setKeep", days),
  onStoreChanged: (callback) => ipcRenderer.on("store:changed", () => callback()),
});
