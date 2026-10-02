/* =============================================================================
 * serial.js — WebSerial 전송 계층 (읽기 버퍼 + 타임아웃 + 패리티 전환 지원)
 * -----------------------------------------------------------------------------
 * WebSerial은 open() 시점에만 패리티를 지정할 수 있으므로, 앱(8N1) ↔ ROM
 * 부트로더(8E1) 전환은 close() 후 open() 을 다시 호출한다.
 * ========================================================================== */
(function (global) {
  'use strict';

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  class SerialTransport {
    constructor(port) {
      this.port = port;
      this.reader = null;
      this.writer = null;
      this.buf = [];
      this._reading = false;
      this._loopPromise = null;
    }

    /** options: {baudRate, dataBits, stopBits, parity, flowControl, bufferSize} */
    async open(options) {
      await this.port.open(options);
      this.writer = this.port.writable.getWriter();
      this.reader = this.port.readable.getReader();
      this.buf = [];
      this._reading = true;
      this._loopPromise = this._readLoop();
    }

    async _readLoop() {
      try {
        while (this._reading) {
          const res = await this.reader.read();
          if (res.done) break;
          const chunk = res.value;
          if (chunk && chunk.length) {
            for (let i = 0; i < chunk.length; i++) this.buf.push(chunk[i]);
          }
        }
      } catch (e) {
        /* close/cancel 시 정상적으로 throw 될 수 있음 */
      }
    }

    async close() {
      this._reading = false;
      try { if (this.reader) { await this.reader.cancel(); } } catch (e) { /* noop */ }
      try { if (this.reader) { this.reader.releaseLock(); } } catch (e) { /* noop */ }
      try { if (this.writer) { this.writer.releaseLock(); } } catch (e) { /* noop */ }
      this.reader = null;
      this.writer = null;
      if (this._loopPromise) { try { await this._loopPromise; } catch (e) { /* noop */ } this._loopPromise = null; }
      try { await this.port.close(); } catch (e) { /* noop */ }
    }

    async write(bytes) {
      await this.writer.write(new Uint8Array(bytes));
    }

    /** n 바이트가 버퍼에 모일 때까지 최대 timeoutMs 대기 */
    _waitFor(n, timeoutMs) {
      const self = this;
      const deadline = performance.now() + timeoutMs;
      return new Promise(function (resolve) {
        (function check() {
          if (self.buf.length >= n) return resolve(true);
          if (performance.now() > deadline) return resolve(false);
          setTimeout(check, 2);
        })();
      });
    }

    async readByte(timeoutMs) {
      const ok = await this._waitFor(1, timeoutMs);
      if (!ok && this.buf.length === 0) return -1;
      return this.buf.length ? this.buf.shift() : -1;
    }

    async readBytes(n, timeoutMs) {
      const ok = await this._waitFor(n, timeoutMs);
      if (this.buf.length < n) return null;
      return this.buf.splice(0, n);
    }

    flushInput() {
      this.buf = [];
    }
  }

  global.SerialTransport = SerialTransport;
  global.__sleep = sleep;
})(window);
