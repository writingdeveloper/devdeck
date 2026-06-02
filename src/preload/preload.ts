import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('devdeck', {});
