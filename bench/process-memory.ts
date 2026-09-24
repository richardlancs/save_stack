/// <reference types="node" />
// Memory of the test browser, read from the operating system: the working set of every process started with this profile.
// Reported in the benchmark output (prompt section 9 asks for it to be reported, not budgeted).
import { execFileSync } from 'node:child_process';

export interface ProfileMemory {
  processes: number;
  totalMB: number;
  /** Renderer processes, largest first: the extension's offscreen document (which holds the database Worker) is one of them. */
  renderersMB: number[];
}

const mb = (bytes: number): number => Math.round(bytes / 1048576);

export function profileMemory(profileDir: string): ProfileMemory | undefined {
  try {
    const rows: Array<{ bytes: number; renderer: boolean }> = [];
    if (process.platform === 'win32') {
      const dir = profileDir.toLowerCase().replace(/'/g, "''");
      const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${dir}') } | ForEach-Object { "$($_.WorkingSetSize)|$($_.CommandLine.Contains('--type=renderer'))" }`;
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20_000 });
      for (const line of out.split(/\r?\n/)) {
        const [b, r] = line.trim().split('|');
        if (b && /^\d+$/.test(b)) rows.push({ bytes: Number(b), renderer: r === 'True' });
      }
    } else {
      const out = execFileSync('ps', ['-eo', 'rss=,args='], { encoding: 'utf8', timeout: 20_000 });
      for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (m && m[2]!.includes(profileDir)) rows.push({ bytes: Number(m[1]) * 1024, renderer: m[2]!.includes('--type=renderer') });
      }
    }
    if (rows.length === 0) return undefined;
    return { processes: rows.length, totalMB: mb(rows.reduce((n, r) => n + r.bytes, 0)), renderersMB: rows.filter((r) => r.renderer).map((r) => mb(r.bytes)).sort((a, b) => b - a) };
  } catch {
    return undefined; // a missing tool must never fail the benchmark
  }
}
