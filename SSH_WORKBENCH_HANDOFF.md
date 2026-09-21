# SSH Workbench 프로젝트 인수인계

## 1. 프로젝트 목표

MobaXterm과 같은 원격 접속 데스크톱 도구를 만든다. 핵심 기능은 MobaXterm 수준으로 확장하되, 화면 구성과 사용감은 Xshell을 참고한다.

처음부터 모든 기능을 만들지 않는다. 아래 핵심 4개를 먼저 실제로 사용할 수 있는 수준까지 완성한 뒤 단계적으로 확장한다.

1. SSH 접속
2. SSH X11 포워딩을 통한 `virt-manager` 실행
3. SSH 연결과 통합된 SFTP 파일 전송
4. SSH 포트포워딩

## 2. 확정된 방향

- 지원 운영체제: Windows, macOS, Linux
- 우선 검증 운영체제: Windows
- 배포 대상: 개인용부터 시작
- UI 언어: 한국어
- 디자인: Xshell의 익숙한 배치 + 현대적인 외형
- 기본 테마: 밝은 앱 UI + 어두운 터미널
- 로컬 X 서버: 앱에 포함하지 않고 별도 설치된 X 서버와 연동
  - Windows: VcXsrv
  - macOS: XQuartz
  - Linux: 기존 X11 또는 XWayland
- 실제 SSH 및 `virt-manager` 검증에 사용할 Linux 서버가 있음
- 서버 접속 정보와 비밀번호는 소스나 문서에 저장하지 않고 앱 UI에서 직접 입력

## 3. 권장 기술 구성

- 데스크톱 프레임워크: Electron
- 언어: TypeScript
- UI: React + Vite
- 터미널: xterm.js
- SSH/SFTP/X11/터널 엔진: `ssh2` Node.js 패키지
- 초기 작업 경로: `C:\Users\seeju\source\repos\ssh-workbench`
- 가칭: SSH Workbench

`ssh2`는 interactive shell, SFTP, X11 forwarding, local/remote TCP forwarding 구현에 사용할 수 있다. 직접 SSH 프로토콜이나 터미널 에뮬레이터를 만들지 않는다.

## 4. UI 구조

- 상단: 메뉴와 자주 쓰는 연결 도구
- 왼쪽: 저장된 세션 목록, 그룹, 검색
- 중앙: 여러 SSH 연결을 여는 터미널 탭
- 보조 패널: 현재 SSH 세션과 연결된 SFTP 파일 브라우저
- SFTP 패널은 접거나 펼칠 수 있어야 함
- 포트포워딩은 세션 설정과 별도 관리 화면에서 편집 가능
- 연결 상태, X11 상태, 활성 터널, 파일 전송 상태를 명확히 표시

## 5. 보안 및 프로세스 경계

- SSH, SFTP, X11, 포트포워딩, 파일 시스템 처리는 Electron main process에서 수행
- renderer에는 Node.js 직접 접근을 허용하지 않음
- `contextIsolation: true`, `nodeIntegration: false` 사용
- preload를 통해 필요한 IPC API만 노출
- 첫 SSH 접속 시 호스트 키 지문을 사용자에게 확인
- 저장된 호스트 키가 바뀌면 자동 연결하지 않고 차단 후 재확인
- 비밀번호 저장은 선택 사항
- 저장 시 Electron `safeStorage` 또는 OS 자격 증명 저장소 사용
- Linux에서 안전한 비밀 저장소를 사용할 수 없으면 비밀번호 저장 기능을 비활성화
- X11 접근 제어를 끄는 `-ac` 방식에 의존하지 않음
- 기본 포트포워딩 바인딩 주소는 loopback

## 6. 1차 구현 단계

### 단계 A: 앱 뼈대와 SSH 터미널

- Electron + TypeScript + React + Vite 프로젝트 생성
- xterm.js 터미널 렌더링
- 호스트, 포트, 사용자명 입력
- 비밀번호 인증
- 개인키와 개인키 암호 인증
- keyboard-interactive 인증
- 터미널 입력/출력과 창 크기 변경 전달
- 연결 종료와 수동 재접속
- 여러 연결을 탭으로 관리
- 세션 저장, 수정, 삭제, 그룹, 검색
- UTF-8과 한글 입출력 확인
- 복사, 붙여넣기, 검색, 스크롤 지원

### 단계 B: X11 포워딩

- 운영체제별 로컬 X 서버 실행 여부와 `DISPLAY` 감지
- 자동 감지 실패 시 DISPLAY와 인증 파일 수동 지정
- SSH shell 생성 시 X11 forwarding 요청
- 원격 X11 연결을 로컬 X 서버로 전달
- MIT-MAGIC-COOKIE-1 인증 처리
- 세션마다 임시 가짜 쿠키를 사용하고 로컬 X 서버 쿠키로 안전하게 교체
- 원격 서버의 `X11Forwarding`, `xauth`, 로컬 X 서버 상태 진단
- 원격 터미널에서 `virt-manager` 실행 시 로컬 데스크톱에 별도 창 표시
- X11 실패 시 원인을 보여주되 SSH 터미널 연결은 유지

`virt-manager` 창을 Electron 내부에 삽입하지 않는다. 로컬 X 서버가 일반 데스크톱 창으로 표시하게 한다.

### 단계 C: SFTP

- 현재 SSH 연결을 재사용해 SFTP 채널 생성
- 로컬/원격 디렉터리 탐색
- 업로드, 다운로드, 폴더 생성, 이름 변경, 삭제, 새로고침
- 파일과 폴더 드래그앤드롭
- 전송 진행률, 취소, 실패 후 재시도
- 파일 덮어쓰기 확인
- 임시 파일로 전송한 후 완료 시 최종 이름으로 변경
- 중단된 전송을 완료로 표시하지 않음
- 재귀 전송 시 심볼릭 링크를 따라가지 않음

