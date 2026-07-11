var http = require('http');

var PORT = process.env.PORT || 8080;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function handleAction(msg) {
  var action = msg.action || 'unknown';
  console.log('[relay] action=' + action);

  var response = {
    action: 'response',
    requestAction: action,
    ts: Date.now(),
    from: 'railway-relay',
  };

  if (action === 'ping') {
    response.ok = true;
    response.message = 'pong from Railway';
    return Promise.resolve(response);

  } else if (action === 'fetch') {
    var targetUrl = msg.url;
    console.log('[relay] fetching: ' + targetUrl);
    var headers = Object.assign(
      { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json, */*' },
      msg.headers || {}
    );
    return fetch(targetUrl, { headers: headers })
      .then(function(r) {
        var status = r.status;
        return r.text().then(function(text) {
          var data;
          try { data = JSON.parse(text); } catch (e) { data = text.substring(0, 5000); }
          response.ok = true;
          response.status = status;
          response.data = data;
          console.log('[relay] fetch ok: ' + status);
          return response;
        });
      })
      .catch(function(err) {
        response.ok = false;
        response.error = err.message;
        console.error('[relay] fetch failed: ' + err.message);
        return response;
      });

  } else if (action === 'data') {
    var payload = msg.payload || {};
    console.log('[relay] page data: url=' + payload.url);
    response.ok = true;
    response.message = 'received';
    response.echo = { url: payload.url, title: payload.title };
    return Promise.resolve(response);

  } else {
    response.ok = false;
    response.message = 'unknown action: ' + action;
    return Promise.resolve(response);
  }
}

var server = http.createServer(function(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'railway-relay', ts: Date.now() }));
    return;
  }

  if (req.url === '/relay' && req.method === 'POST') {
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      var msg;
      try {
        msg = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }));
        return;
      }
      handleAction(msg).then(function(result) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      }).catch(function(err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    });
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

server.listen(PORT, function() {
  console.log('[server] Railway relay on port ' + PORT);
});
