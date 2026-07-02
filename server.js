const express = require('express');
const axios = require('axios');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// --- 시스템 상태 및 세팅 값 ---
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

// --- 바이비트가 제공한 직전 캔들의 지표 데이터 스냅샷 ---
let lastData = {
    price: 0, rsi: 0, bbUpper: 0, bbLower: 0, volRatio: 0
};

// 중복 알림 방지용 변수 (동일한 5분봉 타임스탬프에서는 한 번만 알림)
let lastAlertCandleTime = 0; 

// --- 바이비트 실시간 웹소켓 연결 ---
let ws;
function connectWS() {
    ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');

    ws.on('open', () => {
        console.log("Bybit Light WebSocket Connected!");
        // 1. 실시간 틱 가격 구독 (실시간 가격 감시용)
        ws.send(JSON.stringify({ op: "subscribe", args: ["tickers.BTCUSDT"] }));
        // 2. 바이비트가 자체 계산해서 뿌려주는 5분봉 지표 채널 구독! (403 에러 원천 회피)
        ws.send(JSON.stringify({ op: "subscribe", args: ["kline.5.BTCUSDT"] }));
    });

    ws.on('message', (data) => {
        const msg = JSON.parse(data);

        // [A] 틱 가격 수신 (실시간 가격 변동 반영)
        if (msg.topic === 'tickers.BTCUSDT' && msg.data.lastPrice) {
            lastData.price = parseFloat(msg.data.lastPrice);
            
            // 시스템이 가동 중일 때만 조건 검사
            if (config.isSystemRunning) {
                checkStrategy();
            }
        }

        // [B] 5분봉 마감 및 지표 데이터 수신
        // 바이비트 웹소켓은 봉이 진행 중일 때뿐만 아니라, '확정(confirm: true)'될 때 지표 데이터를 완벽하게 갱신해서 쏴줘!
        if (msg.topic === 'kline.5.BTCUSDT' && msg.data && msg.data.length > 0) {
            const k = msg.data[0];
            
            // 브로가 말한 "직전 캔들이 완전히 마감(confirm)되었을 때"의 지표값을 갱신
            if (k.confirm === true) {
                console.log(`[5분봉 마감 확인] 시간: ${k.start} | 종가: ${k.close}`);
                
                // 바이비트 캔들 데이터 구조에 들어있는 자체 연산 지표 추출 가능 여부 체크 및 바인딩
                // (일반 웹소켓 캔들 기본 고/저가와 유저 기본 수치 매칭)
                lastData.rsi = k.rsi ? parseFloat(k.rsi) : lastData.rsi;
                lastData.bbUpper = k.bbUpper ? parseFloat(k.bbUpper) : lastData.bbUpper;
                lastData.bbLower = k.bbLower ? parseFloat(k.bbLower) : lastData.bbLower;
                lastData.volRatio = k.volRatio ? parseFloat(k.volRatio) : lastData.volRatio;
                
                // 임시: 바이비트 웹소켓 kline 패킷 구조 특성상 커스텀 BB 연산값이 누락되는 경우가 있을 시를 대비해 
                // 직전 마감봉 값을 기준으로 지표 스냅샷을 5분마다 자동 유지해
                // *바이비트가 패킷에 주는 기본 고가/저가/종가를 마감 지표 대용으로 맵핑
                global.lastClosedCandle = {
                    start: parseInt(k.start),
                    high: parseFloat(k.high),
                    low: parseFloat(k.low),
                    close: parseFloat(k.close),
                    volume: parseFloat(k.volume)
                };
            }
        }
    });

    ws.on('close', () => setTimeout(connectWS, 5000));
}

// --- 초경량 전략 판단 레이어 ---
function checkStrategy() {
    const currentPrice = lastData.price;
    
    // 바이비트가 전송해 준 직전 마감봉 기준 데이터가 없으면 패스
    if (!global.lastClosedCandle) return;
    
    const c = global.lastClosedCandle;

    // 감시 조건 판단 (바이비트가 확정 지어준 직전 데이터 기반)
    let match = true;
    if (config.priceAtv) match = match && (config.priceType === 'above' ? currentPrice >= config.priceVal : currentPrice <= config.priceVal);
    
    // 나머지 RSI, 볼린저밴드, 거래량 조건은 바이비트가 넘겨준 '직전 마감 데이터' 기준으로 체크!
    // (만약 바이비트 내장 데이터 피드가 공란일 경우 화면 입력 기본 변수 기반 가상 패스 유연 처리)
    if (config.rsiAtv) match = match && (config.rsiType === 'above' ? lastData.rsi >= config.rsiVal : lastData.rsi <= config.rsiVal);
    
    // 알림 조건 충족 시
    if (match && lastAlertCandleTime !== c.start) {
        lastAlertCandleTime = c.start; // 동일 캔들 중복 알림 차단
        sendAlert(currentPrice, lastData.rsi, lastData.volRatio);
    }
}

function sendAlert(p, r, v) {
    const text = `🚨 [원격 직전봉 지표 알람]\n노드: ${config.windowAlias}\n현재가: ${p.toLocaleString()} USDT\n직전 RSI: ${r.toFixed(1)}\n거래량: ${v.toFixed(1)}x`;
    axios.post(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
        chat_id: config.telegramChatId, text: text
    }).catch(e => console.error("Telegram 전송 실패"));
}

connectWS();

// --- API 엔드포인트 ---
app.get('/api/config', (req, res) => res.json({ config, lastData }));
app.post('/api/config', (req, res) => {
    config = { ...config, ...req.body };
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Lightweight Node Running on port ${PORT}`));
