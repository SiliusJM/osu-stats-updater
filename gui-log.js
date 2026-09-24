'use strict';

(function expose(root, factory) {
  const appendBoundedLog = factory();
  if (typeof module === 'object' && module.exports) module.exports = appendBoundedLog;
  if (root) root.appendBoundedLog = appendBoundedLog;
}(typeof window !== 'undefined' ? window : globalThis, function createAppendBoundedLog() {
  return function appendBoundedLog(area, paragraph, limit = 750) {
    area.appendChild(paragraph);
    while (area.childElementCount > limit) area.firstElementChild.remove();
  };
}));
