'use strict';

const DEBUG = false;

// We cannot use console.log for debugging because it would call back into our hook
const fs = require('fs');
function debug(msg) {
  fs.writeSync(1, 'trace.js DEBUG ' + msg + '\n');
}

const chain = require('stack-chain');
const asyncHook = require('async_hooks');

// A fake CallSite which visually separates stacks from different async contexts
const asyncContextCallSiteMarker = {
  getFileName: () => null,
  getLineNumber: () => 0,
  getColumnNumber: () => 0,
  toString: () => '____________________'
};

// Contains the Trace objects of all active async execution contexts
const traces = new Map();

//
// Manipulate stack trace
//
// add lastTrace to the callSite array
chain.filter.attach(function (error, frames) {
  return frames.filter(function (callSite) {
    const name = callSite && callSite.getFileName();
    return name !== 'async_hooks.js' && name !== 'internal/async_hooks.js';
  });
});

chain.extend.attach(function (error, frames) {
  const asyncId = asyncHook.executionAsyncId();
  const lastTrace = traces.get(asyncId);

  if (lastTrace) {
    if (DEBUG) {
      debug(`extending: ${asyncId}`);
    }
    appendExtendedFrames(frames, lastTrace);
  }
  return frames;
});

//
// Track handle objects
//
const hooks = asyncHook.createHook({
  init: asyncInit,
  destroy: asyncDestroy,
  promiseResolve: asyncPromiseResolve
});
hooks.enable();
exports.disable = () => hooks.disable();

function getCallSites(skip) {
  const limit = Error.stackTraceLimit;

  Error.stackTraceLimit = limit + skip;
  const stack = chain.callSite({
    extend: false,
    filter: true,
    slice: skip
  });
  Error.stackTraceLimit = limit;

  return stack;
}

function equalCallSite(a, b) {
  const aFile = a.getFileName();
  const aLine = a.getLineNumber();
  const aColumn = a.getColumnNumber();

  return (aFile === b.getFileName() &&
          aLine === b.getLineNumber() &&
          aColumn === b.getColumnNumber());
}

class Trace {
  constructor(asyncId, stack) {
    this.asyncId = asyncId;
    this.stackMap = new Map([
      [asyncId, stack]
    ]);
    this.descendants = [];
  }

  recordDescendant(descendant) {
    if (this.descendants.includes(descendant)) {
      return;
    }

    this.descendants.push(descendant);

    for (const subDescendant of descendant.walk()) {
      mergeIntoStackMap(subDescendant.stackMap, this.stackMap);
    }
  }

  walk(visited=[this]) {
    for (const trace of this.descendants) {
      if (!visited.includes(trace)) {
        visited.push(trace);
        trace.walk(visited);
      }
    }
    return visited;
  }
}

function mergeIntoStackMap(dest, source) {
  for (const [key, value] of source) {
    dest.set(key, value);
  }
}

function appendExtendedFrames(frames, trace) {
  for (const asyncId of rsort(trace.stackMap.keys())) {
    const newFrames = trace.stackMap.get(asyncId);
    appendUniqueFrames(frames, newFrames);
  }
}

function appendUniqueFrames(frames, newFrames) {
  for (let i = 1; i <= newFrames.length && frames.length > 1; ++i) {
    if (equalCallSite(newFrames[newFrames.length - i], frames[frames.length - 1])) {
      frames.pop();
    }
  }

  frames.push(asyncContextCallSiteMarker);
  frames.push(...newFrames);
}

function rsort(iterator) {
  return Array.from(iterator).sort((a, b) => b - a);
}

function asyncInit(asyncId, type, triggerAsyncId) {
  const stack = getCallSites(2);
  const trace = new Trace(asyncId, stack);
  traces.set(asyncId, trace);
  if (DEBUG) debug(`asyncInit ${asyncId}\n  ${stack.join('\n  ')}\n`);

  const ancestorTrace = traces.get(triggerAsyncId);
  if (ancestorTrace) {
    ancestorTrace.recordDescendant(trace);
  }
}

function asyncDestroy(asyncId) {
  if (DEBUG) debug(`asyncDestroy ${asyncId}`);
  traces.delete(asyncId);
}

function asyncPromiseResolve(asyncId) {
  const triggerAsyncId = asyncHook.triggerAsyncId();

  const ancestorTrace = traces.get(triggerAsyncId);
  const trace = traces.get(asyncId);

  if (trace && ancestorTrace) {
    ancestorTrace.recordDescendant(trace);
  }
}
