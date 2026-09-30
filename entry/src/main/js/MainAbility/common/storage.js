// 原项目 ../../common/storage.js 的华为侧等价实现
// Vela: import storage from '@system.storage'  -> 华为同为 @system.storage
import storage from '@system.storage';

export default {
  get(key, def) {
    return new Promise((resolve) => {
      storage.get({
        key: key,
        success: (d) => resolve(d === '' || d === undefined || d === null ? def : d),
        fail: () => resolve(def)
      });
    });
  },
  set(key, val) {
    return new Promise((resolve) => {
      storage.set({ key: key, value: String(val), success: () => resolve(true), fail: () => resolve(false) });
    });
  },
  // 兼容原项目回调式写法
  getCb(opt) { storage.get(opt); },
  setCb(opt) { storage.set(opt); }
}
