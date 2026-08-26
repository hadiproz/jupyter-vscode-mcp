const makeDisposable = () => ({ dispose() {} });

const handler = {
  get(_target, prop) {
    if (prop === '__esModule') return false;
    if (prop === 'then') return undefined;
    return function stubFn() {
      return makeDisposable();
    };
  },
};

module.exports = new Proxy({}, handler);
