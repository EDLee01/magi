export class MagiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MagiConfigError";
  }
}

export class MagiUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MagiUsageError";
  }
}
