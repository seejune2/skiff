# Skiff

Electron + React + xterm.js + ssh2로 만드는 SSH 데스크톱 클라이언트. 계획과 범위는 `SSH_WORKBENCH_HANDOFF.md` 참고.

## 실행

```
npm install
node node_modules/electron/install.js   # npm이 install 스크립트를 건너뛰어 Electron 바이너리가 없을 때
npm run dev        # 개발 실행
npm test           # SSH 연결 계층 테스트 (로컬 ssh2 테스트 서버 사용)
npm run typecheck
npm run dist       # dist\Skiff-<버전>-setup.exe (설치) + Skiff-<버전>-portable.exe
npm run release    # 빌드 후 GitHub Releases에 올림 (환경변수 GH_TOKEN 필요)
```

## 진행 상황

- [x] 단계 A: SSH 터미널 (비밀번호/개인키/keyboard-interactive, 호스트 키 확인, 탭, 세션 저장·그룹·검색, 복사·붙여넣기·찾기, 재접속)
- [x] 단계 B: X11 포워딩 (`virt-manager` 표시 확인, DISPLAY :0 고정, X 서버 없으면 VcXsrv 자동 실행)
- [x] 단계 C: SFTP (목록, 파일·폴더 업로드/다운로드, 탐색기 드래그앤드롭, 새 폴더, 이름 바꾸기, 삭제, 진행률, 취소, 재시도, 동시 3개 대기열)
- [x] 단계 D: 포트포워딩 (Local/Remote/Dynamic SOCKS5, 세션별 규칙, 자동 시작, 터널 패널에서 시작/중지. `+` 탭에서 `ssh -L/-R/-D`)

- [x] 로컬 터미널: 탭 바 `＋` 메뉴에서 PowerShell, PowerShell 7, cmd, WSL 배포판 (node-pty/ConPTY). claude, codex 같은 TUI 동작 확인
- [x] 분할 보기: 열린 탭을 격자로, 최대 8칸 (`◫ 분할`)
- [x] RDP 세션: 더블클릭하면 `mstsc /v:호스트:포트`
- [x] 동시 입력: 체크한 탭에만 같은 키 입력 (`⇉ 동시 입력`, 탭·창 머리줄의 체크박스)
- [x] 세션 로그: `문서\Skiff Logs`에 제어 문자 뺀 텍스트로 저장 (`● 로그`)
- [x] 명령 스니펫: 저장해 두고 현재 탭(또는 동시 입력 대상)에 실행 (`⌘ 스니펫`)
- [x] 원격 파일 편집: SFTP에서 파일 더블클릭하면 임시 폴더로 받아 기본 편집기로 열고, 저장하면 자동 업로드 (20MB 제한, 충돌 검사 없음)
- [ ] 점프 호스트(ProxyJump)

`＋` 메뉴의 "SSH 빠른 접속"은 `ssh [-p 포트] [-X] [-i 키] [-L/-R/-D ...] 사용자@호스트` 로 임시 접속하고, 끊기면 프롬프트로 돌아온다.

## 안정화 (1단계)

- 네트워크로 끊기면 2·5·10·20·30초 간격으로 최대 5번 자동 재접속. 사용자가 끊거나 인증 실패면 하지 않음
- 연결 끊김 감지 30초 (keepalive 10초 × 3)
- SFTP 오류 문구 한국어화
- 사람이 직접 확인할 항목은 `docs/점검목록.md`

## 설정 (2단계)

`⚙ 설정`에서 터미널 글꼴·크기, 색 조합(어두움/밝음/Solarized Dark), 앱 화면 테마(밝게/어둡게),
기억할 줄 수, 커서 모양·깜빡임, Ctrl+V 붙여넣기를 바꾼다. userData의 `settings.json`에 저장되고
열려 있는 터미널에 바로 반영된다.

## 배포

- 설치본: `Skiff-<버전>-setup.exe` (설치 위치 선택 가능, 바탕화면 바로가기)
- 무설치: `Skiff-<버전>-portable.exe`
- 자동 업데이트: 설치본에서만 동작. 앱을 켤 때 GitHub Releases를 확인하고, 새 버전이 있으면 받아서 다음 실행에 적용
- 새 버전 내는 법: `package.json` version 올리기 → `set GH_TOKEN=...` → `npm run release`
- 코드 서명 인증서가 없어서 Windows SmartScreen 경고는 뜬다. "추가 정보 > 실행"

## 구조

- `src/main/ssh.ts` — SSH 연결, 인증, 호스트 키 확인 (Electron 의존 없음, 테스트 대상)
- `src/main/index.ts` — 창, IPC, 입력 검증
- `src/main/sessions.ts`, `knownHosts.ts`, `secrets.ts` — userData 디렉터리의 버전 포함 JSON 저장
- `src/preload/index.ts` — renderer에 노출하는 API
- `src/renderer/src` — 화면 (세션 목록, 탭, 터미널, 대화상자)
"# skiff" 
