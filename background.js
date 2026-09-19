// ─────────────────────────────────────────────────────────────────────────────
// FreeFollowers — background.js
//
// - visitedSites tracking
// - sites you navigate to are never shown as trackers
// - site type always wins over tracker type
// - sends graph to FreeFollowers every 3 seconds
// - clicking extension icon opens the user's graph
// - /install automatically redirects to graph when extension is installed
// ─────────────────────────────────────────────────────────────────────────────

const SERVER_URL = 'https://freefollowers.ch';

let SESSION_ID = null;


// ── SESSION ID ────────────────────────────────────────────────────────────────

async function getOrCreateSessionId() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['session_id'], (result) => {
      if (result.session_id) {
        SESSION_ID = result.session_id;
        resolve(SESSION_ID);
      } else {
        const newId = Array.from(
          crypto.getRandomValues(new Uint8Array(8))
        )
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');

        chrome.storage.local.set({ session_id: newId });

        SESSION_ID = newId;

        console.log(
          '[FreeFollowers] New session ID:',
          SESSION_ID
        );

        resolve(SESSION_ID);
      }
    });
  });
}


// ── GRAPH DATA ────────────────────────────────────────────────────────────────

const graph = {
  nodes: {},
  edges: {}
};


// ── VISITED SITES ─────────────────────────────────────────────────────────────
// Domains the user directly navigates to.
// These are always treated as sites, never as trackers.

const visitedSites = new Set();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.status === 'complete' &&
    tab.url
  ) {
    const domain = getRootDomain(tab.url);

    if (domain) {
      visitedSites.add(domain);
      addNode(domain, 'site');

      console.log(
        `[FreeFollowers] You visited: ${domain}`
      );
    }
  }
});


// ── HELPERS ───────────────────────────────────────────────────────────────────

function getRootDomain(urlString) {
  try {
    const hostname = new URL(urlString).hostname;

    const parts = hostname.split('.');

    if (parts.length >= 2) {
      return parts.slice(-2).join('.');
    }

    return hostname;

  } catch (e) {
    return null;
  }
}


function addNode(domain, type) {
  if (!domain) return;

  if (!graph.nodes[domain]) {
    graph.nodes[domain] = {
      id: domain,
      label: domain,
      type: type,
      count: 1
    };

    console.log(
      `[FreeFollowers] New node: ${type.toUpperCase()} — ${domain}`
    );

  } else {
    graph.nodes[domain].count++;

    // A directly visited site always wins.
    if (type === 'site') {
      graph.nodes[domain].type = 'site';
    }
  }
}


function addEdge(source, target, cookieName = null) {
  if (
    !source ||
    !target ||
    source === target
  ) {
    return;
  }

  const edgeId = `${source}||${target}`;

  if (!graph.edges[edgeId]) {
    graph.edges[edgeId] = {
      id: edgeId,
      source: source,
      target: target,
      cookies: cookieName ? [cookieName] : [],
      count: 1
    };

    console.log(
      `[FreeFollowers] New edge: ${source} → ${target}`
    );

  } else {
    graph.edges[edgeId].count++;

    if (
      cookieName &&
      !graph.edges[edgeId].cookies.includes(cookieName)
    ) {
      graph.edges[edgeId].cookies.push(cookieName);
    }
  }
}


// ── NETWORK REQUEST LISTENER ──────────────────────────────────────────────────

function startRequestListener() {

  chrome.webRequest.onBeforeSendHeaders.addListener(

    (details) => {

      if (details.tabId === -1) return;

      if (
        details.url.startsWith('chrome-extension://') ||
        details.url.startsWith('moz-extension://')
      ) {
        return;
      }


      const sourceDomain = details.initiator
        ? getRootDomain(details.initiator)
        : null;

      const targetDomain = getRootDomain(details.url);


      if (!sourceDomain || !targetDomain) {
        return;
      }


      // Source node
      const sourceType = visitedSites.has(sourceDomain)
        ? 'site'
        : 'tracker';

      addNode(
        sourceDomain,
        sourceType
      );


      // Third-party target
      if (sourceDomain !== targetDomain) {

        const targetType = visitedSites.has(targetDomain)
          ? 'site'
          : 'tracker';

        addNode(
          targetDomain,
          targetType
        );

        addEdge(
          sourceDomain,
          targetDomain
        );
      }


      // Cookie names
      if (details.requestHeaders) {

        for (const header of details.requestHeaders) {

          if (
            header.name.toLowerCase() === 'cookie' &&
            header.value
          ) {

            const cookieNames = header.value
              .split(';')
              .map(c =>
                c.trim()
                 .split('=')[0]
                 .trim()
              )
              .filter(name => name.length > 0);


            for (const cookieName of cookieNames) {

              addEdge(
                sourceDomain,
                targetDomain,
                cookieName
              );

            }
          }
        }
      }

    },

    {
      urls: ['<all_urls>']
    },

    [
      'requestHeaders'
    ]
  );


  console.log(
    '[FreeFollowers] Request listener active.'
  );
}


