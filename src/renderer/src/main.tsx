import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './App'

// StrictMode는 effect를 두 번 실행해 SSH 연결을 중복으로 여므로 쓰지 않는다.
createRoot(document.getElementById('root')!).render(<App />)
