# ─────────────────────────────────────────────────────────────────────────────
# FreeFollowers — app.py
# Flask backend that receives graph data from the browser extension
# and serves it back to the visualisation page.
# ─────────────────────────────────────────────────────────────────────────────

from flask import Flask, request, jsonify, render_template, send_from_directory
from flask_cors import CORS
from datetime import datetime, timedelta
import threading
import time
import json
import os

app = Flask(__name__)
CORS(app)


# ── IN-MEMORY SESSION STORE ───────────────────────────────────────────────────
# Key = session_id (the prototype uses "demo")
# Value = live graph + baseline cookie-domain snapshot.
sessions = {}
sessions_lock = threading.Lock()
SESSION_TTL = timedelta(hours=2)


def utc_now_iso():
    return datetime.utcnow().isoformat() + 'Z'


def parse_iso(value):
    if not value:
        return datetime.utcnow()

    try:
        return datetime.fromisoformat(value.replace('Z', ''))
    except Exception:
        return datetime.utcnow()


# ── PAGES ─────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/graph/<session_id>')
def graph_page(session_id):
    return send_from_directory('static', 'graph.html')


# ── DISCONNECT TRACKER DATABASE ────────────────────────────────────────────────

@app.route('/api/services')
def services():

    services_path = os.path.join(
        app.root_path,
        'static',
        'services.json'
    )

    if not os.path.exists(services_path):

        return jsonify({
            'error': 'static/services.json not found'
        }), 404

    try:

        with open(
            services_path,
            'r',
            encoding='utf-8'
        ) as f:

            data = json.load(f)

        return jsonify(data)

    except json.JSONDecodeError as exc:

        return jsonify({
            'error': 'static/services.json is not valid JSON',
            'details': str(exc)
        }), 500


# ── GRAPH API ─────────────────────────────────────────────────────────────────

@app.route('/api/graph', methods=['POST'])
def receive_graph():

    """
    Receive current graph data from the browser extension.

    Old payload:
        {
            session_id,
            nodes,
            edges
        }

    New payload additionally contains:

        existing_cookie_domains: [
            {
                "domain": "doubleclick.net",
                "count": 4
            }
        ]

    Only domain + cookie count are stored.
    Cookie values are never sent to the server.
    """

    payload = request.get_json(silent=True) or {}

    session_id = str(
        payload.get('session_id') or ''
    ).strip()

    if not session_id:

        return jsonify({
            'error': 'session_id is required'
        }), 400


    nodes = payload.get('nodes')
    edges = payload.get('edges')


    if not isinstance(nodes, list):
        nodes = []

    if not isinstance(edges, list):
        edges = []


    with sessions_lock:

        previous = sessions.get(
            session_id,
            {}
        )


        # Preserve existing-cookie baseline if an older
        # extension POST does not include it.

        existing_cookie_domains = payload.get(
            'existing_cookie_domains',
            None
        )


        if existing_cookie_domains is None:

            existing_cookie_domains = previous.get(
                'existing_cookie_domains',
                []
            )

        elif not isinstance(
            existing_cookie_domains,
            list
        ):

            existing_cookie_domains = []


        created_at = previous.get(
            'created_at',
            utc_now_iso()
        )


        now = utc_now_iso()


        sessions[session_id] = {

            'session_id':
                session_id,

            'nodes':
                nodes,

            'edges':
                edges,

            'existing_cookie_domains':
                existing_cookie_domains,

            'created_at':
                created_at,

            'last_updated':
                now

        }


    return jsonify({

        'status':
            'ok',

        'session_id':
            session_id,

        'nodes':
            len(nodes),

        'edges':
            len(edges),

        'existing_cookie_domains':
            len(existing_cookie_domains)

    })


@app.route(
    '/api/graph/<session_id>',
    methods=['GET']
)
def get_graph(session_id):

    with sessions_lock:

        data = sessions.get(
            session_id
        )


        if not data:

            return jsonify({

                'found':
                    False,

                'session_id':
                    session_id,

                'nodes':
                    [],

                'edges':
                    [],

                'existing_cookie_domains':
                    []

            })


        result = {

            'found':
                True,

            'session_id':
                session_id,

            'nodes':
                list(
                    data.get(
                        'nodes',
                        []
                    )
                ),

            'edges':
                list(
                    data.get(
                        'edges',
                        []
                    )
                ),

            'existing_cookie_domains':
                list(
                    data.get(
                        'existing_cookie_domains',
                        []
                    )
                ),

            'created_at':
                data.get(
                    'created_at'
                ),

            'last_updated':
                data.get(
                    'last_updated'
                )

        }


    return jsonify(result)


# ── CLEANUP OLD SESSIONS ──────────────────────────────────────────────────────

def cleanup_sessions():

    while True:

        time.sleep(300)

        cutoff = (
            datetime.utcnow()
            - SESSION_TTL
        )


        with sessions_lock:

            stale = [

                session_id

                for session_id, data
                in sessions.items()

                if parse_iso(
                    data.get(
                        'last_updated'
                    )
                ) < cutoff

            ]


            for session_id in stale:

                del sessions[
                    session_id
                ]


threading.Thread(
    target=cleanup_sessions,
    daemon=True
).start()


# ── START SERVER ──────────────────────────────────────────────────────────────

if __name__ == '__main__':

    app.run(
        host='127.0.0.1',
        port=5000,
        debug=True
    )