const Module = require('module');
const { dirname } = require('path');

// jsdom probes for the optional native `canvas` package. pnpm skips its native
// build, so the probe finds the package, the binding is missing and jsdom
// throws while loading. When the real module can't load, an empty module is
// registered in its place, which jsdom treats exactly like canvas not being
// installed. A working canvas build is left untouched
const jsdomDir = dirname(
  require.resolve('jsdom', {
    paths: [dirname(require.resolve('jest-environment-jsdom'))],
  })
);

let canvasPath;
try {
  canvasPath = require.resolve('canvas', { paths: [jsdomDir] });
} catch (e) {
  canvasPath = undefined;
}

if (canvasPath && !require.cache[canvasPath]) {
  try {
    require(canvasPath);
  } catch (e) {
    const stub = new Module(canvasPath);
    stub.filename = canvasPath;
    stub.loaded = true;
    stub.exports = {};
    require.cache[canvasPath] = stub;
  }
}

module.exports = require('jest-environment-jsdom');
