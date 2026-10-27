"use strict";

function isOwner(senderID, ownerID) {
  const configuredOwner = String(ownerID || "").trim();
  const sender = String(senderID || "").trim();
  return Boolean(configuredOwner && sender && sender === configuredOwner);
}

module.exports = { isOwner };
