'use strict';

const DEBUG = false;

// We cannot use console.log for debugging because it would call back into our hook
const fs = require('fs');
function debug(msg) {
  fs.writeSync(1, 'trace.js DEBUG ' + msg + '\n');
}

// Arbitrarily limit ourselves so we don't use up all memory on storing stack traces
const MAX_DESCENDANT_COUNT = 10;
const MAX_DESCENDANT_DEPTH_TRAVERSAL = 10;
const MAX_STACKS_TO_JOIN = 50;

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
      printRootTraces();
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


// We must take a copy of the CallSite objects to avoid retaining references to Promises.
// If we retain a Promise reference then asyncDestroy for the Promise won't be called,
// so we'll leak memory.
class CallSiteCopy {
  constructor(callSite) {
    this._fileName = callSite.getFileName();
    this._lineNumber = callSite.getLineNumber();
    this._columnNumber = callSite.getColumnNumber();
    this._toString = callSite.toString(); // TODO this is slow
  }

  getFileName() {
    return this._fileName;
  }

  getLineNumber() {
    return this._lineNumber;
  }

  getColumnNumber() {
    return this._columnNumber;
  }

  toString() {
    return this._toString;
  }
}

function getCallSites(skip) {
  const limit = Error.stackTraceLimit;

  Error.stackTraceLimit = limit + skip;
  const stack = chain.callSite({
    extend: false,
    filter: true,
    slice: skip
  });
  Error.stackTraceLimit = limit;

  return stack.map((callSite) => new CallSiteCopy(callSite));
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
    this.disabled = false;
  }

  recordDescendant(descendant) {
    if (this.disabled || this.descendants.includes(descendant)) {
      return;
    }

    this.descendants.push(descendant);

    if (this.descendants.length >= MAX_DESCENDANT_COUNT) {
      this.descendants = [];
      this.disabled = true;
      return;
    }

    for (const subDescendant of descendant.walk()) {
      mergeIntoStackMap(subDescendant.stackMap, this.stackMap);
      removeOldestFromStackMap(subDescendant.stackMap);
    }
  }

  walk(visited=[this], depth=0) {
    if (depth > MAX_DESCENDANT_DEPTH_TRAVERSAL) {
      return;
    }
    for (const trace of this.descendants) {
      if (!visited.includes(trace)) {
        visited.push(trace);
        trace.walk(visited, depth + 1);
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

function removeOldestFromStackMap(stackMap) {
  if (stackMap.size < MAX_STACKS_TO_JOIN) {
    return;
  }

  for (const key of sort(stackMap.keys())) {
    if (stackMap.size < MAX_STACKS_TO_JOIN) {
      return;
    }
    stackMap.delete(key);
  }
}

function appendExtendedFrames(frames, trace) {
  const sortedAsyncIds = rsort(trace.stackMap.keys());

  if (DEBUG) debug(`extending with ${sortedAsyncIds}`);

  for (const asyncId of sortedAsyncIds) {
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

function sort(iterator) {
  return Array.from(iterator).sort((a, b) => a - b);
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

// Pretty printer, for debugging only

function printRootTraces() {
  const rootAsyncIds = findRootAsyncIds();
  for (const asyncId of rootAsyncIds) {
    printTree(traces.get(asyncId));
  }
}

function findRootAsyncIds() {
  const asyncIds = new Set(traces.keys());
  for (const trace of traces.values()) {
    for (const notRootTrace of trace.descendants) {
      asyncIds.delete(notRootTrace.asyncId);
    }
  }
  return asyncIds;
}

function printTree(trace, indent='', isLast=true, visited=new Set()) {
  let line = indent + '\\-' + trace.asyncId;

  if (isLast) {
    indent += ' ';
  } else {
    indent += '| ';
  }

  if (!traces.get(trace.asyncId)) {
    line += ' (not-root)';
  }

  if (trace.disabled) {
    line += ' (disabled)';
  }

  if (visited.has(trace.asyncId)) {
    line += ' (cycle)';
  }

  fs.writeSync(1, line + '\n');

  if (visited.has(trace.asyncId)) {
    return;
  }
  visited.add(trace.asyncId);

  for (let i = 0; i < trace.descendants.length; ++i) {
    printTree(trace.descendants[i], indent, i === trace.descendants.length - 1, visited);
  }
}
