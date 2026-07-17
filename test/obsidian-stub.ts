export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

export function debounce<T extends (...args: any[]) => any>(fn: T): T {
  return fn;
}

export class TFile {
  path: string;

  constructor(path: string) {
    this.path = normalizePath(path);
  }

  setPath(path: string): void {
    this.path = normalizePath(path);
  }

  get name(): string {
    return this.path.split("/").pop() ?? "";
  }

  get extension(): string {
    const dot = this.name.lastIndexOf(".");
    return dot >= 0 ? this.name.slice(dot + 1) : "";
  }

  get basename(): string {
    const suffix = this.extension ? `.${this.extension}` : "";
    return suffix ? this.name.slice(0, -suffix.length) : this.name;
  }
}

export class App {}
