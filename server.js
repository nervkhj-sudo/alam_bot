const express = require('express');
const axios = require('axios');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// --- 전역 설정 및 실시간 지표 데이터 박스 ---
let config = {
    isSystemRunning: false,
    side: 'short',
    windowAlias: '원격 작전 노드',
    priceAtv: false, priceType: 'above', priceVal: 0,
    rsiAtv: false, rsiType: 'below', rsiVal: 30,
    bbUpperAtv: false, bbUpperTarget: 'high',
    bbLowerAtv: true, bbLowerTarget: 'low',
    volAtv: true, volMaPeriod: 30, volRatio: 1.5,
    bbPeriod: 200, bbStd: 2,
    telegramToken: '8604547123:AAHHMCuOrMnaA7uSZ_DwH-z-s1QOm6xIpr0',
    telegramChatId: '8831296135'
};

let lastData = {
    price: 0, rsi: 0, bbUpper: 0, bbLower: 0, volRatio: 0
};

// --- 바이비트 5분봉 기반 지표 동기화 엔진 (가장 쉽게 읽히는 구조) ---
async function updateIndicators() {
    try {
        const url = 'https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=5&limit=50';
        const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        
        if (res.data && res.data.result && res.data.result.list) {
            const list = res.data.result.list; 
            const closes = list.map(c => parseFloat(c[4])).reverse(); // 종가 모음
            const volumes = list.map(c => parseFloat(c[5])).reverse(); // 거래량 모음
            
            // 1. 단순 RSI(14) 계산식
            let gains = 0, losses = 0;
            for (let i = closes.length - 14; i < closes.length; i++) {
                let diff = closes[i] - closes[i-1];
                if (diff > 0) gains += diff; else losses -= diff;
            }
            lastData.rsi = losses === 0 ? 100 : 100 - (100 / (1 + (gains / losses)));

            // 2. 볼린저 밴드 계산식 (최근 20개 종가 기준 평균 및 표준편차)
            const sample = closes.slice(-20);
            const ma = sample.reduce((a, b) => a + b, 0) / sample.length;
            const variance = sample.reduce((a, b) => a + Math.pow(b - ma, 2), 0) / sample.length;
            const std = Math.sqrt(variance);
            
            lastData.bbUpper = ma + (config.bbStd * std);
            lastData.bbLower = ma - (config.bbStd * std);

            // 3. 거래량 MA 비율 계산식
            const prevVols = volumes.slice(-6, -1);
            const volMa = prevVols.reduce((a, b) => a + b, 0) / prevVols.length;
            lastData.volRatio = volMa > 0 ? (volumes[volumes.length - 1] / volMa) : 1;
        }
    } catch (e) {
        // 에러 발생 시 부드럽게 무시하고 다음 루프로 진행
    }
}

// --- 실시간 가격 웹소켓 ---
function connectWebSocket() {
    const ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');

    ws.on('open', () => {
        ws.send(JSON.stringify({ op: "subscribe", args: ["tickers.BTCUSDT"] }));
    });

    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.topic === 'tickers.BTCUSDT' && msg.data.lastPrice) {
            lastData.price = parseFloat(msg.data.lastPrice);
            if (config.isSystemRunning) {
                checkAlertTrigger();
            }
        }
    });

    ws.on('close', () => setTimeout(connectWebSocket, 5000));
}

let lastTelegramTime = 0;
function checkAlertTrigger() {
    let match = true;
    if (config.priceAtv) match = match && (config.priceType === 'above' ? lastData.price >= config.priceVal : lastData.price <= config.priceVal);
    if (config.rsiAtv && lastData.rsi > 0) match = match && (config.rsiType === 'above' ? lastData.rsi >= config.rsiVal : lastData.rsi <= config.rsiVal);
    if (config.bbUpperAtv && lastData.bbUpper > 0) match = match && (lastData.price >= lastData.bbUpper);
    if (config.bbLowerAtv && lastData.bbLower > 0) match = match && (lastData.price <= lastData.bbLower);
    if (config.volAtv && lastData.volRatio > 0) match = match && (lastData.volRatio >= config.volRatio);

    // 조건 만족 시 3분에 1번씩만 텔레그램 발송 중복 제한
    if (match && (Date.now() - lastTelegramTime > 180000)) {
        lastTelegramTime = Date.now();
        const text = `🚨 [원격 알람 성립]\n노드: ${config.windowAlias}\n현재가: ${lastData.price.toLocaleString()} USDT\nRSI: ${lastData.rsi.toFixed(1)}`;
        axios.post(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
            chat_id: config.telegramChatId, text: text
        }).catch(() => {});
    }
}

// 루프 가동 (10초마다 지표 세팅값 갱신)
setInterval(updateIndicators, 10000);
updateIndicators();
connectWebSocket();

app.get('/api/config', (req, res) => res.json({ config, lastData }));
app.post('/api/config', (req, res) => {
    config = { ...config, ...req.body };
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
