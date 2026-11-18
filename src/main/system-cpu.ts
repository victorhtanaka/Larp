import { cpus, type CpuInfo } from 'node:os';

/** Samples aggregate CPU time between calls; unavailable or invalid samples reset the baseline. */
export function createSystemCpuUsageSampler(readCpus: () => CpuInfo[] = cpus): () => number | null {
  let previous: number[][] | null = null;

  return () => {
    try {
      const current = readCpus().map(({ times }) => [times.user, times.nice, times.sys, times.idle, times.irq]);
      if (current.length === 0 || current.some((times) => times.some((value) => !Number.isFinite(value) || value < 0))) {
        previous = null;
        return null;
      }
      const baseline = previous;
      previous = current;
      if (!baseline || baseline.length !== current.length) return null;

      let total = 0;
      let idle = 0;
      for (let cpu = 0; cpu < current.length; cpu += 1) {
        for (let field = 0; field < current[cpu].length; field += 1) {
          const delta = current[cpu][field] - baseline[cpu][field];
          if (delta < 0) return null;
          total += delta;
          if (field === 3) idle += delta;
        }
      }
      if (!Number.isFinite(total) || total <= 0) return null;
      return Math.max(0, Math.min(100, (1 - idle / total) * 100));
    } catch {
      previous = null;
      return null;
    }
  };
}
