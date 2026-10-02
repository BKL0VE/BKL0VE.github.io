/* =============================================================================
 * ihex.js — Intel HEX 파서
 * -----------------------------------------------------------------------------
 * 텍스트를 파싱해 { base, end, bytes, entry } 를 반환한다.
 *   base  : 최소 주소 (예: 0x08000000)
 *   end   : 최대 주소 + 1 (exclusive)
 *   bytes : base..end 구간의 Uint8Array (빈 구간은 0xFF = 지워진 flash 값)
 *   entry : Start Linear Address(05) 레코드 값 또는 null
 * 지원 레코드: 00 Data, 01 EOF, 02 Ext Segment Addr, 03 Start Seg Addr,
 *              04 Ext Linear Addr, 05 Start Linear Addr
 * ========================================================================== */
(function (global) {
  'use strict';

  function parseIntelHex(text) {
    const mem = new Map();
    let extBase = 0;
    let entry = null;
    let minAddr = Infinity;
    let maxAddr = -Infinity;

    const lines = text.split(/\r?\n/);
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li].trim();
      if (line.length === 0) continue;
      if (line[0] !== ':') {
        throw new Error('HEX 형식 오류(' + (li + 1) + '행): \':\'로 시작하지 않습니다');
      }

      const hex = line.slice(1);
      if (hex.length % 2 !== 0) {
        throw new Error('HEX 형식 오류(' + (li + 1) + '행): 홀수 자릿수');
      }
      const rec = new Uint8Array(hex.length / 2);
      for (let i = 0; i < rec.length; i++) {
        const v = parseInt(hex.substr(i * 2, 2), 16);
        if (Number.isNaN(v)) {
          throw new Error('HEX 형식 오류(' + (li + 1) + '행): 16진수 아님');
        }
        rec[i] = v;
      }

      // 체크섬: 모든 바이트 합의 하위 8비트 = 0
      let sum = 0;
      for (let i = 0; i < rec.length; i++) sum = (sum + rec[i]) & 0xFF;
      if (sum !== 0) {
        throw new Error('HEX 체크섬 오류(' + (li + 1) + '행)');
      }

      const len = rec[0];
      const addr = (rec[1] << 8) | rec[2];
      const type = rec[3];
      if (rec.length !== 4 + len + 1) {
        throw new Error('HEX 길이 불일치(' + (li + 1) + '행)');
      }
      const data = rec.subarray(4, 4 + len);

      switch (type) {
        case 0x00: {
          const abs = extBase + addr;
          for (let i = 0; i < len; i++) {
            const a = abs + i;
            mem.set(a, data[i]);
            if (a < minAddr) minAddr = a;
            if (a > maxAddr) maxAddr = a;
          }
          break;
        }
        case 0x01: // EOF
          li = lines.length;
          break;
        case 0x02:
          extBase = (((data[0] << 8) | data[1]) << 4) >>> 0;
          break;
        case 0x03: // Start Segment Address (CS:IP) — 미사용
          break;
        case 0x04:
          extBase = (((data[0] << 8) | data[1]) << 16) >>> 0;
          break;
        case 0x05:
          entry = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
          break;
        default:
          break; // 알 수 없는 레코드는 무시
      }
    }

    if (!isFinite(minAddr)) {
      throw new Error('HEX에 데이터 레코드가 없습니다');
    }

    const base = minAddr >>> 0;
    const end = (maxAddr + 1) >>> 0;
    const bytes = new Uint8Array(end - base).fill(0xFF);
    mem.forEach(function (v, a) { bytes[a - base] = v; });

    return { base: base, end: end, bytes: bytes, entry: entry };
  }

  global.parseIntelHex = parseIntelHex;
})(window);
