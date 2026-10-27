"use strict";

const MAX_PROCESSED_MESSAGE_IDS = 5000;
const processedMessageIDs = new Map();

/**
 * Returns true only when a non-empty Messenger message ID has already been
 * processed. Keeps a bounded FIFO cache so reconnect/replayed callbacks cannot
 * trigger duplicate replies indefinitely or grow memory without limit.
 */
function isDuplicateMessage(messageID) {
  if (messageID === undefined || messageID === null || String(messageID).trim() === "") {
    return false;
  }

  const id = String(messageID);
  if (processedMessageIDs.has(id)) return true;

  processedMessageIDs.set(id, Date.now());
  while (processedMessageIDs.size > MAX_PROCESSED_MESSAGE_IDS) {
    processedMessageIDs.delete(processedMessageIDs.keys().next().value);
  }
  return false;
}

function resetProcessedMessages() {
  processedMessageIDs.clear();
}

module.exports = { isDuplicateMessage, resetProcessedMessages, MAX_PROCESSED_MESSAGE_IDS };
