// preload: 只暴露最小 API。真实拖放路径必须经 webUtils.getPathForFile (新版 Electron
// 移除了 File.path; 旧版回退到 f.path)
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
    getPathForFile: (f) => {
        try {
            return webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(f) : (f && f.path) || '';
        } catch (e) {
            return (f && f.path) || '';
        }
    },
    inspect: (p) => ipcRenderer.invoke('archive:inspect', p),
    pack: (items) => ipcRenderer.invoke('archive:pack', items),
    unpack: (p) => ipcRenderer.invoke('archive:unpack', p),
});