### 단계 D: 포트포워딩

- Local forwarding: 로컬 포트를 원격 목적지로 전달
- Remote forwarding: 원격 포트를 로컬 목적지로 전달
- Dynamic forwarding: 로컬 SOCKS5 프록시
- 세션별 터널 규칙 저장
- 터널 시작, 중지, 상태, 오류 표시
- 포트 충돌과 서버 거부를 사용자에게 표시
- SSH 연결 종료 시 관련 listener와 channel 정리

## 7. 최소 내부 인터페이스

preload에서 renderer로 아래 범주의 명시적 API만 제공한다. 이름은 구현 중 조정할 수 있지만 기능 경계는 유지한다.

- `sessions`: 목록, 저장, 수정, 삭제
- `ssh`: 연결, 연결 해제, 입력, 터미널 크기 변경, 상태 이벤트
- `sftp`: 목록, 업로드, 다운로드, 생성, 이름 변경, 삭제, 취소, 진행 이벤트
- `tunnels`: 목록, 시작, 중지, 상태 이벤트
- `x11`: 환경 진단, 설정 조회, 연결 상태 이벤트
- `secrets`: 저장 가능 여부, 저장, 삭제

IPC 입력은 main process에서 다시 검증한다. renderer가 임의 경로나 임의 명령을 main process에 전달할 수 있는 범용 API를 만들지 않는다.

## 8. 데이터 저장

- 세션과 앱 설정은 Electron user data 디렉터리에 버전이 포함된 JSON으로 저장
- 비밀값은 설정 JSON에 평문으로 저장하지 않음
- 세션 데이터 예시 필드:
  - id, name, group
  - host, port, username
  - authentication type, private key path
  - X11 enabled, display override
  - saved tunnel rules
  - terminal appearance settings
- 스키마 버전을 두고 이후 마이그레이션 가능하게 구성
- 초기 버전에는 DB를 추가하지 않음

## 9. 검증 기준

### SSH

- 정상 서버에 비밀번호와 개인키로 접속 가능
- 잘못된 인증 정보를 명확히 표시
- 저장된 호스트 키가 변경되면 연결 차단
- `vim`, `top` 같은 대화형 프로그램 정상 작동
- 터미널 창 크기 변경이 원격 PTY에 반영
- 한글 입력과 출력 정상 작동

### X11

- X 서버 미실행 상태를 감지하고 해결 방법 표시
- X11 비활성 서버와 `xauth` 누락을 구분해서 표시
- 올바른 쿠키만 로컬 X 서버에 연결 가능
- SSH 터미널에서 `virt-manager` 실행 시 창이 로컬 화면에 표시
- 마우스와 키보드 입력, 창 종료 정상 작동

### SFTP

- 파일 업로드 후 원본과 원격 파일 해시 일치
- 다운로드 후 원본과 로컬 파일 해시 일치
- 폴더 재귀 전송 정상 작동
- 전송 취소 시 불완전 파일을 완료 파일로 남기지 않음
- 덮어쓰기 확인과 오류 재시도 정상 작동

### 포트포워딩

- local, remote, dynamic 세 방식 각각 실제 TCP 연결 성공
- 사용 중인 포트 지정 시 오류 표시
- 터널 중지와 SSH 연결 종료 후 포트 반환

## 10. 초기 패키징

- Windows: portable 패키지 우선
- macOS: 앱 ZIP
- Linux: AppImage
- 코드 서명과 자동 업데이트는 첫 버전에서 제외
- 각 OS는 해당 OS에서 핵심 4개를 실제 검증한 뒤 지원 완료로 표시

## 11. 후속 기능 순서

핵심 4개가 안정화된 뒤 아래 순서로 추가한다.

1. SSH config 가져오기와 jump host/ProxyJump
2. 분할 터미널, 동시 입력, 세션 로그
3. 원격 파일 편집과 중단 전송 재개
4. 명령 스니펫과 매크로
5. RDP, VNC, Serial 등 추가 프로토콜
6. 세션 내보내기/가져오기와 설정 동기화

“MobaXterm 기능 전체”는 장기 목표다. 각 기능은 별도 단계에서 범위와 완료 기준을 정한다.

## 12. 다음 AI가 바로 할 일

1. 작업 경로와 기존 파일을 확인한다. 기존 작업이 있으면 보존한다.
2. 프로젝트가 없으면 `ssh-workbench` 폴더에 최소 Electron + TypeScript + React + Vite 앱을 만든다.
3. 먼저 단계 A의 SSH 단일 세션을 세로로 관통해 구현한다.
4. 실제 SSH 서버 없이 검증 가능한 부분은 작은 테스트로 확인한다.
5. 사용자가 서버 정보를 앱에 입력하면 실제 터미널 접속을 검증한다.
6. SSH가 안정화된 뒤 X11 spike를 먼저 만들어 `virt-manager` 표시 가능 여부를 검증한다.
7. 검증 결과에 따라 SFTP와 포트포워딩을 차례로 추가한다.

## 13. 구현 원칙

- 기존 검증된 라이브러리를 사용한다.
- SSH, 터미널, X 서버를 직접 새로 구현하지 않는다.
- 필요한 기능만 추가한다. 미래용 추상화와 불필요한 의존성은 만들지 않는다.
- 증상별 우회 코드보다 공통 연결 계층에서 원인을 고친다.
- 비밀번호, 개인키 내용, 서버 주소 같은 민감 정보는 로그에 남기지 않는다.
- 기능 하나가 끝날 때마다 실행 가능한 최소 검증을 남긴다.

