const express = require('express');
const axios = require('axios');

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
    price: 0, rsi: 0, bbUpper: 0, bbLower: 0, volRatio: 0,
    lastClosedTime: 0, 
    triggerPopup: false 
};

// --- 브라우저(클라이언트)가 우회해서 보내준 데이터를 접수하는 라우터 ---
app.post('/api/report-metrics', (req, res) => {
    const { price, rsi, bbUpper, bbLower, volRatio, closedCandleTime } = req.body;
    
    // 데이터 갱신
    lastData.price = price;
    lastData.rsi = rsi;
    lastData.bbUpper = bbUpper;
    lastData.bbLower = bbLower;
    lastData.volRatio = volRatio;

    // 새로운 5분봉 마감 시점인지 대조 검증
    if (lastData.lastClosedTime !== closedCandleTime) {
        console.log(`[봉 마감 감지] 시간: ${new Date(closedCandleTime).toLocaleTimeString()} | 가격: ${price} | RSI: ${rsi.toFixed(1)}`);
        lastData.lastClosedTime = closedCandleTime;

        if (config.isSystemRunning) {
            let match = true;
            if (config.priceAtv) match = match && (config.priceType === 'above' ? lastData.price >= config.priceVal : lastData.price <= config.priceVal);
            if (config.rsiAtv) match = match && (config.rsiType === 'above' ? lastData.rsi >= config.rsiVal : lastData.rsi <= config.rsiVal);
            if (config.bbUpperAtv) match = match && (lastData.price >= lastData.bbUpper);
            if (config.bbLowerAtv) match = match && (lastData.price <= lastData.bbLower);
            if (config.volAtv) match = match && (lastData.volRatio >= config.volRatio);

            if (match) {
                lastData.triggerPopup = true; // 프론트엔드 팝업 신호 ON
                
                const text = `🚨 [5분봉 마감 알람 성립]\n노드: ${config.windowAlias}\n마감가격: ${lastData.price.toLocaleString()} USDT\nRSI: ${lastData.rsi.toFixed(1)}\n거래량: ${lastData.volRatio.toFixed(1)}배`;
                axios.post(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
                    chat_id: config.telegramChatId, text: text
                }).catch(() => {});
            }
        }
    }
    res.json({ success: true });
});

app.get('/api/config', (req, res) => {
    res.json({ config, lastData });
    if (lastData.triggerPopup) {
        lastData.triggerPopup = false; // 신호 전달 후 리셋
    }
});

app.post('/api/config', (req, res) => {
    config = { ...config, ...req.body };
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Tactical Safe Peer Node v5.7 Running on port ${PORT}`));
