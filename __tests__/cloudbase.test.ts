import {
  CLOUDBASE_QUERY_LIMIT,
  PHOTO_DEFAULT_LIMIT,
  applyRandomStrideOrder,
  escapeRegExp,
  getLimitAndOffsetFromOptions,
  getOrderByFromOptions,
  getRandomStride,
} from '@/db';

describe('CloudBase document database', () => {
  it('builds multi-field ordering clauses', () => {
    expect(getOrderByFromOptions({ sortBy: 'takenAt' }))
      .toEqual([['takenAt', 'desc']]);
    expect(getOrderByFromOptions({ sortBy: 'takenAtAsc' }))
      .toEqual([['takenAt', 'asc']]);
    expect(getOrderByFromOptions({ sortBy: 'createdAt' }))
      .toEqual([['createdAt', 'desc']]);
    expect(getOrderByFromOptions({ sortBy: 'color' }))
      .toEqual([['colorSort', 'desc'], ['takenAt', 'desc']]);
    expect(getOrderByFromOptions({ sortBy: 'color', sortWithPriority: true }))
      .toEqual([
        ['priorityOrderSort', 'asc'],
        ['colorSort', 'desc'],
        ['takenAt', 'desc'],
      ]);
  });

  it('orders random photo queries with a stable recency stride', () => {
    // Mirrors the previous SQL stride of `2 * limit`
    expect(getRandomStride(3)).toBe(6);
    expect(getRandomStride(6)).toBe(12);
    // A zero/absent limit still yields a usable stride
    expect(getRandomStride(0)).toBe(2);

    // Input is expected to already be ordered `taken_at DESC, id`.
    // With stride 6, indices map to buckets [0,1,2,3,4,5,0], so the newest
    // photo of each bucket group comes first
    const photos = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(applyRandomStrideOrder(photos, 3))
      .toEqual(['a', 'g', 'b', 'c', 'd', 'e', 'f']);
  });

  it('clamps paging to the CloudBase per-query document limit', () => {
    expect(getLimitAndOffsetFromOptions({})).toEqual({
      limit: PHOTO_DEFAULT_LIMIT,
      offset: 0,
    });
    expect(getLimitAndOffsetFromOptions({ limit: 5, offset: 10 }))
      .toEqual({ limit: 5, offset: 10 });
    // A single request can never exceed 1000 documents
    expect(getLimitAndOffsetFromOptions({ limit: 5000 }))
      .toEqual({ limit: CLOUDBASE_QUERY_LIMIT, offset: 0 });
    expect(getLimitAndOffsetFromOptions({ limit: -1 }))
      .toEqual({ limit: 0, offset: 0 });
  });

  it('escapes user input before it reaches the search regex', () => {
    expect(escapeRegExp('c++.')).toBe('c\\+\\+\\.');
    expect(escapeRegExp('a.*b')).toBe('a\\.\\*b');
    expect(escapeRegExp('plain text')).toBe('plain text');
  });
});
