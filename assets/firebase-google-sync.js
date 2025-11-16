// Firebase Google OAuth + Firestore sync helper for Prana
// Paste this file into your project and include it after index.html's script.
// Then call pranaGoogleSync.init({ firebaseConfig }) on DOMContentLoaded.

(function(window){
  // Config/state
  let firebaseApp = null;
  let auth = null;
  let firestore = null;
  let currentUser = null;
  let saveToServerDebounceTimer = null;
  const SAVE_DEBOUNCE_MS = 2000; // 2s debounce

  // External hooks you can implement in your app
  const hooks = { onAuthChange: null };  

  // Minimal validator if the app doesn't have one
  function defaultValidate(parsed) {
    const repaired = {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return repaired;
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
      const sec = Math.floor(Number(v) || 0);
      if (sec > 0) repaired[k] = sec;
    }
    return repaired;
  }

  function mergeFocusHistories(local = {}, remote = {}, options = { strategy: 'mmax' }) {
    const out = {};
    const keys = new Set([...Object.keys(local || {}), ...Object.keys(remote || {})]);
    for (const k of keys) {
      const l = Math.floor(Number(local[k]) || 0);
      const r = Math.floor(Number(remote[k]) || 0);
      if (options.strategy === 'sum') {
        out[k] = Math.max(0, l + r);
      } else {
        // treat 'mmax' same as 'max' conservative merge to avoid double-counting
        out[k] = Math.max(0, Math.max(l, r));
      }
    }
    return out;
  }

  function userDocRef(uid) { return firestore.collection('users').doc(uid); }

  async function ensureFirebaseSDKs() {
    if (typeof firebase !== 'undefined' && firebase && firebase.apps !== undefined) return;
    // Load compat SDKs (app, auth, firestore)
    await new Promise((resolve, reject) => {
      const u = "https://www.gstatic.com/firebasejs/9.23.0/";
      const scripts = [
        u + "firebase-app-compat.js",
        u + "firebase-auth-compat.js",
        u + "firebase-firestore-compat.js"
      ];
      let loaded = 0;
      scripts.forEach(src => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => { loaded++; if (loaded === scripts.length) resolve(); };
        s.onerror = (e) => reject(new Error('Failed to load firebase SDK: ' + src));
        document.head.appendChild(s);
      });
    });
  }

  async function init(options = {}) {
    const { firebaseConfig, autoAttachAddFocusTime = true } = options;
    if (!firebaseConfig || !firebaseConfig.apiKey) {
      console.warn('pranaGoogleSync: firebaseConfig missing — skipping server sync initialization.');
      return;
    }

    await ensureFirebaseSDKs();

    try {
      firebaseApp = firebase.initializeApp(firebaseConfig);
      auth = firebase.auth();
      firestore = firebase.firestore();
    } catch (e) {
      console.error('pranaGoogleSync: firebase init error', e);
      return;
    }

    auth.onAuthStateChanged(async (user) => {
      currentUser = user;
      if (user) {
        try {
          const remote = await loadFocusHistoryFromServer();
          const validate = window.validateAndRepairFocusHistory || defaultValidate;
          if (typeof window.focusHistory === 'object') {
            const repairedRemote = validate(remote);
            const repairedLocal = validate(window.focusHistory);
            const merged = mergeFocusHistories(repairedLocal, repairedRemote, { strategy: 'mmax' });
            window.focusHistory = merged;
            if (typeof window.saveFocusHistory === 'function') {
              window.saveFocusHistory();
            } else {
              try { localStorage.setItem('focusHistory', JSON.stringify(merged)); } catch(e){/*quiet*/ }
            }
            if (typeof window.updateFocusStatsDisplay === 'function') window.updateFocusStatsDisplay();
            if (typeof window.renderFocusChart === 'function') window.renderFocusChart();
            debounceSaveFocusHistoryToServer();
          } else {
            const repairedRemote = validate(remote);
            window.focusHistory = repairedRemote;
            if (typeof window.saveFocusHistory === 'function') window.saveFocusHistory();
          }
        } catch (e) {
          console.warn('pranaGoogleSync: error loading remote focus history', e);
        }
      }
      if (typeof hooks.onAuthChange === 'function') hooks.onAuthChange(user);
    });

    if (autoAttachAddFocusTime) attachAutoSyncToAddFocusTime();
  }

  async function signInWithGooglePopup() {
    if (!auth) throw new Error('Auth not initialized');
    const provider = new firebase.auth.GoogleAuthProvider();
    try { const result = await auth.signInWithPopup(provider); return result; } catch (e) { console.warn('pranaGoogleSync: Google sign-in failed', e); throw e; }
  }

  async function signOut() { if (!auth) throw new Error('Auth not initialized'); return auth.signOut(); }

  async function loadFocusHistoryFromServer() {
    if (!currentUser) throw new Error('Not signed in');
    const doc = await userDocRef(currentUser.uid).get();
    if (!doc.exists) return {};
    const data = doc.data() || {};
    return typeof data.focusHistory === 'object' && !Array.isArray(data.focusHistory) ? data.focusHistory : {};
  }

  async function saveFocusHistoryToServer() {
    if (!currentUser) return;
    try {
      await userDocRef(currentUser.uid).set({ focusHistory: window.focusHistory || {}, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
      console.log('pranaGoogleSync: saved focusHistory to server');
    } catch (e) { console.warn('pranaGoogleSync: failed to save focusHistory to server', e); }
  }

  function debounceSaveFocusHistoryToServer() {
    if (saveToServerDebounceTimer) clearTimeout(saveToServerDebounceTimer);
    saveToServerDebounceTimer = setTimeout(() => { saveToServerDebounceTimer = null; saveFocusHistoryToServer(); }, SAVE_DEBOUNCE_MS);
  }

  function attachAutoSyncToAddFocusTime() {
    if (typeof window.addFocusTime !== 'function') { console.warn('pranaGoogleSync: addFocusTime not found; cannot auto sync.'); return; }
    const original = window.addFocusTime;
    window.addFocusTime = function(seconds) { original(seconds); debounceSaveFocusHistoryToServer(); };
  }

  window.pranaGoogleSync = { init, signInWithGooglePopup, signOut, debounceSaveFocusHistoryToServer, mergeFocusHistories, setOnAuthChange: (fn) => { hooks.onAuthChange = fn; } };

})(window);