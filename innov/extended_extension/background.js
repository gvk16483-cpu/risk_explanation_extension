let currentEmailData = {
  subject: '',
  from: '',
  fromEmail: '',
  to: '',
  body: '',
  timestamp: null,
  links: []
};

chrome.runtime.onInstalled.addListener(r => {
  if (r.reason == 'install') {
    chrome.tabs.create({
      url: 'onboarding-page.html'
    });
  }
});

// Track which hostname we've injected into per tabId to avoid repeated injections
const injectedTabs = new Map(); // tabId -> hostname

function getSupportedHost(url) {
  try {
    const h = new URL(url).hostname;
    if (h.includes('mail.google.com')) return 'mail.google.com';
    if (h.includes('web.whatsapp.com')) return 'web.whatsapp.com';
    if (h.includes('web.telegram.org')) return 'web.telegram.org';
  } catch (e) { }
  return null;
}

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (!tab || !tab.url) return;
  if (changeInfo.status !== 'complete') return; // wait until load complete

  const host = getSupportedHost(tab.url);
  if (!host) {
    if (injectedTabs.has(tabId)) injectedTabs.delete(tabId);
    return;
  }

  const prev = injectedTabs.get(tabId);
  if (prev === host) return; // already injected for this host

  chrome.scripting.executeScript({ files: ['contentScript.js'], target: { tabId: tabId } }, () => {
    if (chrome.runtime.lastError) {
      console.warn('Injection failed for tab', tabId, chrome.runtime.lastError);
      return;
    }
    injectedTabs.set(tabId, host);
    console.log('Injected reader content script into', host, 'tab', tabId);
  });
});

// Inject when a tab becomes active (handles existing open tabs)
chrome.tabs.onActivated.addListener(function (activeInfo) {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (!tab || !tab.url) return;
    const host = getSupportedHost(tab.url);
    if (!host) return;
    const prev = injectedTabs.get(activeInfo.tabId);
    if (prev === host) return;
    chrome.scripting.executeScript({ files: ['contentScript.js'], target: { tabId: activeInfo.tabId } }, () => {
      if (chrome.runtime.lastError) {
        console.warn('Activation injection failed for tab', activeInfo.tabId, chrome.runtime.lastError);
        return;
      }
      injectedTabs.set(activeInfo.tabId, host);
      console.log('Injected on activation into', host, 'tab', activeInfo.tabId);
    });
  });
});

// Clean up when tabs are removed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (injectedTabs.has(tabId)) injectedTabs.delete(tabId);
});

// Debounce/cache mechanism: avoid duplicate ML calls per tab/message
// Using a global variable for cache to persist across messages
let predictionCache = {};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  // Unique hash for each message (subject+body+platform)
  function getMessageHash(data) {
    // Simple hash to detect if content changed significantly
    return btoa(encodeURIComponent((data.subject || '').slice(0, 50) + '|' + (data.body || '').slice(0, 50) + '|' + (data.platform || '')));
  }

  // ML prediction fetch logic
  async function fetchPrediction(data) {
    const url = 'http://127.0.0.1:5000/predict';
    const payload = {
      subject: data.subject || '',
      body: data.body || '',
      links: data.links || [],
      platform: data.platform || ''
    };

    console.log('[ML] API request sent:', payload);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 40000); // 40s timeout for Agent API

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`ML backend error: ${response.status}`);
      }

      const result = await response.json();
      console.log('[ML] API response received:', result);
      return result;
    } catch (err) {
      console.error('[ML] API failure:', err);
      // Return a safe error object so calling code doesn't crash
      return {
        final_risk_label: 'error',
        risk_label: 'error',
        final_score: 0,
        explanation: err.message || 'ML backend unavailable',
        error: err.message || 'ML backend unavailable'
      };
    }
  }

  // Handle updateEmail action
  if (request.action === 'updateEmail') {
    const data = request.data || {};
    currentEmailData = {
      subject: data.subject || 'No Subject',
      from: data.from || 'Unknown Sender',
      fromEmail: data.fromEmail || '',
      to: data.to || 'Unknown',
      body: data.body || 'No content',
      links: data.links || [],
      platform: data.platform || 'unknown',
      timestamp: new Date().toLocaleString()
    };

    // Save to local storage for popup
    chrome.storage.local.set({ lastEmail: currentEmailData }, () => {
      // acknowledged storage set
    });

    // Acknowledge receipt immediately to keep content script happy
    // (We'll send the prediction result asynchronously via tabs.sendMessage)
    sendResponse({ success: true, status: 'processing' });

    // --- ML PREDICTION FLOW ---

    const tabId = sender.tab ? sender.tab.id : null;
    if (!tabId) {
      console.warn('No tabId for ML prediction');
      return true; // keep channel open (though we already responded)
    }

    const msgHash = getMessageHash(currentEmailData);

    // Check Cache
    if (predictionCache[tabId] && predictionCache[tabId].hash === msgHash) {
      console.log('[ML] Duplicate message content, skipping API call. Re-sending cached result.');
      // Re-send cached result in case UI needs refresh
      chrome.tabs.sendMessage(tabId, {
        type: 'predictionResult',
        data: predictionCache[tabId].result
      }).catch(() => { }); // ignore if tab closed
      return true;
    }

    // New content -> Call API
    (async () => {
      // 🌈 SET PROCESSING STATE - Triggers rainbow border
      chrome.storage.local.set({ processingState: true }, () => {
        console.log('[ML] Processing state set - rainbow border should appear');
      });

      // Notify content script of processing state
      chrome.tabs.sendMessage(tabId, {
        type: 'predictionResult',
        data: { final_risk_label: 'processing', risk_label: 'processing', confidence: 0 }
      }).catch(() => { });

      const prediction = await fetchPrediction(currentEmailData);

      // 🌈 CLEAR PROCESSING STATE - Removes rainbow border
      chrome.storage.local.set({ processingState: false }, () => {
        console.log('[ML] Processing state cleared');
      });

      // Update Cache
      if (prediction && prediction.final_risk_label && prediction.final_risk_label !== 'error') {
        predictionCache[tabId] = {
          hash: msgHash,
          timestamp: Date.now(),
          result: prediction
        };
      }

      // Send result to content script
      console.log('[ML] Sending prediction to content script:', prediction);
      chrome.tabs.sendMessage(tabId, {
        type: 'predictionResult',
        data: prediction
      }, () => {
        if (chrome.runtime.lastError) {
          // Tab might have been closed or refreshed
          console.warn('Prediction sendMessage failed (tab likely closed):', chrome.runtime.lastError.message);
        } else {
          console.log('[ML] ✅ Prediction successfully sent to content script');
        }
      });
    })();

    // return true to indicate async response (even though we already called sendResponse, good practice)
    return true;
  }

  // Handle getEmail action (for popup)
  if (request.action === 'getEmail') {
    sendResponse({ email: currentEmailData });
  }
});

