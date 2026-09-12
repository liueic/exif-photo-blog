import {
  ABOUT_DOCUMENT_ID,
  COLLECTION_ABOUT,
  getDb,
} from '@/platforms/cloudbase';
import { About, AboutInsert } from '.';
import { safelyQuery } from '@/db/query';
import camelcaseKeys from 'camelcase-keys';
import { parseDocument } from '@/db';

// The `about` content is a single document rather than a table of rows
const ABOUT_ID = 1;

// `about` is created implicitly on first write — the document store has no
// DDL, so there is no table-creation equivalent

export const upsertAbout = (about: AboutInsert) =>
  safelyQuery(async () => {
    const now = new Date();
    await getDb()
      .collection(COLLECTION_ABOUT)
      .doc(ABOUT_DOCUMENT_ID)
      .set({
        title: about.title ?? null,
        subhead: about.subhead ?? null,
        description: about.description ?? null,
        photoIdAvatar: about.photoIdAvatar ?? null,
        photoIdHero: about.photoIdHero ?? null,
        updatedAt: now,
        createdAt: now,
      });
    // Whole-document `set` is an upsert, replacing `ON CONFLICT DO UPDATE`
    return ABOUT_ID;
  }, 'upsertAbout');

export const getAbout = () =>
  safelyQuery(async () => {
    const { data } = await getDb()
      .collection(COLLECTION_ABOUT)
      .doc(ABOUT_DOCUMENT_ID)
      .get();

    const document = Array.isArray(data) ? data[0] : data;

    return document
      ? {
        ...camelcaseKeys(
          parseDocument<Record<string, unknown>>(document) ?? {},
        ),
        // Single-document collection: the numeric id is preserved for the UI
        id: ABOUT_ID,
      } as unknown as About
      : undefined;
  }, 'getAbout');
