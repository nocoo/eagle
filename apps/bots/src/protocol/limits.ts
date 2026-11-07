// Wire limits from docs/bots/PROTOCOL.md#limits. Everything here is measured on the
// encoded frame unless the name says otherwise.

export const MAX_FRAME_BYTES = 256 * 1024;
/** An HTTP body, measured as received: a 4 000-character CJK instruction is already 12 KiB. */
export const MAX_HTTP_BODY_BYTES = MAX_FRAME_BYTES;
export const MAX_SEND_TEXT = 8_000;
export const MAX_SEND_FILE_IDS = 16;
export const FILE_ID = /^f_[0-9a-f]{64}$/;
export const MAX_TITLE_CHARS = 80;
/** A bot's optional label: short enough to sit next to the title in the sidebar. */
export const MAX_LABEL_CHARS = 24;
export const MAX_NOTICE_BYTES = 500;
export const MAX_MESSAGE_BYTES = 96 * 1024;
export const MAX_BOT_SUMMARY_BYTES = 1_200;
export const MAX_CATALOG = 200;
export const MAX_PENDING = 32;
export const MAX_INBOX = 32;
export const PAGE_MAX_MESSAGES = 200;
export const PAGE_MAX_BYTES = 192 * 1024;
export const DELTA_FLUSH_MS = 50;
export const DELTA_FLUSH_BYTES = 96 * 1024;
export const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const TRACE_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const BOT_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** A committed entry id, the only legal `history.before` cursor. */
export const COMMITTED_ENTRY_ID = /^e_[A-Za-z0-9_-]{1,64}$/;
/** A provisional streaming message id. Never a history cursor. */
export const PROVISIONAL_ID = /^p_a[0-9]{1,6}$/;
/** A minted failure identity. */
export const FAILURE_ID = /^f_[A-Za-z0-9_-]{1,32}$/;
