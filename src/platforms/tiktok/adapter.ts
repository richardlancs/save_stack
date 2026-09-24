import type { PlatformAdapter } from '../types';
import { TIKTOK_CAPTURE_RULES, TIKTOK_ORIGIN } from './capture-rules';
import { TIKTOK_PARSER_VERSION, parseTikTokCapture } from './parse';
import { TIKTOK_PAGE_SPEC, TIKTOK_SYNC } from './sync';

export const tiktokAdapter: PlatformAdapter = {
  id: 'tiktok',
  displayName: 'TikTok',
  parserVersion: TIKTOK_PARSER_VERSION,
  hostMatches: [`${TIKTOK_ORIGIN}/*`],
  captureRules: TIKTOK_CAPTURE_RULES,
  parse: parseTikTokCapture,
  sync: { ...TIKTOK_SYNC, ...TIKTOK_PAGE_SPEC },
  canonicalUrl: ({ authorHandle, externalId, mediaType }) => `${TIKTOK_ORIGIN}/@${authorHandle}/${mediaType === 'photo' ? 'photo' : 'video'}/${externalId}`,
};