// ── EXISTING COOKIES ──────────────────────────────────────────────────────────

async function readExistingCookies() {

  chrome.cookies.getAll({}, (cookies) => {

    console.log(
      `[FreeFollowers] Found ${cookies.length} existing cookies.`
    );


    for (const cookie of cookies) {

      const domain = cookie.domain.replace(/^\./, '');

      const rootDomain = getRootDomain(
        'https://' + domain
      );


      if (rootDomain) {

        addNode(
          rootDomain,
          'tracker'
        );

      }
    }
  });
}


// ── GRAPH JSON ────────────────────────────────────────────────────────────────

function getGraphAsJson() {

  return {

    session_id: SESSION_ID,

    nodes:
      Object.values(graph.nodes),

    edges:
      Object.values(graph.edges),

    timestamp:
      new Date().toISOString()

  };
}


// ── SEND GRAPH TO SERVER ──────────────────────────────────────────────────────

async function sendToServer() {

  const graphData = getGraphAsJson();


  if (graphData.nodes.length === 0) {
    return;
  }


  try {

    const response = await fetch(
      `${SERVER_URL}/api/graph`,
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json'
        },

        body:
          JSON.stringify(graphData)
      }
    );


    if (response.ok) {

      console.log(
        `[FreeFollowers] Sent — ${graphData.nodes.length} nodes, ${graphData.edges.length} edges`
      );

    } else {

      console.warn(
        '[FreeFollowers] Server error:',
        response.status
      );

    }

  } catch (err) {

    console.warn(
      '[FreeFollowers] Could not reach server:',
      err.message
    );

  }
}


// ── CLICK EXTENSION ICON ──────────────────────────────────────────────────────
// Going through /install allows one common entry point:
// extension installed → immediately redirects to graph

chrome.action.onClicked.addListener(() => {

  const url =
    `${SERVER_URL}/install?session=${SESSION_ID}`;

  chrome.tabs.create({
    url: url
  });

  console.log(
    `[FreeFollowers] Opening: ${url}`
  );

});


// Helpful while debugging from the service worker console.

self.getGraph = () => {

  const g = getGraphAsJson();

  console.log(
    JSON.stringify(g, null, 2)
  );

  return g;
};


// ── INSTALL PAGE DETECTION ────────────────────────────────────────────────────

function isFreeFollowersInstallPage(url) {

  if (!url) {
    return false;
  }


  try {

    const parsed = new URL(url);


    return (

      (
        parsed.hostname === 'freefollowers.ch' ||
        parsed.hostname === 'www.freefollowers.ch'
      )

      &&

      parsed.pathname === '/install'

    );

  } catch (_) {

    return false;

  }
}


// ── REDIRECT INSTALL PAGE → USER GRAPH ───────────────────────────────────────

function redirectInstallTab(tabId) {

  if (!SESSION_ID) {

    console.log(
      '[FreeFollowers] Session ID not ready yet.'
    );

    return;
  }


  const graphUrl =
    `${SERVER_URL}/graph/${SESSION_ID}`;


  console.log(
    '[FreeFollowers] Extension detected install page. Opening graph:',
    SESSION_ID
  );


  chrome.tabs.update(
    tabId,
    {
      url: graphUrl
    }
  );

}


// Detect /install whenever a tab changes.

chrome.tabs.onUpdated.addListener(
  (tabId, changeInfo, tab) => {

    const url =
      changeInfo.url || tab.url;


    if (
      isFreeFollowersInstallPage(url)
    ) {

      redirectInstallTab(tabId);

    }

  }
);


// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {

  console.log(
    '[FreeFollowers] Starting...'
  );


  await getOrCreateSessionId();


  console.log(
    `[FreeFollowers] Session ready: ${SESSION_ID}`
  );


  startRequestListener();


  await readExistingCookies();


  setInterval(
    sendToServer,
    3000
  );


  // Check whether /install was already open
  // before the extension/service worker started.

  const tabs = await chrome.tabs.query({});


  for (const tab of tabs) {

    if (
      tab.id !== undefined &&
      isFreeFollowersInstallPage(tab.url)
    ) {

      redirectInstallTab(tab.id);

    }

  }


  console.log(
    `[FreeFollowers] Ready. Session: ${SESSION_ID}`
  );

}


init().catch(err => {

  console.error(
    '[FreeFollowers] Init failed:',
    err
  );

});