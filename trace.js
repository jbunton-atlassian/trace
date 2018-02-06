'use strict';

const DEBUG = false;
const fs = require('fs');
function debug(msg) {
  fs.writeSync(1, 'trace.js DEBUG ' + msg + '\n');
}

const chain = require('stack-chain');
const asyncHook = require('async_hooks');

// Contains the Trace objects of all active scopes
const traces = new Map();

//
// Manipulate stack trace
//
// add lastTrace to the callSite array
chain.filter.attach(function (error, frames) {
  return frames.filter(function (callSite) {
    const name = callSite && callSite.getFileName();
    return (!name || name !== 'async_hooks.js');
  });
});

chain.extend.attach(function (error, frames) {
  const asyncId = asyncHook.executionAsyncId();
  const lastTrace = traces.get(asyncId);

  if (DEBUG) debug(`EXTENDING ${asyncId}\n`);

  if (lastTrace) {
    frames.push.apply(frames, lastTrace.getExtendedFrames());
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

  if (aFile === null || aLine === null || aColumn === null) {
    return false;
  }

  return (aFile === b.getFileName() &&
          aLine === b.getLineNumber() &&
          aColumn === b.getColumnNumber());
}

class Trace {
  constructor(asyncId) {
    this.asyncId = asyncId;
    this.stack = getCallSites(3);
    this.ancestors = [this];
  }

  recordAncestor(ancestorAsyncId) {
    const ancestorTrace = traces.get(ancestorAsyncId);
    if (ancestorTrace && !this.ancestors.includes(ancestorTrace)) {
      this.ancestors.unshift(ancestorTrace);
    }
  }

  walkAncestors(visited=[]) {
    for (const ancestorTrace of this.ancestors) {
      if (!visited.includes(ancestorTrace)) {
        visited.push(ancestorTrace);
        ancestorTrace.walkAncestors(visited);
      }
    }
    return visited;
  }

  getExtendedFrames() {
    const ancestors = this.walkAncestors();
    ancestors.sort((a, b) => b.asyncId - a.asyncId);

    if (DEBUG) debug(`ANCESTORS -> ${ancestors.map((a) => a.asyncId)}\n`);

    const frames = [];
    for (const ancestorTrace of ancestors) {
      appendUniqueFrames(frames, ancestorTrace.stack);
    }
    return frames;
  }
}

function appendUniqueFrames(frames, newFrames) {
  for (let i = 1; i <= newFrames.length && frames.length > 1; ++i) {
    if (equalCallSite(newFrames[newFrames.length - i], frames[frames.length - 1])) {
      frames.pop();
    }
  }
  frames.push(...newFrames);
}

function asyncInit(asyncId, type, triggerAsyncId, resource) {
  const trace = new Trace(asyncId);
  if (DEBUG) debug(`new Trace(${asyncId}) -->\n  ${trace.stack.join("\n  ")}\n`);

  trace.recordAncestor(triggerAsyncId, 'asyncInit');
  if (DEBUG) debug(`Trace(${asyncId}).recordAncestor(${triggerAsyncId}) // asyncInit`);

  traces.set(asyncId, trace);
}

function asyncDestroy(asyncId) {
  traces.delete(asyncId);
}

function asyncPromiseResolve(asyncId) {
  const trace = traces.get(asyncId);

  trace.recordAncestor(asyncHook.triggerAsyncId(), 'promiseResolve');
  if (DEBUG) debug(`Trace(${asyncId}).recordAncestor(${asyncHook.triggerAsyncId()}) // promiseResolve (${asyncHook.executionAsyncId()})`);
}
