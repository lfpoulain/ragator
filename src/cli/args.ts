/** Lecture minimale des options `--nom valeur` et `--drapeau`. */
export class Args {
  constructor(private readonly argv: string[]) {}

  has(flag: string): boolean {
    return this.argv.includes(flag);
  }

  value(flag: string): string | undefined {
    const index = this.argv.indexOf(flag);
    return index === -1 ? undefined : this.argv[index + 1];
  }

  int(flag: string): number | undefined {
    const raw = this.value(flag);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} attend un entier positif (reçu « ${raw} »)`);
    return value;
  }

  /** Arguments positionnels (hors options et leurs valeurs). */
  positional(valueFlags: string[] = []): string[] {
    const result: string[] = [];
    for (let i = 0; i < this.argv.length; i++) {
      const arg = this.argv[i]!;
      if (valueFlags.includes(arg)) i += 1;
      else if (!arg.startsWith('--')) result.push(arg);
    }
    return result;
  }
}
