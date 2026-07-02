const express = require('express');
const axios = require('axios');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// --- 시스템 상태 및 세팅 값 (기본값) ---
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

// --- 실시간 연산 데이터 스냅샷 ---
let lastData = {
    price: 0, rsi: 0, bbUpper: 0, bbLower: 0, volRatio: 0
};

// 메모리에 5분봉 캔들 데이터를 최대 400개까지 쌓아둘 배열
let localKlines = []; 

// --- 바이비트 실시간 웹소켓 연결 (403 에러 원천 우회) ---
let ws;
function connectWS() {
    // 공용 리니어 웹소켓 엔드포인트
    ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');

    ws.on('open', () => {
        console.log("Bybit WebSocket Connected! Subscribing channels...");
        // 1. 실시간 틱 가격 구독
        ws.send(JSON.stringify({ op: "subscribe", args: ["tickers.BTCUSDT"] }));
        // 2. 실시간 5분봉 캔들 데이터 구독 (HTTP 403 차단을 피하기 위한 핵심)
        ws.send(JSON.stringify({ op: "subscribe", args: ["kline.5.BTCUSDT"] }));
    });

    ws.on('message', (data) => {
        const msg = JSON.parse(data);

        // [A] 실시간 가격 동기화
        if (msg.topic === 'tickers.BTCUSDT' && msg.data.lastPrice) {
            lastData.price = parseFloat(msg.data.lastPrice);
            // 실시간 가격이 들어올 때마다 감시 조건 충족 여부 상시 체크
            if (config.isSystemRunning && localKlines.length >= 200) {
                checkStrategyRealtime();
            }
        }

        // [B] 실시간 5분봉 데이터 수신 및 메모리 갱신
        if (msg.topic === 'kline.5.BTCUSDT' && msg.data && msg.data.length > 0) {
            const k = msg.data[0];
            const candle = {
                start: parseInt(k.start),
                open: parseFloat(k.open),
                high: parseFloat(k.high),
                low: parseFloat(k.low),
                close: parseFloat(k.close),
                volume: parseFloat(k.volume),
                confirm: k.confirm // true면 해당 5분봉 완전히 마감됨 의미
            };

            updateLocalKlines(candle);
        }
    });

    ws.on('close', () => {
        console.log("WebSocket closed. Reconnecting in 5s...");
        setTimeout(connectWS, 5000);
    });

    ws.on('error', (err) => {
        console.error("WebSocket Error:", err.message);
    });
}

// 수신된 웹소켓 캔들 정보를 큐(Queue) 형태로 메모리에 누적하는 함수
function updateLocalKlines(candle) {
    if (localKlines.length === 0) {
        localKlines.push(candle);
        return;
    }

    const lastIdx = localKlines.length - 1;
    // 같은 시간대의 캔들이면 실시간 실시간 데이터 갱신 (진행 중인 봉)
    if (localKlines[lastIdx].start === candle.start) {
        localKlines[lastIdx] = candle;
    } else {
        // 새로운 시간대의 봉이 시작되면 기존 배열에 추가
        localKlines.push(candle);
        // 메모리 최적화를 위해 최대 410개까지만 유지하고 오래된 건 버림
        if (localKlines.length > 410) {
            localKlines.shift();
        }
    }
}

// --- 실시간 전략 계산기 (메모리 내부 연산) ---
function checkStrategyRealtime() {
    try {
        // 현재 마감 완료된 봉들과 현재 실시간 진행 중인 봉 분리
        const closedCandles = localKlines.filter(k => k.confirm === true);
        if (closedCandles.length < 200) {
            // 초기 데이터 빌드업 중에는 계산 스킵
            return;
        }

        const closes = closedCandles.map(k => k.close);
        const highs = closedCandles.map(k => k.high);
        const lows = closedCandles.map(k => k.low);
        const volumes = closedCandles.map(k => k.volume);

        const currentPrice = lastData.price;
        const currentHigh = localKlines[localKlines.length - 1].high;
        const currentLow = localKlines[localKlines.length - 1].low;
        const currentVol = localKlines[localKlines.length - 1].volume;

        // 1. RSI 계산
        const rsi = calcRSI(closes);
        
        // 2. 볼린저밴드 계산
        const period = Math.min(config.bbPeriod, closes.length);
        const slice = closes.slice(-period);
        const ma = slice.reduce((a, b) => a + b, 0) / slice.length;
        const variance = slice.reduce((a, b) => a + Math.pow(b - ma, 2), 0) / slice.length;
        const stdDev = Math.sqrt(variance);
        const upper = ma + (config.bbStd * stdDev);
        const lower = ma - (config.bbStd * stdDev);

        // 3. 거래량 MA 계산
        const volPeriod = Math.min(config.volMaPeriod, volumes.length);
        const volSlice = volumes.slice(-volPeriod);
        const volMa = volSlice.reduce((a, b) => a + b, 0) / volSlice.length;
        const volRatio = volMa > 0 ? (currentVol / volMa) : 1;

        // 전역 전송 데이터 스냅샷 최신화
        lastData.rsi = rsi;
        lastData.bbUpper = upper;
        lastData.bbLower = lower;
        lastData.volRatio = volRatio;

        // 4. 감시 조건 평가 레이어
        let match = true;
        if (config.priceAtv) match = match && (config.priceType === 'above' ? currentPrice >= config.priceVal : currentPrice <= config.priceVal);
        if (config.rsiAtv) match = match && (config.rsiType === 'above' ? rsi >= config.rsiVal : rsi <= config.rsiVal);
        if (config.bbUpperAtv) match = match && (config.bbUpperTarget === 'close' ? currentPrice >= upper : currentHigh >= upper);
        if (config.bbLowerAtv) match = match && (config.bbLowerTarget === 'close' ? currentPrice <= lower : currentLow <= lower);
        if (config.volAtv) match = match && (volRatio >= config.volRatio);

        // 중복 알림 방지를 걸지 않으면 1초에 수십 번 오므로, 마감 봉 기준 조건 충족 시 알림 트리거 (간소화 빌드)
        if (match && !global.lastAlertTime) {
            // 임시 마감봉 타임스탬프 기준으로 중복 알림 최소 방어 (5분당 1회 제한 등 확장 가능)
            global.lastAlertTime = Date.now();
            sendTelegramAlert(currentPrice, rsi, volRatio);
            setTimeout(() => { global.lastAlertTime = null; }, 60000); // 1분간 중복 알림 잠금
        }

    } catch (e) {
        console.error("Calculation Engine Error:", e.message);
    }
}

function calcRSI(prices) {
    if(prices.length < 15) return 50;
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

function sendTelegramAlert(p, r, v) {
    const text = `🚨 [원격 무중단 감시 알람]\n노드 태그: ${config.windowAlias}\n현재 가격: ${p.toLocaleString()} USDT\nRSI 지표: ${r.toFixed(1)}\n거래량 비율: ${v.toFixed(1)}x`;
    axios.post(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
        chat_id: config.telegramChatId, text: text
    }).catch(e => console.error("Telegram API Delivery Failed"));
}

// 앱 구동 시 웹소켓 엔진 자동 시동
connectWS();

// --- 외부 API 제어 엔드포인트 ---
app.get('/api/config', (req, res) => res.json({ config, lastData }));
app.post('/api/config', (req, res) => {
    config = { ...config, ...req.body };
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Tactical Cloud Node Running on port ${PORT}`));
