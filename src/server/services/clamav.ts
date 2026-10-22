// Virenscan über clamd (INSTREAM-Protokoll, TCP).
import { connect } from 'node:net';

export interface ScanResult { clean: boolean; signature?: string }

export class ClamAv {
  private host: string;
  private port: number;
  private timeoutMs: number;

  constructor(host: string, port: number, timeoutMs = 30000) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
  }

  scan(data: Buffer): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const sock = connect({ host: this.host, port: this.port });
      let reply = '';
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('Virenscanner antwortet nicht')); }, this.timeoutMs);
      sock.on('error', (err) => { clearTimeout(timer); reject(err); });
      sock.on('data', (d) => { reply += d.toString('utf8'); });
      sock.on('end', () => {
        clearTimeout(timer);
        const text = reply.replace(/\0/g, '').trim();
        if (/: OK$/.test(text)) resolve({ clean: true });
        else if (/FOUND$/.test(text)) resolve({ clean: false, signature: text.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, '') });
        else reject(new Error(`Unerwartete Antwort vom Virenscanner: ${text.slice(0, 200)}`));
      });
      sock.on('connect', () => {
        sock.write('zINSTREAM\0');
        const chunk = 64 * 1024;
        for (let i = 0; i < data.length; i += chunk) {
          const part = data.subarray(i, i + chunk);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length);
          sock.write(len);
          sock.write(part);
        }
        sock.write(Buffer.alloc(4));
      });
    });
  }

  ping(): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = connect({ host: this.host, port: this.port });
      let reply = '';
      const timer = setTimeout(() => { sock.destroy(); resolve(false); }, 3000);
      sock.on('error', () => { clearTimeout(timer); resolve(false); });
      sock.on('data', (d) => { reply += d.toString(); });
      sock.on('end', () => { clearTimeout(timer); resolve(reply.includes('PONG')); });
      sock.on('connect', () => sock.write('zPING\0'));
    });
  }
}
