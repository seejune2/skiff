import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { ConnStatus, LocalProfile, RemoteEdit, Settings, Snippet, PromptReply, PromptRequest, RemoteEntry, Session, SessionInput, Transfer, TunnelStatus } from '../shared/types'

function on<A extends unknown[]>(channel: string, listener: (...args: A) => void): () => void {
  const wrapped = (_e: IpcRendererEvent, ...args: unknown[]) => listener(...(args as A))
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api = {
  sessions: {
    list: (): Promise<Session[]> => ipcRenderer.invoke('sessions:list'),
    save: (input: SessionInput): Promise<Session> => ipcRenderer.invoke('sessions:save', input),
    temp: (input: SessionInput): Promise<Session> => ipcRenderer.invoke('sessions:temp', input),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('sessions:delete', id),
    pickKey: (): Promise<string | null> => ipcRenderer.invoke('sessions:pickKey')
  },
  secrets: {
    available: (): Promise<boolean> => ipcRenderer.invoke('secrets:available'),
    has: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('secrets:has', sessionId),
    delete: (sessionId: string): Promise<void> => ipcRenderer.invoke('secrets:delete', sessionId)
  },
  ssh: {
    connect: (sessionId: string, connId: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke('ssh:connect', sessionId, connId, cols, rows),
    write: (connId: string, data: string) => ipcRenderer.send('ssh:write', connId, data),
    resize: (connId: string, cols: number, rows: number) => ipcRenderer.send('ssh:resize', connId, cols, rows),
    disconnect: (connId: string) => ipcRenderer.send('ssh:disconnect', connId),
    onData: (listener: (connId: string, data: Uint8Array) => void) => on('ssh:data', listener),
    onStatus: (listener: (status: ConnStatus) => void) => on('ssh:status', listener)
  },
  sftp: {
    list: (connId: string, path: string): Promise<{ path: string; entries: RemoteEntry[] }> =>
      ipcRenderer.invoke('sftp:list', connId, path),
    mkdir: (connId: string, path: string): Promise<void> => ipcRenderer.invoke('sftp:mkdir', connId, path),
    rename: (connId: string, from: string, to: string): Promise<void> => ipcRenderer.invoke('sftp:rename', connId, from, to),
    delete: (connId: string, path: string, isDir: boolean): Promise<void> => ipcRenderer.invoke('sftp:delete', connId, path, isDir),
    upload: (connId: string, dir: string): Promise<void> => ipcRenderer.invoke('sftp:upload', connId, dir),
    download: (connId: string, path: string): Promise<void> => ipcRenderer.invoke('sftp:download', connId, path),
    uploadFolder: (connId: string, dir: string): Promise<void> => ipcRenderer.invoke('sftp:uploadFolder', connId, dir),
    downloadFolder: (connId: string, path: string): Promise<void> => ipcRenderer.invoke('sftp:downloadFolder', connId, path),
    /** 탐색기에서 끌어다 놓은 파일·폴더 */
    uploadDropped: (connId: string, dir: string, files: File[]): Promise<void> =>
      ipcRenderer.invoke('sftp:uploadPaths', connId, dir, files.map((f) => webUtils.getPathForFile(f))),
    cancel: (id: string) => ipcRenderer.send('sftp:cancel', id),
    retry: (id: string) => ipcRenderer.send('sftp:retry', id),
    forget: (id: string) => ipcRenderer.send('sftp:forget', id),
    onTransfer: (listener: (t: Transfer) => void) => on('sftp:transfer', listener)
  },
  edits: {
    open: (connId: string, remote: string): Promise<string> => ipcRenderer.invoke('edit:open', connId, remote),
    list: (): Promise<RemoteEdit[]> => ipcRenderer.invoke('edit:list'),
    close: (local: string) => ipcRenderer.send('edit:close', local),
    onStatus: (listener: (s: RemoteEdit) => void) => on('edit:status', listener)
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    save: (settings: Settings): Promise<Settings> => ipcRenderer.invoke('settings:save', settings)
  },
  snippets: {
    list: (): Promise<Snippet[]> => ipcRenderer.invoke('snippets:list'),
    save: (list: Snippet[]): Promise<Snippet[]> => ipcRenderer.invoke('snippets:save', list)
  },
  logs: {
    start: (connId: string, name: string): Promise<string | undefined> => ipcRenderer.invoke('log:start', connId, name),
    stop: (connId: string) => ipcRenderer.send('log:stop', connId),
    reveal: (path: string) => ipcRenderer.send('log:reveal', path)
  },
  rdp: {
    open: (sessionId: string): Promise<void> => ipcRenderer.invoke('rdp:open', sessionId)
  },
  local: {
    profiles: (): Promise<LocalProfile[]> => ipcRenderer.invoke('local:profiles'),
    open: (profileId: string, connId: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke('local:open', profileId, connId, cols, rows)
  },
  tunnels: {
    start: (connId: string, ruleId: string): Promise<void> => ipcRenderer.invoke('tunnels:start', connId, ruleId),
    stop: (connId: string, ruleId: string) => ipcRenderer.send('tunnels:stop', connId, ruleId),
    states: (connId: string): Promise<Record<string, boolean>> => ipcRenderer.invoke('tunnels:states', connId),
    onStatus: (listener: (s: TunnelStatus) => void) => on('tunnels:status', listener)
  },
  prompts: {
    onRequest: (listener: (req: PromptRequest) => void) => on('prompt:request', listener),
    reply: (id: string, reply: PromptReply) => ipcRenderer.send('prompt:reply', id, reply)
  }
}

export type Api = typeof api
contextBridge.exposeInMainWorld('api', api)
