// Minimal typing for `bun test` (the project does not install bun-types).
declare module "bun:test" {
  interface Matchers {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toContain(expected: unknown): void;
    toContainEqual(expected: unknown): void;
    toBeGreaterThan(expected: number): void;
    toBeCloseTo(expected: number, digits?: number): void;
    toBeDefined(): void;
    toBeNull(): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    not: Matchers;
  }
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function expect(actual: unknown): Matchers;
}
