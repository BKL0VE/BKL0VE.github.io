/* =============================================================================
 * updater.js — WebUpdater 오케스트레이션
 * -----------------------------------------------------------------------------
 * [업데이트 시작] 버튼 하나로:
 *   1) HEX 파싱 → 필요 섹터 산출
 *   2) 보드 상태 자동 감지
 *        - 8E1에서 0x7F probe 성공  → 이미 ROM 부트모드
 *        - 실패 → 8N1로 트리거 전송 → 앱이 ACK 후 ROM 부트모드 진입 → 8E1 재오픈
 *   3) erase → write → verify → Go(실행)  순서로 자동 진행
 * ========================================================================== */
(function () {
  'use strict';

  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  const FLASH_BASE = 0x08000000;
  const FLASH_END  = 0x08100000;   // 1MB
  const CHUNK      = 256;
  const FW_NAME    = 'AC-GM1X_FW_ver_Final.hex';   // WebUpdater 폴더에 함께 배포되는 내장된 최신 펌웨어 파일명

  /* STM32F405RG (1MB) 섹터 레이아웃 */
  const SECTORS = [
    { n: 0,  addr: 0x08000000, size: 0x04000 },
    { n: 1,  addr: 0x08004000, size: 0x04000 },
    { n: 2,  addr: 0x08008000, size: 0x04000 },
    { n: 3,  addr: 0x0800C000, size: 0x04000 },
    { n: 4,  addr: 0x08010000, size: 0x10000 },
    { n: 5,  addr: 0x08020000, size: 0x20000 },
    { n: 6,  addr: 0x08040000, size: 0x20000 },
    { n: 7,  addr: 0x08060000, size: 0x20000 },
    { n: 8,  addr: 0x08080000, size: 0x20000 },
    { n: 9,  addr: 0x080A0000, size: 0x20000 },
    { n: 10, addr: 0x080C0000, size: 0x20000 },
    { n: 11, addr: 0x080E0000, size: 0x20000 }
  ];

  function hex(n, w) {
    return (n >>> 0).toString(16).toUpperCase().padStart(w || 2, '0');
  }

  function sectorsCovering(base, endExclusive) {
    const out = [];
    for (let i = 0; i < SECTORS.length; i++) {
      const s = SECTORS[i];
      if (base < s.addr + s.size && endExclusive > s.addr) out.push(s.n);
    }
    return out;
  }

  /* ------------------------------- UI 참조 ------------------------------- */
  const $ = function (id) { return document.getElementById(id); };
  const els = {
    fw: $('fw'), fileName: $('fileName'), connect: $('connect'),
    bar: $('barFill'), status: $('status'), pct: $('pct'),
    log: $('log'), logWrap: document.querySelector('.log-wrap'), badge: $('badge')
  };

  let busy = false;
  let bundled = null;   // { name, text } — WebUpdater 폴더에 함께 배포되는 내장된 최신 펌웨어

  function bundledNameText() {
    return '최신: ' + FW_NAME + ' (' + Math.round(bundled.text.length / 1024) + ' KB) 펌웨어 선택됨· or 클릭하여 다른 파일 선택';
  }

  /* 페이지 로드 시 WebUpdater/AC-GM1X_FW_ver_Final.hex 를 자동으로 가져온다(로컬 선택 불필요).
     ?v=<timestamp> 로 GitHub Pages CDN 캐시를 우회한다(방금 빌드한 펌웨어가 바로 반영되도록). */
  async function loadBundledFirmware() {
    try {
      const res = await fetch(FW_NAME + '?v=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      bundled = { name: FW_NAME + ' (최신)', text: text };
      if (!els.fw.files[0]) {
        els.fileName.textContent = bundledNameText();
        els.fw.closest('label').classList.add('has-file');
      }
      log('최신 펌웨어 로드됨: ' + FW_NAME + ' (' + Math.round(text.length / 1024) + ' KB)', 'info');
    } catch (e) {
      bundled = null;
      log('최신 ' + FW_NAME + ' 로드 실패: ' + (e && e.message ? e.message : e) +
          ' — 로컬에서 .hex를 선택하세요', 'warn');
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }
  function log(msg, cls) {
    const t = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    const line = document.createElement('div');
    line.innerHTML = '<span class="t">[' + t + ']</span> <span class="' + (cls || '') + '">' + escapeHtml(msg) + '</span>';
    els.log.appendChild(line);
    if (els.logWrap) els.logWrap.scrollTop = els.logWrap.scrollHeight;
  }
  function setStatus(s) { els.status.textContent = s; }
  function setProgress(p) { p = Math.max(0, Math.min(100, p)); els.bar.style.width = p + '%'; els.pct.textContent = Math.round(p) + '%'; }
  function setBadge(text, cls) { els.badge.textContent = text; els.badge.className = 'badge ' + (cls || 'idle'); }

  els.fw.addEventListener('change', function () {
    const f = els.fw.files[0];
    const label = els.fw.closest('label');
    if (f) {
      els.fileName.textContent = f.name;
      if (label) label.classList.add('has-file');
    } else if (bundled) {
      els.fileName.textContent = bundledNameText();
      if (label) label.classList.add('has-file');
    } else {
      els.fileName.textContent = '펌웨어 .hex 파일 선택';
      if (label) label.classList.remove('has-file');
    }
  });

  /* ---------------------------- 보드 상태 감지 ---------------------------- */
  function openEven(t) {
    return t.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'even', flowControl: 'none', bufferSize: 4096 });
  }
  function openNone(t) {
    return t.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 4096 });
  }

  /* 0x7F sync 가 NACK 등으로 실패해도, 이미 동기화된 부트로더일 수 있으므로 GetID(0x02)로 확인 */
  async function tryAlreadySynced(an) {
    try {
      const pid = await an.getId();
      if (pid) { log('GetID 응답 OK (PID=0x' + hex(pid, 4) + ') → 이미 동기화된 부트로더', 'ok'); return true; }
    } catch (e) { /* noop */ }
    return false;
  }

  /* 부트로더 확보: (1) 이미 부트모드면 sync/GetID, (2) 앱 실행 중이면 트리거 후 sync/GetID */
  async function enterBootloader(t) {
    // (a) 이미 부트모드인가?
    log('보드 상태 확인 · 8E1에서 부트로더 probe (0x7F)', 'info');
    await openEven(t);
    let an = new An3155(t, log);
    if (await an.sync(3)) { log('이미 ROM 부트모드입니다 → 바로 진행', 'ok'); return an; }
    if (await tryAlreadySynced(an)) { log('이미 ROM 부트모드(동기화됨) → 바로 진행', 'ok'); return an; }
    await t.close();
    await sleep(200);

    // (b) 앱 실행 중 → 트리거 전송 (8N1)
    log('앱 실행 중으로 판단 · 트리거 전송 (8N1)', 'info');
    await openNone(t);
    t.flushInput();
    await t.write(UpdaterProtocol.buildTriggerFrame());
    const ack = await t.readByte(3000);
    if (ack !== UpdaterProtocol.ACK) {
      await t.close();
      throw new Error('트리거 ACK 없음 — 보드 전원/포트(UART1 전용)/점유 여부 확인');
    }
    log('앱 ACK 수신 → ROM 부트로더로 점프', 'ok');
    await t.close();
    await sleep(800);

    // (c) 8E1 재오픈 + sync (NACK 지속 시 GetID 폴백)
    await openEven(t);
    an = new An3155(t, log);
    if (await an.sync(10)) { log('ROM 부트로더 sync OK', 'ok'); return an; }
    if (await tryAlreadySynced(an)) { log('ROM 부트로더 동기화 확인 OK', 'ok'); return an; }
    throw new Error('ROM 부트로더 sync 실패 (0x7F → 0x79). 전원을 껐다 켠 뒤 다시 [업데이트 시작] 하세요');
  }

  /* ------------------------------- write -------------------------------- */
  async function writeImage(an, img) {
    const bytes = img.bytes;
    const total = bytes.length;
    for (let off = 0; off < total; off += CHUNK) {
      const slice = bytes.subarray(off, Math.min(off + CHUNK, total));
      const arr = Array.from(slice);
      while (arr.length % 4 !== 0) arr.push(0xFF);
      await an.writeMemory(img.base + off, arr);
      setProgress(33 + 37 * ((off + slice.length) / total));
      if ((off % (CHUNK * 16)) === 0) {
        log('write 0x' + hex(img.base + off, 8) + ' (' + Math.round((off + slice.length) / total * 100) + '%)');
      }
    }
    log('Write 완료 (' + total + ' bytes)', 'ok');
  }

  /* ------------------------------ verify -------------------------------- */
  async function verifyImage(an, img) {
    const bytes = img.bytes;
    const total = bytes.length;
    for (let off = 0; off < total; off += CHUNK) {
      const slice = bytes.subarray(off, Math.min(off + CHUNK, total));
      let len = slice.length;
      while (len % 4 !== 0) len++;
      const rd = await an.readMemory(img.base + off, len);
      for (let i = 0; i < slice.length; i++) {
        if (rd[i] !== slice[i]) {
          throw new Error('Verify 불일치 @0x' + hex(img.base + off + i, 8) +
            ' (기대 0x' + hex(slice[i], 2) + ', 실제 0x' + hex(rd[i], 2) + ')');
        }
      }
      for (let i = slice.length; i < len; i++) {
        if (rd[i] !== 0xFF) {
          throw new Error('Verify 패딩 불일치 @0x' + hex(img.base + off + i, 8));
        }
      }
      setProgress(70 + 22 * ((off + slice.length) / total));
    }
    log('Verify 완료 (읽기 대조 일치)', 'ok');
  }

  function validateImage(img) {
    if (img.base < FLASH_BASE || img.end > FLASH_END) {
      throw new Error('주소 범위 초과: 0x' + hex(img.base, 8) + ' ~ 0x' + hex(img.end, 8));
    }
    if (img.base !== FLASH_BASE) {
      log('주의: 이미지 base가 0x08000000이 아닙니다 (0x' + hex(img.base, 8) + ')', 'warn');
    }
    if (img.bytes.length < 64) {
      throw new Error('이미지가 너무 작습니다 (' + img.bytes.length + ' bytes)');
    }
  }

  /* ------------------------------ main flow ----------------------------- */
  async function run() {
    if (busy) return;

    // 로컬 선택 파일이 있으면 그것을, 없으면 내장된 최신 AC-GM1X_FW_ver_Final.hex 를 사용
    const localFile = els.fw.files[0];
    const hexText = localFile ? await localFile.text() : (bundled ? bundled.text : null);
    const srcName = localFile ? localFile.name : (bundled ? bundled.name : null);
    if (!hexText) {
      setStatus('펌웨어가 없습니다 (.hex 선택 필요)');
      log('펌웨어가 없습니다: 최신 ' + FW_NAME + ' 로드 실패이거나 선택된 파일이 없습니다', 'err');
      return;
    }
    if (!('serial' in navigator)) {
      setStatus('WebSerial 미지원 브라우저');
      log('Chrome 또는 Edge에서 실행하세요 (WebSerial 필요)', 'err');
      return;
    }

    busy = true;
    els.connect.disabled = true;
    els.bar.classList.remove('done', 'fail');
    els.log.innerHTML = '';
    setProgress(0);
    setBadge('작업 중', 'work');
    setStatus('시작…');

    let transport = null;

    try {
      // 1) HEX 파싱
      setStatus('.hex 파싱 중…');
      log('펌웨어: ' + srcName, 'info');
      const img = parseIntelHex(hexText);
      validateImage(img);
      const sectors = sectorsCovering(img.base, img.end);
      log('HEX: base=0x' + hex(img.base, 8) + ' size=' + img.bytes.length + 'B' +
          (img.entry ? (' entry=0x' + hex(img.entry, 8)) : ''), 'info');
      log('지울 섹터: [' + sectors.join(', ') + ']', 'info');
      setProgress(4);

      // 2) 포트 열기 (사용자 제스처 필요)
      const port = await navigator.serial.requestPort();
      transport = new SerialTransport(port);

      // 3) 보드 상태 감지 → 부트모드 진입 (An3155 인스턴스 반환)
      setStatus('보드 상태 확인 중…');
      const an = await enterBootloader(transport);
      setProgress(12);

      // 4) 칩 ID 확인
      setStatus('칩 ID 확인 중…');
      const pid = await an.getId();
      log('PID = 0x' + hex(pid, 4) + (pid === 0x0413 ? '  (STM32F405 OK)' : '  (F405 아님 주의)'),
          pid === 0x0413 ? 'ok' : 'warn');

      let supportsExt = true;
      try {
        const info = await an.get();
        log('Bootloader v0x' + hex(info.version, 2) + ' · 지원 명령: [' +
            info.commands.map(function (c) { return '0x' + hex(c, 2); }).join(' ') + ']', 'info');
        supportsExt = info.commands.indexOf(0x44) >= 0;
      } catch (e) {
        log('Get(0x00) 조회 실패: ' + e.message + ' → Extended Erase(0x44) 가정', 'warn');
      }
      setProgress(18);

      // 5) erase: 섹터 단위(0x44) → 실패 시 mass erase(0xFFFF) → 실패 시 standard(0x43)
      setStatus('Erase 중…');
      let erased = false;

      if (supportsExt) {
        log('Extended Erase(0x44, 섹터 ' + sectors.join(',') + ') 시작', 'info');
        try { await an.extendedErase(sectors); erased = true; }
        catch (e) { log('섹터 erase 실패: ' + e.message, 'warn'); await sleep(300); }

        if (!erased) {
          log('Mass Erase(0x44, 0xFFFF) 재시도', 'warn');
          try { await an.extendedMassErase(); erased = true; }
          catch (e) { log('Mass erase 실패: ' + e.message, 'warn'); await sleep(300); }
        }
      }

      if (!erased) {
        log('Standard Erase(0x43) 시도', 'warn');
        await an.standardErase(sectors);
      }
      log('Erase 완료', 'ok');
      setProgress(33);

      // 6) write
      setStatus('Write 중…');
      await writeImage(an, img);

      // 7) verify
      setStatus('Verify 중…');
      log('Verifying… (플래시 읽기 대조)', 'info');
      await verifyImage(an, img);

      log('*** 펌웨어 업데이트 완료 ***', 'ok');

      // 8) 실행 (Go) → 애플리케이션 재시작
      setStatus('실행(Go)…');
      await an.go(img.base);
      log('Go 0x' + hex(img.base, 8) + ' → 애플리케이션 재시작', 'ok');
      setProgress(100);

      await transport.close();
      transport = null;

      els.bar.classList.add('done');
      setStatus('업데이트 완료');
      setBadge('완료', 'ok');
    } catch (e) {
      if (transport) { try { await transport.close(); } catch (_) { /* noop */ } }
      els.bar.classList.add('fail');
      setStatus('실패: ' + (e && e.message ? e.message : String(e)));
      setBadge('실패', 'fail');
      log('오류: ' + (e && e.message ? e.message : String(e)), 'err');
      log('※ 실패 시 보드가 부트모드로 남아 있을 수 있습니다. 전원을 껐다 켠 뒤 다시 [업데이트 시작] 하세요.', 'warn');
    } finally {
      busy = false;
      els.connect.disabled = false;
    }
  }

  els.connect.addEventListener('click', run);

  // 페이지 로드 시 내장된 최신 펌웨어(AC-GM1X_FW_ver_Final.hex) 자동 로드
  loadBundledFirmware();
})();
