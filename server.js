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
    lastClosedTime: 0, // 직전 마감봉의 고유 시간 (체크용)
    triggerPopup: false // 프론트엔드 팝업 강제 트리거 플래그
};

// --- 5분봉 마감 감지 및 지표 계산 연산 장치 ---
async function checkFiveMinuteCandleLoop() {
    try {
        // Bybit 5분봉 최신 데이터 200개 로드
        const url = 'https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=5&limit=200';
        const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        
        if (!res.data || !res.data.result || !res.data.result.list) return;
        
        const list = res.data.result.list; 
        // list[0] = 현재 움직이는 중인 실시간 봉
        // list[1] = 정확히 직전에 마감 완성된 5분봉 (★우리가 감시해야 할 대상)
        
        const currentLivePrice = parseFloat(list[0][4]); // 현재 실시간 가격
        const closedCandleTime = parseInt(list[1][0]); // 직전 마감봉의 시작 시간
        
        // 전체 과거 종가/거래량 배열 생성 (오래된 순으로 정렬)
        const allCloses = list.map(c => parseFloat(c[4])).reverse();
        const allVolumes = list.map(c => parseFloat(c[5])).reverse();
        
        // 실시간 대시보드 화면에 뿌려줄 기본 수치 바인딩 (RSI, BB, 거래량은 마감봉[1] 기준으로 고정 계산)
        lastData.price = currentLivePrice;
        
        // 1. 완성된 직전 봉들 기준 RSI(14) 계산
        const rsiCloses = allCloses.slice(0, -1); // 진행중인 실시간 봉 제외
        let gains = 0, losses = 0;
        for (let i = rsiCloses.length - 14; i < rsiCloses.length; i++) {
            let diff = rsiCloses[i] - rsiCloses[i-1];
            if (diff > 0) gains += diff; else losses -= diff;
        }
        lastData.rsi = losses === 0 ? 100 : 100 - (100 / (1 + (gains / losses)));

        // 2. 완성된 직전 봉들 기준 볼린저 밴드(20, 2) 계산
        const bbSample = rsiCloses.slice(-20);
        const ma = bbSample.reduce((a, b) => a + b, 0) / bbSample.length;
        const variance = bbSample.reduce((a, b) => a + Math.pow(b - ma, 2), 0) / bbSample.length;
        const std = Math.sqrt(variance);
        lastData.bbUpper = ma + (config.bbStd * std);
        lastData.bbLower = ma - (config.bbStd * std);

        // 3. 완성된 직전 마감봉 거래량 / 그 앞선 5개 봉의 평균 거래량 비율
        const targetVol = parseFloat(list[1][5]);
        const prevVols = allVolumes.slice(-7, -2); // 진행중 봉과 직전 마감봉 제외한 과거 5개
        const volMa = prevVols.reduce((a, b) => a + b, 0) / prevVols.length;
        lastData.volRatio = volMa > 0 ? (targetVol / volMa) : 1;

        // ★ [핵심] 새로운 5분봉이 마감되는 시점 포착!
        if (lastData.lastClosedTime !== closedCandleTime) {
            console.log(`[시스템 알림] 새로운 5분봉 마감 완료 (${new Date(closedCandleTime).toLocaleTimeString()}) -> 조건 검증 시작`);
            lastData.lastClosedTime = closedCandleTime; // 중복 실행 방지 락(Lock)

            if (config.isSystemRunning) {
                // 직전 마감봉 스냅샷 값을 기준으로 엄격하게 유저 조건문 대조
                let match = true;
                if (config.priceAtv) match = match && (config.priceType === 'above' ? lastData.price >= config.priceVal : lastData.price <= config.priceVal);
                if (config.rsiAtv) match = match && (config.rsiType === 'above' ? lastData.rsi >= config.rsiVal : lastData.rsi <= config.rsiVal);
                if (config.bbUpperAtv) match = match && (lastData.price >= lastData.bbUpper);
                if (config.bbLowerAtv) match = match && (lastData.price <= lastData.bbLower);
                if (config.volAtv) match = match && (lastData.volRatio >= config.volRatio);

                // 최종 매칭 성공 시 딱 1번만 텔레그램 발송 및 프론트엔드 팝업 호출 신호 전달
                if (match) {
                    lastData.triggerPopup = true; // 프론트엔드가 퍼가도록 스위치 ON
                    
                    const text = `🚨 [5분봉 마감 알람 성립]\n노드: ${config.windowAlias}\n마감가격: ${lastData.price.toLocaleString()} USDT\nRSI: ${lastData.rsi.toFixed(1)}\n거래량 비율: ${lastData.volRatio.toFixed(1)}배`;
                    axios.post(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
                        chat_id: config.telegramChatId, text: text
                    }).catch(() => {});
                }
            }
        }
    } catch (e) {
        console.log("바이비트 데이터 수신 지연 중... 재시도합니다.");
    }
}

// 5초 간격으로 바이비트 상태를 조회하며 5분봉 마감 정밀 트래킹
setInterval(checkFiveMinuteCandleLoop, 5000);
checkFiveMinuteCandleLoop();

app.get('/api/config', (req, res) => {
    res.json({ config, lastData });
    // 프론트엔드가 팝업 신호를 확인하고 가져갔으면 즉시 초기화하여 중복 팝업 방지
    if (lastData.triggerPopup) {
        lastData.triggerPopup = false;
    }
});

app.post('/api/config', (req, res) => {
    config = { ...config, ...req.body };
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Tactical Node v5.5 Running on port ${PORT}`));
