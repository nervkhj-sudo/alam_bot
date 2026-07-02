const express = require('express');
const axios = require('axios');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public')); // HTML 파일 위치

// --- 시스템 상태 저장 (메모리) ---
let config = {
    isSystemRunning: false,
    side: 'short',
    windowAlias: '원격 작전 노드',
    priceAtv: false, priceType: 'above', priceVal: 0,
    rsiAtv: false, rsiType: 'above', rsiVal: 70,
    bbUpperAtv: true, bbUpperTarget: 'high',
    bbLowerAtv: false, bbLowerTarget: 'low',
    volAtv: true, volMaPeriod: 30, volRatio: 1.5,
    bbPeriod: 200, bbStd: 2,
    telegramToken: '8604547123:AAHHMCuOrMnaA7uSZ_DwH-z-s1QOm6xIpr0',
    telegramChatId: '8831296135'
};

let lastData = {
    price: 0, rsi: 0, bbUpper: 0, bbLower: 0, volRatio: 0, countdown: ''
};

// --- 바이비트 실시간 가격 (WebSocket) ---
let ws;
function connectWS() {
    ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');
    ws.on('open', () => ws.send(JSON.stringify({ op: "subscribe", args: ["tickers.BTCUSDT"] })));
    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.topic === 'tickers.BTCUSDT' && msg.data.lastPrice) {
            lastData.price = parseFloat(msg.data.lastPrice);
        }
    });
    ws.on('close', () => setTimeout(connectWS, 5000));
}
connectWS();

// --- 기술 지표 계산 및 감시 루프 ---
async function checkStrategy() {
    if (!config.isSystemRunning) return;

    try {
        const res = await axios.get('https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=5&limit=400', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
});
        const klines = res.data.result.list.reverse();
        const closed = klines.slice(0, -1);
        const closes = closed.map(k => parseFloat(k[4]));
        const highs = closed.map(k => parseFloat(k[2]));
        const lows = closed.map(k => parseFloat(k[3]));
        const volumes = closed.map(k => parseFloat(k[5]));

        const currentPrice = closes[closes.length - 1];
        const currentHigh = highs[highs.length - 1];
        const currentLow = lows[lows.length - 1];
        const currentVol = volumes[volumes.length - 1];

        // RSI 계산
        const rsi = calcRSI(closes);
        // BB 계산
        const slice = closes.slice(-config.bbPeriod);
        const ma = slice.reduce((a, b) => a + b, 0) / slice.length;
        const variance = slice.reduce((a, b) => a + Math.pow(b - ma, 2), 0) / slice.length;
        const stdDev = Math.sqrt(variance);
        const upper = ma + (config.bbStd * stdDev);
        const lower = ma - (config.bbStd * stdDev);

        // 거래량 MA
        const volSlice = volumes.slice(-config.volMaPeriod);
        const volMa = volSlice.reduce((a, b) => a + b, 0) / volSlice.length;
        const volRatio = currentVol / volMa;

        lastData.rsi = rsi; lastData.bbUpper = upper; lastData.bbLower = lower; lastData.volRatio = volRatio;

        // 조건 검사
        let match = true;
        if (config.priceAtv) match = match && (config.priceType === 'above' ? currentPrice >= config.priceVal : currentPrice <= config.priceVal);
        if (config.rsiAtv) match = match && (config.rsiType === 'above' ? rsi >= config.rsiVal : rsi <= config.rsiVal);
        if (config.bbUpperAtv) match = match && (config.bbUpperTarget === 'close' ? currentPrice >= upper : currentHigh >= upper);
        if (config.bbLowerAtv) match = match && (config.bbLowerTarget === 'close' ? currentPrice <= lower : currentLow <= lower);
        if (config.volAtv) match = match && (volRatio >= config.volRatio);

        if (match) sendAlert(currentPrice, rsi, volRatio);

    } catch (e) { console.error("Monitor Error:", e.message); }
}

function calcRSI(prices) {
    let gains = 0, losses = 0;
    for (let i = 1; i <= 14; i++) {
        let diff = prices[i] - prices[i - 1];
        if (diff > 0) gains += diff; else losses -= diff;
    }
    let avgG = gains / 14, avgL = losses / 14;
    for (let i = 15; i < prices.length; i++) {
        let diff = prices[i] - prices[i - 1];
        avgG = (avgG * 13 + (diff > 0 ? diff : 0)) / 14;
        avgL = (avgL * 13 + (diff < 0 ? -diff : 0)) / 14;
    }
    return 100 - (100 / (1 + (avgG / avgL)));
}

function sendAlert(p, r, v) {
    const text = `🚨 [원격 감시 알람]\n노드: ${config.windowAlias}\n가격: ${p.toLocaleString()} USDT\nRSI: ${r.toFixed(1)}\n거래량: ${v.toFixed(1)}x`;
    axios.post(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
        chat_id: config.telegramChatId, text: text
    }).catch(e => console.error("Telegram Fail"));
}

// 5분봉 마감 직후 체크를 위해 10초마다 루프 (중복 방지 로직 필요하나 여기선 간소화)
setInterval(checkStrategy, 30000);

// --- API 엔드포인트 (대시보드 통신용) ---
app.get('/api/config', (req, res) => res.json({ config, lastData }));
app.post('/api/config', (req, res) => {
    config = { ...config, ...req.body };
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
