export interface QueryResultLike {
  readonly rows: Record<string, unknown>[];
  readonly rowCount: number | null;
}

/** The only database capability repositories and domain services depend on: run a parameterised statement. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<QueryResultLike>;
}
