# BKL0VE.github.io

# WebUpdater — UART1 브라우저 펌웨어 업데이트

STM32 시스템 ROM 부트로더(AN3155)를 이용해, 브라우저(WebSerial)에서 `erase → write → verify → Go`
를 자동 수행하는 정적 웹페이지입니다. PC는 보드의 **UART1(PA9/PA10) 업데이트 전용 포트**에
USB2Serial(CH340 등)로 연결합니다.

## 사용

1. 펌웨어 빌드 시 `make all` 이 `build/Gimbal_1Aixs_F405RG.hex` 를 **`WebUpdater/AC-GM1X_FW_ver_Final.hex` 로 자동 복사**합니다.
2. 로컬 서버로 열기 (WebSerial은 보안 컨텍스트 필요)
   ```powershell
   cd WebUpdater
   python -m http.server 8000
   ```
3. Chrome/Edge에서 `http://localhost:8000/` 접속 — 페이지가 **내장 `AC-GM1X_FW_ver_Final.hex` 를 자동 로드**합니다(별도 파일 선택 불필요).
4. **[업데이트 시작]** 클릭 → 모드 감지 → erase → write → verify → Go 자동 진행
   - 다른 펌웨어를 쓰려면 파일 영역을 클릭해 로컬 `.hex` 를 선택하세요(선택하면 내장 대신 사용).
   - `fetch` 로 `AC-GM1X_FW_ver_Final.hex` 를 읽으므로 **`file://` 이 아니라 로컬 서버(http)로 열어야** 합니다.

## 파일

| 파일 | 역할 |
|------|------|
| `index.html` / `styles.css` | UI ([업데이트 시작] 버튼 + 파일 영역, 진행률, 로그) |
| `AC-GM1X_FW_ver_Final.hex` | **내장 펌웨어** — 빌드(`make all`) 시 자동 복사되며 페이지가 자동 로드 |
| `ihex.js` | Intel HEX 파서 (type 00/01/02/03/04/05) |
| `protocol.js` | 진입 트리거 프레임 + CRC8 (펌웨어 `bootloader.c` 와 동일) |
| `serial.js` | WebSerial 전송 계층 (읽기 버퍼/타임아웃/패리티 전환) |
| `an3155.js` | AN3155 명령 (Get/GetID/ExtendedErase/Write/Read/Go) |
| `updater.js` | 오케스트레이션 (모드 감지 → erase → write → verify → Go) |

## 상황별 자동 판별

- **앱 실행 중**: 8N1로 트리거 전송 → 앱 ACK → ROM 부트로더 점프 → 8E1 재오픈
- **이미 부트모드**: 8E1에서 `0x7F` probe 성공 → 즉시 진행

전체 프로토콜/주의사항은 상위 `README.md` §3.7 참조.

> ⚠️ BOOT0 복구 경로가 없습니다. 업데이트 도중 전원/통신이 끊기면 J-Link(SWD)로만 복구됩니다.

## AN3155 명령 포맷 (STM32F405 / 부트로더 v0x31 에서 검증됨)

포트는 **115200 8E1(even parity)**. 모든 명령은 `cmd + ~cmd`, 응답 `0x79`(ACK)/`0x1F`(NACK).

| 명령 | 전송 | 비고 |
|------|------|------|
| Sync | `0x7F` → `0x79` | autobaud |
| GetID | `0x02 0xFD` → ACK, `N`, PID(2B), ACK | F405 = `0x0413` |
| **Extended Erase** `0x44` | `0x44 0xBB` → ACK, 그다음 **한 번에**: `count(2B MSB,=N-1)` + `페이지번호(2B×N, MSB)` + `checksum(1B)` → ACK | **checksum = count바이트 ⊕ 페이지바이트 전체 XOR. complement 없음.** mass erase = `FF FF 00`. 소요 10초+ 가능 |
| **Write Memory** `0x31` | `0x31 0xCE` → ACK, `addr(4B MSB)+checksum(XOR)` → ACK, `(N-1)(1B)` + `data(N, 4의 배수로 0xFF 패딩)` + `checksum(1B = (N-1)⊕data)` → ACK | **length complement 없음** |
| **Read Memory** `0x11` | `0x11 0xEE` → ACK, `addr+checksum` → ACK, `(len-1)(1B)+~(len-1)(1B)` → ACK, 이후 `len` 바이트 데이터 | **데이터 뒤 ACK 없음** |
| Go `0x21` | `0x21 0xDE` → ACK, `addr(4B)+checksum` → ACK | 이후 앱 실행 |

> 3가지 함정(모두 초기 구현에서 타임아웃/NACK 유발): ① Erase에 complement를 넣고 체크섬에서 count를 뺌 ② Write에 length complement를 넣음 ③ Read 뒤 trailing ACK를 기다림.

