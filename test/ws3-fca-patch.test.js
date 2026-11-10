"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { patchThreadListSource } = require("../scripts/patch-ws3-fca");

test("ws3-fca thread-list patch tolerates participants without big_image_src", () => {
  const source = "return participants.map(p => ({ image: p.big_image_src.uri, id: p.id }));";
  const result = patchThreadListSource(source);
  assert.equal(result.count, 1);
  assert.match(result.source, /p\.big_image_src\?\.uri \|\| null/);
  assert.doesNotMatch(result.source, /p\.big_image_src\.uri/);
});

test("ws3-fca thread-list patch is idempotent", () => {
  const source = "image: p.big_image_src?.uri || null";
  const result = patchThreadListSource(source);
  assert.equal(result.alreadyPatched, true);
  assert.equal(result.source, source);
});

test("ws3-fca thread-list patch fails closed when upstream source changes", () => {
  assert.throws(() => patchThreadListSource("return participant.photo.uri;"), /changed/);
});
