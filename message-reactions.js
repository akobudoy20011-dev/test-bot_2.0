"use strict";

function extractMessageID(info) {
  if (typeof info === "string" || typeof info === "number") {
    const value = String(info).trim();
    return value || null;
  }
  const candidates = [
    info?.messageID,
    info?.messageId,
    info?.message_id,
    info?.id,
    info?.message?.messageID,
    info?.message?.messageId,
    info?.message?.id
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && String(candidate).trim()) {
      return String(candidate).trim();
    }
  }
  return null;
}

function isErrorResult(value) {
  return Boolean(value && typeof value === "object" &&
    (value.type === "error" || value.type === "error_message_reaction" ||
      value.error || value.errorDescription || value.error_description));
}

/**
 * Submit a reaction to a message sent by this bot. MQTT publish is preferred;
 * the regular reaction API is used when MQTT is missing or explicitly fails.
 * "submitted" means the request was handed to the transport, not that Facebook
 * confirmed the reaction was applied.
 */
function dispatchMessageReaction(api, emoji, messageID, threadID, options = {}) {
  const id = String(messageID || "").trim();
  const groupID = String(threadID || "").trim();
  const onStatus = typeof options.onStatus === "function" ? options.onStatus : () => {};
  if (!id || !groupID) {
    const error = new Error("A message ID and thread ID are required.");
    onStatus("failed", { error });
    return { ok: false, method: null };
  }

  let fallbackStarted = false;
  const fallback = error => {
    if (fallbackStarted) return;
    fallbackStarted = true;
    if (error) onStatus("fallback", { error, method: "mqtt" });
    if (typeof api?.setMessageReaction !== "function") {
      if (!error) onStatus("failed", { error: new Error("No supported reaction API is available."), method: null });
      return;
    }
    try {
      const returned = api.setMessageReaction(emoji, id, (callbackError, result) => {
        if (callbackError || isErrorResult(result)) {
          onStatus("failed", { error: callbackError || result, method: "setMessageReaction" });
        } else {
          onStatus("submitted", { method: "setMessageReaction", acknowledged: true });
        }
      }, true);
      if (returned && typeof returned.then === "function") {
        returned.then(result => {
          if (isErrorResult(result)) onStatus("failed", { error: result, method: "setMessageReaction" });
          else onStatus("submitted", { method: "setMessageReaction", acknowledged: false });
        }).catch(callbackError => onStatus("failed", { error: callbackError, method: "setMessageReaction" }));
      } else if (returned !== undefined) {
        if (isErrorResult(returned)) onStatus("failed", { error: returned, method: "setMessageReaction" });
        else onStatus("submitted", { method: "setMessageReaction", acknowledged: false });
      }
    } catch (fallbackError) {
      onStatus("failed", { error: fallbackError, method: "setMessageReaction" });
    }
  };

  if (typeof api?.setMessageReactionMqtt === "function") {
    try {
      const returned = api.setMessageReactionMqtt(emoji, id, groupID, error => {
        if (error) fallback(error);
      });
      if (returned && typeof returned.then === "function") {
        returned.then(result => {
          if (isErrorResult(result)) fallback(result);
          else onStatus("submitted", { method: "setMessageReactionMqtt", acknowledged: false });
        }).catch(fallback);
      } else if (isErrorResult(returned) || returned === false) {
        fallback(returned || new Error("MQTT reaction publish returned false."));
      } else {
        onStatus("submitted", { method: "setMessageReactionMqtt", acknowledged: false });
      }
      return { ok: true, method: "setMessageReactionMqtt" };
    } catch (error) {
      fallback(error);
      return { ok: false, method: "setMessageReactionMqtt" };
    }
  }

  fallback(null);
  return { ok: typeof api?.setMessageReaction === "function", method: "setMessageReaction" };
}

module.exports = { extractMessageID, dispatchMessageReaction, isErrorResult };
