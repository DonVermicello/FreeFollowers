// ─────────────────────────────────────────────────────────────────────────────
// FreeFollowers — background.js
//
// Tracks:
//   1) third-party domains contacted while browsing
//   2) cookies sent/set during browsing
//   3) cookie domains that already existed when FreeFollowers started
//
// Cookie VALUES are never sent to the Flask server.
// ─────────────────────────────────────────────────────────────────────────────

const SERVER_BASE = 'http://127.0.0.1:5000';
const SESSION_ID = 'demo';

const STORAGE_KEYS = {
  baseline: 'ff_existing_cookie_domains',
  nodes: 'ff_live_nodes',
  edges: 'ff_live_edges',
  initialised: 'ff_initialised'
};

let existingCookieDomains = [];

let nodeMap = new Map();
let edgeMap = new Map();

// Remember which top-level website belongs to each tab.
let tabSites = new Map();

let postTimer = null;
let initPromise = null;


// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function hostnameFromUrl(value) {

  if (!value) {
    return null;
  }

  try {

    return new URL(value)
      .hostname
      .toLowerCase()
      .replace(/^www\./, '');

  } catch (_) {

    return null;

  }
}


function normaliseCookieDomain(domain) {

  return String(domain || '')
    .trim()
    .toLowerCase()
    .replace(/^\./, '')
    .replace(/^www\./, '');
}


function isHttpUrl(value) {

  return /^https?:\/\//i.test(
    String(value || '')
  );
}


function isInternalDomain(domain) {

  return (
    domain === '127.0.0.1' ||
    domain === 'localhost'
  );
}


// Determine which website caused a request.
function sourceForRequest(details) {

  // Usually the best source.
  const initiator =
    hostnameFromUrl(details.initiator);

  if (initiator) {
    return initiator;
  }


  // Sometimes available instead.
  const documentUrl =
    hostnameFromUrl(details.documentUrl);

  if (documentUrl) {
    return documentUrl;
  }


  // Fall back to the last top-level page
  // we saw in this browser tab.
  if (
    typeof details.tabId === 'number' &&
    details.tabId >= 0
  ) {

    return tabSites.get(details.tabId) || null;

  }


  return null;
}


// ─────────────────────────────────────────────────────────────────────────────
// GRAPH DATA
// ─────────────────────────────────────────────────────────────────────────────

function addNode(id, type) {

  if (!id) {
    return;
  }


  const old =
    nodeMap.get(id);


  if (old) {

    old.count =
      (old.count || 1) + 1;


    // A domain that is directly visited
    // should always remain a site node.
    if (type === 'site') {
      old.type = 'site';
    }


    return;
  }


  nodeMap.set(
    id,
    {
      id,
      type,
      count: 1
    }
  );
}


