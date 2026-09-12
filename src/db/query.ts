import sleep from '@/utility/sleep';
import { ADMIN_SQL_DEBUG_ENABLED } from '@/app/config';

// Transient connectivity issues are worth a single retry. Unlike the previous
// Postgres implementation, errors are no longer matched against SQL error
// text because there is no longer any JIT schema migration to trigger.
const TRANSIENT_ERROR_PATTERN = new RegExp([
  'endpoint is in transition',
  'ECONNRESET',
  'ETIMEDOUT',
  'socket hang up',
  'network error',
  'timed out',
  'timeout',
].join('|'), 'i');

/** Safe wrapper intended for most queries, adding a retry and debug timing */
export const safelyQuery = async <T>(
  callback: () => Promise<T>,
  queryLabel: string,
  queryOptions?: object,
): Promise<T> => {
  const start = new Date();

  let result: T;

  try {
    result = await callback();
  } catch (e: any) {
    const message = e?.message ?? `${e}`;

    if (TRANSIENT_ERROR_PATTERN.test(message)) {
      console.log(
        `Query error (${queryLabel}), retrying in 2000ms: ${message}`,
      );
      await sleep(2000);
      try {
        result = await callback();
      } catch (retryError: any) {
        console.log(
          `Query error on retry (${queryLabel}): ${retryError?.message}`,
        );
        throw retryError;
      }
    } else {
      console.log(`Query error (${queryLabel}): ${message}`, { error: e });
      throw e;
    }
  }

  if (ADMIN_SQL_DEBUG_ENABLED && queryLabel) {
    const time =
      (((new Date()).getTime() - start.getTime()) / 1000).toFixed(2);
    const message = `Debug query: ${queryLabel} (${time} seconds)`;
    if (queryOptions) {
      console.log(message, { options: queryOptions });
    } else {
      console.log(message);
    }
  }

  return result;
};
