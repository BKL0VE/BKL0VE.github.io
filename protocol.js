/* =============================================================================
 * protocol.js — WebUpdater 진입 트리거 프레임 (펌웨어 bootloader.c 와 동일)
 * -----------------------------------------------------------------------------
 * UART1 = USART1, 115200 8N1, 8바이트:
 *   [0]=0x5A [1]=0xA5 [2]=0x01(CMD) [3]=0xFE(~CMD)
 *   [4..6]=0x00 예약 [7]=CRC8(poly 0x07, init 0x00) over [0..6]
 * 앱은 유효 프레임 수신 시 0x79(ACK) 응답 후 시스템 ROM 부트로더로 점프한다.
 * ========================================================================== */
(function (global) {
  'use strict';

  const MAGIC0 = 0x5A;
  const MAGIC1 = 0xA5;
  const CMD_ENTER_BOOTLOADER = 0x01;
  const ACK = 0x79;   // AN3155 ACK
  const NACK = 0x1F;  // AN3155 NACK

  function crc8(bytes) {
    let crc = 0x00;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (let b = 0; b < 8; b++) {
        crc = (crc & 0x80) ? (((crc << 1) ^ 0x07) & 0xFF) : ((crc << 1) & 0xFF);
      }
    }
    return crc;
  }

  function buildTriggerFrame() {
    const f = new Uint8Array(8);
    f[0] = MAGIC0;
    f[1] = MAGIC1;
    f[2] = CMD_ENTER_BOOTLOADER;
    f[3] = (~CMD_ENTER_BOOTLOADER) & 0xFF;
    f[4] = 0; f[5] = 0; f[6] = 0;
    f[7] = crc8(f.subarray(0, 7));
    return f;
  }

  global.UpdaterProtocol = {
    MAGIC0: MAGIC0,
    MAGIC1: MAGIC1,
    CMD_ENTER_BOOTLOADER: CMD_ENTER_BOOTLOADER,
    ACK: ACK,
    NACK: NACK,
    crc8: crc8,
    buildTriggerFrame: buildTriggerFrame
  };
})(window);
