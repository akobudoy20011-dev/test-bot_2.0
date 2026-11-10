"use strict";

function invokeNicknameChange(api, nickname, threadID, userID) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = error => {
      if (settled) return;
      settled = true;
      error ? reject(error) : resolve();
    };
    try {
      const returned = api.changeNickname(nickname, threadID, userID, done);
      if (returned && typeof returned.then === "function") returned.then(() => done(null)).catch(done);
    } catch (error) { done(error); }
  });
}

async function executeMassSetNickname(options = {}) {
  const api = options.api;
  const threadID = String(options.threadID || "").trim();
  const nickname = String(options.nickname || "").trim();
  const selected = [...new Set((Array.isArray(options.userIDs) ? options.userIDs : []).map(String).filter(Boolean))];
  if (!threadID || !nickname) throw new Error("Choose a group and enter a nickname.");
  if (nickname.length > 64) throw new Error("Nickname must be 64 characters or fewer.");
  if (!selected.length || selected.length > 50) throw new Error("Select between 1 and 50 group members.");
  if (!api || typeof api.changeNickname !== "function") throw new Error("Messenger nickname controls are unavailable.");
  if (typeof options.getMembers !== "function") throw new Error("Messenger member validation is unavailable.");
  const members = await options.getMembers(threadID);
  const allowed = new Set((Array.isArray(members) ? members : []).map(member => String(member.userID || member.id || "")).filter(Boolean));
  const invalid = selected.filter(userID => !allowed.has(userID));
  if (invalid.length) throw new Error("One or more selected users are no longer members of this group. Reload the member list.");
  const wait = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const delayMs = Math.max(0, Number(options.delayMs ?? 1200));
  const results = [];
  for (let i = 0; i < selected.length; i++) {
    const userID = selected[i];
    try {
      await invokeNicknameChange(api, nickname, threadID, userID);
      results.push({ userID, ok: true });
    } catch (error) {
      results.push({ userID, ok: false, error: String(error?.message || error).slice(0, 180) });
    }
    if (i < selected.length - 1 && delayMs) await wait(delayMs);
  }
  return {
    total: selected.length,
    succeeded: results.filter(item => item.ok).length,
    failed: results.filter(item => !item.ok).length,
    results
  };
}

module.exports = { executeMassSetNickname };
