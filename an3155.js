/* =============================================================================
 * an3155.js — STM32 USART ROM 부트로더 프로토콜 (AN3155)
 * -----------------------------------------------------------------------------
 * 지원 명령: Get(0x00), GetVersion(0x01), GetID(0x02), ReadMemory(0x11),
 *            Go(0x21), WriteMemory(0x31), ExtendedErase(0x44: STM32F2/F4)
 * 모든 명령은 cmd + ~cmd(complement) 로 전송하며, 부트로더는 0x79(ACK)/0x1F(NACK)
 * 로 응답한다. 포트는 8E1(even parity)로 열려 있어야 한다.
 * ========================================================================== */
(function (global) {
  'use strict';

  const ACK = 0x79;
  const NACK = 0x1F;

  class An3155 {
    constructor(transport, log) {
      this.t = transport;
      this.log = log || function () {};
      this.timeout = 2500;       // 일반 응답 타임아웃 (ms)
      this.writeTimeout = 5000;  // Write/Read 청크 응답 타임아웃
    }

    async _send(bytes) { await this.t.write(bytes); }

    async _readByte(timeout, label) {
      const b = await this.t.readByte(timeout === undefined ? this.timeout : timeout);
      if (b < 0) throw new Error((label ? label + ': ' : '') + '응답 타임아웃 (부트로더 무응답)');
      return b;
    }

    async _expectAck(timeout, label) {
      const b = await this._readByte(timeout, label);
      if (b !== ACK) throw new Error((label ? label + ': ' : '') + 'ACK 기대, 수신 0x' + b.toString(16).padStart(2, '0'));
      return true;
    }

    async _expectAckOrNack(timeout, label) {
      const b = await this._readByte(timeout, label);
      if (b === ACK) return true;
      if (b === NACK) return false;
      throw new Error((label ? label + ': ' : '') + 'ACK/NACK 기대, 수신 0x' + b.toString(16).padStart(2, '0'));
    }

    _xor(bytes) { let x = 0; for (let i = 0; i < bytes.length; i++) x ^= bytes[i]; return x & 0xFF; }

    _addrBytes(address) {
      return [
        (address >>> 24) & 0xFF, (address >>> 16) & 0xFF,
        (address >>> 8) & 0xFF, address & 0xFF
      ];
    }

    /** 0x7F 전송 → 0x79 확인. 이미 부트로더면 즉시 성공.
     *  NACK(0x1F) 등 다른 바이트가 오면 로그하고 재시도한다. */
    async sync(retries) {
      retries = retries || 8;
      for (let i = 0; i < retries; i++) {
        await new Promise(function (r) { setTimeout(r, 50); });
        this.t.flushInput();          // 전송 직전에 버퍼를 비워 잔여/글리치 제거
        await this._send([0x7F]);
        const b = await this.t.readByte(400);
        if (b === ACK) return true;
        if (b >= 0) {
          this.log('sync: 0x7F에 0x' + b.toString(16).padStart(2, '0') + ' 응답 (시도 ' + (i + 1) + ')', 'warn');
        }
      }
      return false;
    }

    async get() {
      await this._send([0x00, 0xFF]);
      await this._expectAck();
      const n = await this._readByte();
      const data = await this.t.readBytes(n + 1, this.timeout);
      if (!data) throw new Error('Get 응답 부족');
      await this._expectAck();
      return { version: data[0], commands: data.slice(1) };
    }

    async getVersion() {
      await this._send([0x01, 0xFE]);
      await this._expectAck();
      const v = await this._readByte();
      await this._expectAck();
      return v;
    }

    async getId() {
      await this._send([0x02, 0xFD]);
      await this._expectAck();
      const n = await this._readByte();
      const data = await this.t.readBytes(n + 1, this.timeout);
      if (!data) throw new Error('Get ID 응답 부족');
      await this._expectAck();
      let pid = 0;
      for (let i = 0; i < data.length; i++) pid = ((pid << 8) | data[i]) >>> 0;
      return pid >>> 0;
    }

    /**
     * Extended Erase (0x44) — STM32F2/F4. sectors = 섹터 번호 배열(2바이트).
     * payload = count(2B MSB) + 페이지번호(2B×N) + checksum(1B, count 포함) 한 번에 전송 → ACK 1회.
     */
    async extendedErase(sectors) {
      if (!sectors || sectors.length === 0) throw new Error('erase 섹터 목록이 비었습니다');

      await this._send([0x44, 0xBB]);
    
      await this._expectAck(this.timeout, 'erase cmd ACK');
      this.log('erase(0x44): 명령 ACK OK', 'info');

      const count = sectors.length - 1;
      const payload = [(count >> 8) & 0xFF, count & 0xFF];
      for (let i = 0; i < sectors.length; i++) payload.push((sectors[i] >> 8) & 0xFF, sectors[i] & 0xFF);
      payload.push(this._xor(payload));   // 체크섬 = count 바이트 + 페이지 바이트 전체 XOR
      this.log('erase(0x44): 섹터 [' + sectors.join(',') + '] (count=' + sectors.length + ') 전송, erase 대기…', 'info');
      await this._send(payload);

      const ok = await this._expectAckOrNack(Math.max(20000, sectors.length * 8000), 'erase 완료 ACK');
      if (!ok) throw new Error('Erase NACK (섹터 번호/보호(RDP) 상태 확인)');
      this.log('erase(0x44): 완료', 'ok');
      return true;
    }

    /** Extended Erase — 전체 mass erase (N-1 = 0xFFFF). 페이지 목록 없음. */
    async extendedMassErase() {
      await this._send([0x44, 0xBB]);
      await this._expectAck(this.timeout, 'mass erase cmd ACK');
      this.log('mass erase: payload FF FF 00 전송, erase 대기…', 'info');
      await this._send([0xFF, 0xFF, 0x00]);   // count=0xFFFF, checksum=0x00 (페이지 목록 없음)
      const ok = await this._expectAckOrNack(60000, 'mass erase 완료 ACK');
      if (!ok) throw new Error('Mass Erase NACK');
      this.log('mass erase: 완료', 'ok');
      return true;
    }

    /**
     * Standard Erase (0x43) — 페이지 번호 1바이트. sectors = 페이지(섹터) 번호 배열.
     */
    async standardErase(sectors) {
      if (!sectors || sectors.length === 0) throw new Error('erase 섹터 목록이 비었습니다');

      await this._send([0x43, 0xBC]);
      await this._expectAck(this.timeout, 'erase cmd ACK');
      this.log('erase(0x43): 명령 ACK OK', 'info');

      const count = sectors.length - 1;
      const payload = [count & 0xFF];
      for (let i = 0; i < sectors.length; i++) payload.push(sectors[i] & 0xFF);
      payload.push(this._xor(payload));   // 체크섬 = count + 페이지 바이트 전체 XOR
      this.log('erase(0x43): 페이지 [' + sectors.join(',') + '] 전송, erase 대기…', 'info');
      await this._send(payload);

      const ok = await this._expectAckOrNack(Math.max(20000, sectors.length * 8000), 'erase 완료 ACK');
      if (!ok) throw new Error('Erase NACK');
      this.log('erase(0x43): 완료', 'ok');
      return true;
    }

    /** Write Memory (0x31).
     *  payload = (N-1)(1B) + data(N, 4의 배수로 0xFF 패딩) + checksum(1B = (N-1)⊕data 전체 XOR).
     *  ⚠️ length 의 complement 는 보내지 않는다(AN3155 write). */
    async writeMemory(address, data) {
      if (data.length === 0) return true;
      if (data.length > 256) throw new Error('write 청크는 최대 256바이트');

      const payload = Array.from(data);
      while (payload.length % 4 !== 0) payload.push(0xFF);   // flash 소거값으로 4의 배수 패딩

      await this._send([0x31, 0xCE]);
      await this._expectAck(this.timeout, 'write cmd ACK');

      const addr = this._addrBytes(address);
      await this._send(addr.concat([this._xor(addr)]));
      await this._expectAck(this.timeout, 'write addr ACK');

      const count = payload.length - 1;
      const body = [count & 0xFF].concat(payload);
      body.push(this._xor(body));   // (N-1) ⊕ 데이터 전체 XOR
      await this._send(body);
      const ok = await this._expectAckOrNack(this.writeTimeout, 'write data ACK');
      if (!ok) throw new Error('Write NACK');
      return true;
    }

    /** Read Memory (0x11). len 바이트(최대 256) 읽어 Uint8Array 반환. */
    async readMemory(address, len) {
      if (len > 256) throw new Error('read 청크는 최대 256바이트');

      await this._send([0x11, 0xEE]);
      await this._expectAck();

      const addr = this._addrBytes(address);
      await this._send(addr.concat([this._xor(addr)]));
      await this._expectAck();

      const n = len - 1;
      await this._send([n & 0xFF, (~n) & 0xFF]);
      await this._expectAck();

      const data = await this.t.readBytes(len, this.timeout);
      if (!data) throw new Error('Read 응답 부족');
      // ⚠️ Read Memory(0x11)는 데이터 뒤에 ACK를 보내지 않는다 (AN3155)
      return new Uint8Array(data);
    }

    /** Go (0x21). 점프 후에는 응답이 없다. */
    async go(address) {
      await this._send([0x21, 0xDE]);
      await this._expectAck();
      const addr = this._addrBytes(address);
      await this._send(addr.concat([this._xor(addr)]));
      await this._expectAck(1500);
    }
  }

  global.An3155 = An3155;
})(window);
