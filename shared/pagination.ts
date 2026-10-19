function boundedInteger(value: string | undefined, fallback: number, maximum: number) {
  const number = Number(value);
  return Number.isFinite(number) && number !== 0
    ? Math.max(1, Math.min(maximum, Math.floor(number)))
    : fallback;
}

export function paginationParams(query: { page?: string; limit?: string }, defaultLimit = 100) {
  const page = boundedInteger(query.page, 1, 100000);
  const limit = boundedInteger(query.limit, defaultLimit, 100);
  return { page, limit, offset: (page - 1) * limit };
}

export interface PaginatedResult<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
}
