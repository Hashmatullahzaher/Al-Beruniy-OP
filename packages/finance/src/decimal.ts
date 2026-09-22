const decimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

export class ExactDecimal {
  readonly coefficient: bigint;
  readonly scale: number;

  private constructor(coefficient: bigint, scale: number) {
    let normalizedCoefficient = coefficient;
    let normalizedScale = scale;
    while (normalizedScale > 0 && normalizedCoefficient % 10n === 0n) {
      normalizedCoefficient /= 10n;
      normalizedScale -= 1;
    }
    this.coefficient = normalizedCoefficient;
    this.scale = normalizedScale;
  }

  static parse(value: string): ExactDecimal {
    if (value.length > 256 || !decimalPattern.test(value)) throw new Error("Invalid exact decimal string");
    const negative = value.startsWith("-");
    const unsigned = negative ? value.slice(1) : value;
    const [whole = "0", fraction = ""] = unsigned.split(".");
    const coefficient = BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n);
    return new ExactDecimal(coefficient, fraction.length);
  }

  add(other: ExactDecimal): ExactDecimal {
    const scale = Math.max(this.scale, other.scale);
    return new ExactDecimal(this.atScale(scale) + other.atScale(scale), scale);
  }

  subtract(other: ExactDecimal): ExactDecimal {
    const scale = Math.max(this.scale, other.scale);
    return new ExactDecimal(this.atScale(scale) - other.atScale(scale), scale);
  }

  compare(other: ExactDecimal): number {
    const scale = Math.max(this.scale, other.scale);
    const left = this.atScale(scale);
    const right = other.atScale(scale);
    return left < right ? -1 : left > right ? 1 : 0;
  }

  isZero(): boolean { return this.coefficient === 0n; }
  isPositive(): boolean { return this.coefficient > 0n; }

  toString(): string {
    const negative = this.coefficient < 0n;
    const digits = (negative ? -this.coefficient : this.coefficient).toString();
    if (this.scale === 0) return `${negative ? "-" : ""}${digits}`;
    const padded = digits.padStart(this.scale + 1, "0");
    const splitAt = padded.length - this.scale;
    return `${negative ? "-" : ""}${padded.slice(0, splitAt)}.${padded.slice(splitAt)}`;
  }

  private atScale(scale: number): bigint {
    return this.coefficient * 10n ** BigInt(scale - this.scale);
  }
}
