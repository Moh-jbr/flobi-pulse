// The only bridge between the UI and the main process. The UI cannot touch
// Node, the network or the file system: it can only send the commands below.
const { contextBridge, ipcRenderer } = require('electron');

const arg = (key) => {
  const hit = (process.argv || []).find((a) => a.startsWith(`--pulse-${key}=`));
  return hit ? hit.slice(`--pulse-${key}=`.length) : '';
};

contextBridge.exposeInMainWorld('pulse', {
  platform: arg('platform') || process.platform,
  version: arg('version'),
  invoke: (cmd, args) => ipcRenderer.invoke('pulse:invoke', { cmd, args }),
  on: (listener) => {
    const handler = (_event, message) => listener(message);
    ipcRenderer.on('pulse:event', handler);
    return () => ipcRenderer.removeListener('pulse:event', handler);
  },
});
