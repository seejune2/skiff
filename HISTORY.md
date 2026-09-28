# Skiff 개발 기록

다음 사람(또는 다음 세션)이 이어서 작업할 수 있게 정리한 문서.
"무엇이 있는지"는 `README.md`, "배포 전 확인"은 `docs/점검목록.md`, 초기 기획은 `SSH_WORKBENCH_HANDOFF.md`.
이 문서는 **왜 그렇게 만들었는지**와 **밟았던 지뢰**를 남긴다.

## 한 줄 요약

Windows용 SSH/SFTP/터널/로컬 셸 데스크톱 앱. Electron + React + xterm.js + ssh2 + node-pty.
저장소 `github.com/seejune2/skiff`, 현재 0.8.0, 테스트 22개.

## 코드 지도

```
src/main/        Electron main. SSH·SFTP·터널·로컬 셸·파일 다루기는 전부 여기서만.
  index.ts       창, IPC 등록, 입력 재검증, 전송 대기열(동시 3개), 파일 대화상자
  ssh.ts         SSH 연결. authConfig()가 인증·호스트키 설정을 만들고 본 연결과 점프 호스트가 공유
  sftp.ts        목록·업로드·다운로드(임시 이름 후 rename)·폴더 훑기·오류 한국어화
  tunnels.ts     Local/Remote/Dynamic(직접 만든 최소 SOCKS5)
  local.ts       node-pty로 PowerShell/cmd/WSL 실행. 셸 목록 탐지
  edits.ts       원격 파일 편집(임시 폴더 + 폴더 감시 + 저장 시 업로드)
  x11.ts         X11 채널을 로컬 X 서버로 중계. 가짜 쿠키 확인 후 인증 제거
  logs.ts        세션 로그(제어 문자 제거)
  sessions.ts / settings.ts / knownHosts.ts / secrets.ts / snippets(index.ts 안) / sshConfig.ts
  jsonFile.ts    버전 붙은 JSON 읽기/쓰기(임시 파일 후 rename)
src/preload/     contextBridge로 여는 API만. 여기 없는 건 renderer가 못 한다
src/renderer/    React 화면. 터미널, 세션 목록, SFTP·터널 패널, 대화상자
src/shared/      main과 renderer가 같이 쓰는 타입과 기본 설정값
test/            vitest. 로컬에 ssh2 서버를 띄워서 진짜로 붙어 본다
```

원칙: renderer는 절대 임의 경로·임의 명령을 main에 넘기지 않는다.
로컬 경로는 main의 파일 대화상자나 드래그앤드롭(webUtils)으로만 정해진다.

## 만든 순서

| 버전 | 내용 |
|---|---|
| 0.1 | SSH 터미널, 세션 저장, 호스트 키 확인, 탭, X11(virt-manager 확인), SFTP, 포트포워딩, portable exe |
| 0.2~0.3 | 사이드바 접기·크기 조절, `+` 빠른 접속 탭, 로컬 셸(node-pty), 분할 보기(최대 8칸), RDP 세션 |
| 0.4 | 안정화: 자동 재접속, 끊김 감지 30초, SFTP 오류 한국어화, 점검 목록 |
| 0.5 | 설정 화면(글꼴·색·테마·스크롤백·커서·Ctrl+V) |
| 0.6 | 이름 Skiff로 변경, 아이콘, NSIS 설치본, 자동 업데이트(electron-updater) |
| 0.7 | 원격 파일 편집 |
| 0.8 | 점프 호스트, ssh config 가져오기, 세션 복제·드래그 이동·내보내기 |

## 왜 이렇게 했나

- **터미널 데이터 경로를 SSH와 로컬 셸이 공유한다.** 둘 다 `ssh:data` / `ssh:status` 채널과 같은 connId 공간을 쓴다. 화면은 구분하지 않는다. 채널 이름이 `ssh:`인 건 역사적 이유다.
- **connId는 renderer가 만든다.** 그래야 connect 응답보다 먼저 오는 상태 이벤트도 탭에 붙는다.
- **자동 재접속은 네트워크 오류일 때만.** 인증 실패로 재시도하면 계정이 잠긴다. `ConnStatus.retryable`, `manual`로 구분한다.
- **SFTP를 열기 전에 `exec true`로 서버를 검사한다.** 로그인 스크립트가 글자를 출력하면 SFTP 프로토콜이 깨지고, ssh2는 그 오류로 SSH 연결 전체를 끊는다. 검사해서 원인을 알려주고 터미널은 살린다. 단 `exec` 자체가 거부되면(SFTP 전용 계정) 검사를 건너뛴다.
- **전송은 임시 이름으로 받고 끝나면 rename.** 취소·실패해도 반쯤 받은 파일이 완성본처럼 남지 않는다.
- **X11은 세션마다 가짜 쿠키를 주고 확인 후 인증을 뗀다.** 로컬 X 서버에는 빈 인증으로 붙는다(VcXsrv 기본 X0.hosts가 localhost 허용). `-ac`는 쓰지 않는다.
- **터널 규칙은 main이 세션에서 찾는다.** renderer는 규칙 id만 넘긴다.
- **분할은 탭을 격자로 배치.** 별도 창 구조를 만들지 않았다. 최대 8칸.
- **WebGL 렌더러 안 붙였다.** 20만 줄(9MB)이 1.4초에 화면 반영된다. 이미 셸 속도와 같다.