function addOrUpdateEdge(
  source,
  target,
  observationType,
  cookieNames = []
) {

  if (
    !source ||
    !target ||
    source === target
  ) {
    return;
  }


  const id =
    `${source}→${target}`;


  const old =
    edgeMap.get(id);


  if (old) {

    old.count =
      (old.count || 1) + 1;


    old.observationTypes =
      Array.from(
        new Set([
          ...(old.observationTypes || []),
          ...(observationType
            ? [observationType]
            : [])
        ])
      );


    old.cookies =
      Array.from(
        new Set([
          ...(old.cookies || []),
          ...(cookieNames || [])
        ])
      ).slice(0, 50);


    return;
  }


  edgeMap.set(
    id,
    {

      id,

      source,

      target,

      count: 1,

      cookies:
        Array.from(
          new Set(cookieNames || [])
        ).slice(0, 50),

      observationTypes:
        observationType
          ? [observationType]
          : []

    }
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// NORMAL NETWORK REQUEST
//
// This restores the behaviour that made the graph actually fill up.
//
// Example:
//
// nytimes.com
//      ↓
// doubleclick.net
//
// We record the relationship even if Edge blocks the third-party cookie.
// ─────────────────────────────────────────────────────────────────────────────

function observeNetworkRequest(details) {

  if (!isHttpUrl(details.url)) {
    return;
  }


  const target =
    hostnameFromUrl(details.url);


  if (
    !target ||
    isInternalDomain(target)
  ) {
    return;
  }


  // User navigated directly to a website.
  if (details.type === 'main_frame') {

    if (
      typeof details.tabId === 'number' &&
      details.tabId >= 0
    ) {

      tabSites.set(
        details.tabId,
        target
      );

    }


    addNode(
      target,
      'site'
    );


    scheduleSaveAndPost();

    return;
  }


  const source =
    sourceForRequest(details);


  if (
    !source ||
    isInternalDomain(source) ||
    source === target
  ) {
    return;
  }


  addNode(
    source,
    'site'
  );


  addNode(
    target,
    'tracker'
  );


  addOrUpdateEdge(
    source,
    target,
    'request'
  );


  scheduleSaveAndPost();
}


// ─────────────────────────────────────────────────────────────────────────────
// COOKIE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function cookieNamesFromHeader(headerValue) {

  if (!headerValue) {
    return [];
  }


  return headerValue
    .split(';')
    .map(
      part =>
        part
          .trim()
          .split('=')[0]
    )
    .filter(Boolean);
}


function cookieNameFromSetCookie(headerValue) {

  if (!headerValue) {
    return null;
  }


  const first =
    headerValue.split(';', 1)[0];


  const eq =
    first.indexOf('=');


  if (eq <= 0) {
    return null;
  }


  return (
    first
      .slice(0, eq)
      .trim()
    || null
  );
}


// Add cookie information to an already-observed
// site → third-party relationship.
function attachCookiesToRequest(
  details,
  cookieNames,
  observationType
) {

  if (
    !cookieNames ||
    cookieNames.length === 0 ||
    !isHttpUrl(details.url)
  ) {
    return;
  }


  const target =
    hostnameFromUrl(details.url);


  const source =
    sourceForRequest(details);


  if (
    !source ||
    !target ||
    source === target ||
    isInternalDomain(source) ||
    isInternalDomain(target)
  ) {
    return;
  }


  addNode(
    source,
    'site'
  );


  addNode(
    target,
    'tracker'
  );


  addOrUpdateEdge(
    source,
    target,
    observationType,
    cookieNames
  );


  scheduleSaveAndPost();
}


// ─────────────────────────────────────────────────────────────────────────────
// EXISTING COOKIE BASELINE
//
// Reads cookies that were already in Edge before this session.
//
// We only keep:
//
// domain
// cookie count
//
// NOT cookie values.
// ─────────────────────────────────────────────────────────────────────────────

async function collectExistingCookieBaseline() {

  const cookies =
    await chrome.cookies.getAll({});


  const counts =
    new Map();


  for (const cookie of cookies) {

    const domain =
      normaliseCookieDomain(
        cookie.domain
      );


    if (
      !domain ||
      isInternalDomain(domain)
    ) {
      continue;
    }


    counts.set(
      domain,
      (counts.get(domain) || 0) + 1
    );

  }


  return Array
    .from(
      counts.entries()
    )
    .map(
      ([domain, count]) => ({
        domain,
        count
      })
    )
    .sort(
      (a, b) =>
        a.domain.localeCompare(
          b.domain
        )
    );
}


// ─────────────────────────────────────────────────────────────────────────────
// NEW BROWSER SESSION
// ─────────────────────────────────────────────────────────────────────────────

async function startNewBrowserSession() {

  existingCookieDomains =
    await collectExistingCookieBaseline();


  nodeMap =
    new Map();


  edgeMap =
    new Map();


  tabSites =
    new Map();


  await chrome.storage.local.set({

    [STORAGE_KEYS.baseline]:
      existingCookieDomains,

    [STORAGE_KEYS.nodes]:
      [],

    [STORAGE_KEYS.edges]:
      [],

    [STORAGE_KEYS.initialised]:
      true

  });


  // Immediately send the existing-cookie
  // baseline to Flask even though the
  // live graph is still empty.

  await postGraph();
}


// ─────────────────────────────────────────────────────────────────────────────
// INITIALISE
// ─────────────────────────────────────────────────────────────────────────────

async function ensureInitialised() {

  if (initPromise) {
    return initPromise;
  }


  initPromise = (async () => {

    const stored =
      await chrome.storage.local.get(
        Object.values(
          STORAGE_KEYS
        )
      );


    if (
      !stored[
        STORAGE_KEYS.initialised
      ]
    ) {

      await startNewBrowserSession();

      return;
    }


    existingCookieDomains =
      Array.isArray(
        stored[
          STORAGE_KEYS.baseline
        ]
      )

        ? stored[
            STORAGE_KEYS.baseline
          ]

        : [];


    const storedNodes =
      Array.isArray(
        stored[
          STORAGE_KEYS.nodes
        ]
      )

        ? stored[
            STORAGE_KEYS.nodes
          ]

        : [];


    const storedEdges =
      Array.isArray(
        stored[
          STORAGE_KEYS.edges
        ]
      )

        ? stored[
            STORAGE_KEYS.edges
          ]

        : [];


    nodeMap =
      new Map(
        storedNodes.map(
          node => [
            node.id,
            node
          ]
        )
      );


    edgeMap =
      new Map(
        storedEdges.map(
          edge => [
            edge.id,
            edge
          ]
        )
      );


    // Flask may have been restarted,
    // so send our stored graph again.

    await postGraph();

  })().catch(err => {

    console.error(
      '[FreeFollowers] initialisation failed',
      err
    );

    initPromise = null;

  });


  return initPromise;
}


// ─────────────────────────────────────────────────────────────────────────────
// SAVE + POST
// ─────────────────────────────────────────────────────────────────────────────

function scheduleSaveAndPost() {

  if (postTimer) {
    return;
  }


  postTimer =
    setTimeout(

      async () => {

        postTimer = null;


        try {

          await chrome.storage.local.set({

            [STORAGE_KEYS.nodes]:
              Array.from(
                nodeMap.values()
              ),

            [STORAGE_KEYS.edges]:
              Array.from(
                edgeMap.values()
              )

          });


          await postGraph();

        } catch (err) {

          console.warn(
            '[FreeFollowers] could not save/post graph',
            err
          );

        }

      },

      500

    );
}


async function postGraph() {

  const payload = {

    session_id:
      SESSION_ID,

    nodes:
      Array.from(
        nodeMap.values()
      ),

    edges:
      Array.from(
        edgeMap.values()
      ),

    existing_cookie_domains:
      existingCookieDomains

  };


  try {

    const response =
      await fetch(
        `${SERVER_BASE}/api/graph`,
        {

          method:
            'POST',

          headers: {
            'Content-Type':
              'application/json'
          },

          body:
            JSON.stringify(payload)

        }
      );


    if (!response.ok) {

      console.warn(
        '[FreeFollowers] server returned',
        response.status
      );

    }

  } catch (err) {

    console.debug(
      '[FreeFollowers] server unavailable',
      err.message
    );

  }
}


// ─────────────────────────────────────────────────────────────────────────────
// LISTEN TO EVERY NETWORK REQUEST
//
// This is the important part that restores the graph.
// ─────────────────────────────────────────────────────────────────────────────

chrome.webRequest
  .onBeforeRequest
  .addListener(

    details => {

      ensureInitialised()
        .then(() => {

          observeNetworkRequest(
            details
          );

        });

    },

    {
      urls: [
        '<all_urls>'
      ]
    }

  );


// ─────────────────────────────────────────────────────────────────────────────
// COOKIE HEADER SENT
// ─────────────────────────────────────────────────────────────────────────────

chrome.webRequest
  .onBeforeSendHeaders
  .addListener(

    details => {

      ensureInitialised()
        .then(() => {

          const cookieHeader =
            (
              details.requestHeaders ||
              []
            )
            .find(

              h =>
                String(
                  h.name || ''
                )
                .toLowerCase()
                ===
                'cookie'

            );


          if (
            !cookieHeader ||
            !cookieHeader.value
          ) {
            return;
          }


          attachCookiesToRequest(

            details,

            cookieNamesFromHeader(
              cookieHeader.value
            ),

            'cookie-sent'

          );

        });

    },

    {
      urls: [
        '<all_urls>'
      ]
    },

    [
      'requestHeaders',
      'extraHeaders'
    ]

  );


// ─────────────────────────────────────────────────────────────────────────────
// SET-COOKIE RESPONSE
// ─────────────────────────────────────────────────────────────────────────────

chrome.webRequest
  .onHeadersReceived
  .addListener(

    details => {

      ensureInitialised()
        .then(() => {

          const names =
            (
              details.responseHeaders ||
              []
            )

            .filter(

              h =>
                String(
                  h.name || ''
                )
                .toLowerCase()
                ===
                'set-cookie'

            )

            .map(

              h =>
                cookieNameFromSetCookie(
                  h.value
                )

            )

            .filter(Boolean);


          if (
            names.length === 0
          ) {
            return;
          }


          attachCookiesToRequest(

            details,

            names,

            'cookie-set'

          );

        });

    },

    {
      urls: [
        '<all_urls>'
      ]
    },

    [
      'responseHeaders',
      'extraHeaders'
    ]

  );


// ─────────────────────────────────────────────────────────────────────────────
// TAB CLEANUP
// ─────────────────────────────────────────────────────────────────────────────

chrome.tabs
  .onRemoved
  .addListener(
    tabId => {

      tabSites.delete(
        tabId
      );

    }
  );


// ─────────────────────────────────────────────────────────────────────────────
// EXTENSION RELOAD / INSTALL
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime
  .onInstalled
  .addListener(() => {

    initPromise = null;


    startNewBrowserSession()
      .catch(

        err =>
          console.error(
            '[FreeFollowers] install baseline failed',
            err
          )

      );

  });


// ─────────────────────────────────────────────────────────────────────────────
// EDGE STARTUP
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime
  .onStartup
  .addListener(() => {

    initPromise = null;


    startNewBrowserSession()
      .catch(

        err =>
          console.error(
            '[FreeFollowers] startup baseline failed',
            err
          )

      );

  });


// ─────────────────────────────────────────────────────────────────────────────
// EXTENSION ICON
// ─────────────────────────────────────────────────────────────────────────────

chrome.action
  .onClicked
  .addListener(() => {

    chrome.tabs.create({

      url:
        `${SERVER_BASE}/graph/${SESSION_ID}`

    });

  });


ensureInitialised();