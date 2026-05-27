const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openVideo:       ()              => ipcRenderer.invoke('open-video'),
  getVideoInfo:    fp              => ipcRenderer.invoke('get-video-info', fp),
  extractFrame:    (fp, fn, fps)   => ipcRenderer.invoke('extract-frame', fp, fn, fps),
  createZip:       frames          => ipcRenderer.invoke('create-zip', frames),
  deleteFrame:     fp              => ipcRenderer.invoke('delete-frame', fp),
  showInFolder:    fp              => ipcRenderer.invoke('show-in-folder', fp),
  getPathForFile:  file            => webUtils.getPathForFile(file)
});