## 밟은 지뢰 (다시 밟지 말 것)

- **이 PC의 WSL에는 node가 없다.** `node`는 없고 `npx`는 Windows 바이너리다. 스크립트는 `"/mnt/c/Program Files/nodejs/node.exe"`로 실행한다.
- **npm이 install 스크립트를 건너뛴다.** Electron 바이너리가 없으면 `node node_modules/electron/install.js`를 직접 돌린다.
- **git push는 Windows git으로.** WSL git에는 자격 증명이 없다. `"/mnt/c/Program Files/Git/cmd/git.exe" push origin main`.
- **실행 중인 exe는 덮어쓸 수 없다.** 앱을 켜둔 채 빌드하면 멈춘다. 버전을 올려 새 파일명으로 만들거나 앱을 끄고 빌드한다.
- **IPC로 보내는 객체에 FSWatcher·Timer가 섞이면 직렬화가 깨져 이벤트가 통째로 사라진다.** 상태는 값만 골라 보낸다(`edits.ts`의 `report()`).
- **`<input type="number">`에 `step`을 주면 그 배수만 유효**하다. 20000이 무효가 돼서 저장이 막혔다.
- **electron-builder `artifactName`에 `${target}`을 쓰면 실패**한다. 타깃별(`nsis`, `portable`) 설정 안에서 지정한다.
- **`npm run dist`에 `--win portable`이 박혀 있으면** NSIS는 만들어지지 않는다. 지금은 `--win`이다.
- **ssh2 서버(테스트용)의 `info.cookie`는 16진수 문자열**이다. 바이너리로 착각하면 X11 테스트가 통과하지 않는다.
- **문서 폴더가 OneDrive로 리다이렉트**돼 있다. 로그는 `C:\Users\seeju\OneDrive\문서\Skiff Logs`에 쌓인다.

## 개발할 때 쓰는 것들

- 테스트용 SSH+SFTP 서버: `node .scratch/server.cjs` (127.0.0.1:2222, tester / pw, SFTP 루트 `.scratch/remote`)
- 화면 자동 조작: `.scratch/drive.mjs` — Electron을 `--remote-debugging-port`로 띄우고 CDP로 클릭·입력·드래그·스크린샷.
  ```
  electron.exe . --remote-debugging-port=9335 --user-data-dir=C:\coding\app\ssh\.scratch\ud-test
  node .scratch/drive.mjs 9335 out.png '[["click","셀렉터식"],["type","글자"],["key","Enter"],["wait",500]]'
  ```
  주의: 사용자가 쓰는 창에는 붙지 말 것. 항상 `--user-data-dir`로 분리한다.
- OpenSSH로 재현이 필요하면 Docker로 Rocky Linux 컨테이너를 띄웠다(`dnf install openssh-server`, `PermitRootLogin yes`).
- CSS 셀렉터에 한글 속성값을 쓸 때는 따옴표 필수: `button[title="편집"]`.

## 테스트

`npm test` 22개. 다 로컬에서 진짜 서버를 띄운다.
SSH 인증·호스트 키 변경·한글·창 크기, X11 쿠키 교체, 터널 3종, SFTP 업로드·다운로드 해시와 취소,
폴더 훑기, 점프 호스트, ssh config 파싱, 설정 검증, 하이라이터, 로그 제어 문자 제거.

자동 테스트로 못 잡는 것(실제 접속, X11 창, 드래그앤드롭, 파일 대화상자)은 `docs/점검목록.md`.

## 남은 일

1. **첫 릴리스 올리기** — `GH_TOKEN` 만들고 `npm run release`. 그래야 자동 업데이트가 실제로 동작한다.
2. 그룹 여러 단계(폴더 안 폴더), 최근 접속 목록
3. SFTP 이어받기, 권한(chmod) 보기·바꾸기, 로컬 파일 목록 2단 보기
4. 원격 편집 충돌 검사(열어 둔 사이 서버 파일이 바뀌었는지)
5. macOS·Linux 빌드와 실제 검증 (X11은 XQuartz / 기본 X11)
6. 코드 서명 인증서 (SmartScreen 경고 제거, 유료)
7. 용량 줄이기 (설치본 112MB)

## 알려진 한계

- 원격 파일 편집: 20MB 제한, 충돌 검사 없음
- SFTP: 이어받기 없음, 비어 있지 않은 폴더 삭제 안 됨
- 터널: 바인드 주소는 127.0.0.1 고정
- X11: DISPLAY :0 고정, 로컬 X 서버 쿠키는 쓰지 않음
- RDP: `mstsc` 실행만 한다. 실제 창 띄우는 것까지는 확인하지 않았다
- 빠른 접속(`+` 탭)은 진짜 셸이 아니라 `ssh` 명령만 이해하는 프롬프트다
