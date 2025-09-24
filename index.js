const ccxt = require('ccxt');
const fs = require('fs');

const log = (level, message) => {
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} [${level.toUpperCase()}]: ${message}`);
};

let config;
try {
    const configFile = fs.readFileSync('config.json', 'utf8');
    config = JSON.parse(configFile);
    log('info', '配置文件 config.json 加载成功。');
} catch (error) {
    log('error', `加载配置文件失败: ${error.message}`);
    process.exit(1);
}

class ArbitrageBot {
    constructor(config) {
        this.config = config;
        
        // --- 核心修改：创建两个独立的交易所实例 ---
        // 1. 现货专用实例
        this.spotExchange = new ccxt[this.config.exchange]({
            'timeout': 20000,
        });

        // 2. 合约专用实例
        this.futuresExchange = new ccxt[this.config.exchange]({
            'timeout': 20000,
            'options': {
                'defaultType': 'swap', // 明确告诉此实例，它是处理合约的
            },
        });

        this.spotPrice = { bid: null, ask: null };
        this.futuresPrice = { bid: null, ask: null };
        this.fundingRate = null;
        this.currentPosition = null; 
        this.paperPortfolio = this.config.paperTrading.initialBalance;
        log('info', `模拟账户初始化: ${JSON.stringify(this.paperPortfolio)}`);
    }

    async start() {
        log('info', `机器人启动，监控交易对: ${this.config.spotSymbol}`);
        log('info', `每次交易名义本金: ${this.config.paperTrading.tradeAmountUSDT} USDT`);

        try {
            log('info', '正在从交易所加载市场数据...');
            // 两个实例都需要加载市场数据
            await Promise.all([
                this.spotExchange.loadMarkets(),
                this.futuresExchange.loadMarkets()
            ]);
            log('info', '市场数据加载成功。');
        } catch (error) {
            log('error', `加载市场数据失败: ${error.message}`);
            process.exit(1);
        }

        this.fetchFundingRatePeriodically();
        this.watchMarkets();
    }

    async fetchFundingRatePeriodically() {
        try {
            // 使用合约实例来获取资金费率
            const market = this.futuresExchange.market(this.config.futuresSymbol);
            const fundingRateData = await this.futuresExchange.fetchFundingRate(market.symbol);
            this.fundingRate = parseFloat(fundingRateData.fundingRate) * 100;
            log('info', `获取到资金费率: ${this.fundingRate.toFixed(4)}%`);
        } catch (error) {
            log('error', `获取资金费率失败: ${error.message}`);
        }
        setTimeout(() => this.fetchFundingRatePeriodically(), 1000 * 60 * 60);
    }

    async watchMarkets() {
        log('info', '启动轮询模式 (Polling Mode) 监控市场价格。');
        const pollInterval = this.config.pollingIntervalMs || 3000;
        log('info', `价格轮询间隔设置为: ${pollInterval}ms`);

        const pollPrices = async () => {
            while (true) {
                try {
                    // --- 核心修改：从各自专用的实例获取价格 ---
                    const [spotTicker, futuresTicker] = await Promise.all([
                        this.spotExchange.fetchTicker(this.config.spotSymbol),
                        this.futuresExchange.fetchTicker(this.config.futuresSymbol)
                    ]);
                    
                    if (!spotTicker || !futuresTicker) {
                       log('warn', '本次轮询未能获取到完整的现货和合约价格，跳过。');
                       await new Promise(resolve => setTimeout(resolve, pollInterval));
                       continue;
                    }

                    this.spotPrice.bid = spotTicker.bid;
                    this.spotPrice.ask = spotTicker.ask;
                    this.futuresPrice.bid = futuresTicker.bid;
                    this.futuresPrice.ask = futuresTicker.ask;

                    if (this.config.logging.showPriceUpdates) {
                        const basis = (this.futuresPrice.bid - this.spotPrice.ask).toFixed(6);
                        const basisPercent = ((this.futuresPrice.bid / this.spotPrice.ask - 1) * 100).toFixed(4);
                        log('data', `现货: ${this.spotPrice.ask} | 合约: ${this.futuresPrice.bid} | 基差: ${basis} (${basisPercent}%)`);
                    }

                    this.checkArbitrageOpportunity();

                } catch (error) {
                    log('error', `轮询价格失败: ${error.message}`);
                }
                await new Promise(resolve => setTimeout(resolve, pollInterval));
            }
        };

        pollPrices();
    }
    
    // ... 后续函数 (checkArbitrageOpportunity, simulateOpenPosition, etc.) 无需修改 ...
    checkArbitrageOpportunity() {
        if (!this.spotPrice.ask || !this.futuresPrice.bid || this.fundingRate === null) {
            return;
        }

        const basis = this.futuresPrice.bid - this.spotPrice.ask;
        const basisPercent = (basis / this.spotPrice.ask) * 100;

        if (!this.currentPosition) {
            const openFeePercent = (this.config.fees.spotTaker + this.config.fees.futuresTaker) * 100;
            if (basisPercent > this.config.arbitrage.openThresholdPercent && this.fundingRate > this.config.arbitrage.fundingRateThresholdPercent) {
                this.simulateOpenPosition(basisPercent);
            }
        } else {
            if (basisPercent < this.config.arbitrage.closeThresholdPercent) {
                this.simulateClosePosition(basisPercent);
            }
        }
    }

    simulateOpenPosition(basisPercent) {
        log('decision', `[决策]: 发现套利机会! 基差: ${basisPercent.toFixed(4)}%. 准备模拟开仓...`);

        const tradeAmount = this.config.paperTrading.tradeAmountUSDT;
        const spotPriceToBuy = this.spotPrice.ask;
        const futuresPriceToSell = this.futuresPrice.bid;

        const amount = tradeAmount / spotPriceToBuy;
        const spotFee = tradeAmount * this.config.fees.spotTaker;
        const futuresFee = (amount * futuresPriceToSell) * this.config.fees.futuresTaker;

        const baseCurrency = this.config.spotSymbol.split('/')[0];
        this.paperPortfolio.USDT -= (tradeAmount + spotFee + futuresFee);
        if (!this.paperPortfolio[baseCurrency]) this.paperPortfolio[baseCurrency] = 0;
        this.paperPortfolio[baseCurrency] += amount;

        this.currentPosition = {
            entryTimestamp: new Date(),
            amount: amount,
            entrySpotPrice: spotPriceToBuy,
            entryFuturesPrice: futuresPriceToSell,
            initialBasisPercent: basisPercent
        };
        
        log('execution', `[模拟开仓] 买入 ${amount.toFixed(6)} ${baseCurrency} 现货 @ ${spotPriceToBuy}`);
        log('execution', `[模拟开仓] 做空 ${amount.toFixed(6)} ${baseCurrency} 合约 @ ${futuresPriceToSell}`);
        log('info', `当前模拟账户: ${JSON.stringify(this.paperPortfolio)}`);
    }

    simulateClosePosition(basisPercent) {
        log('decision', `[决策]: 基差收窄至 ${basisPercent.toFixed(4)}%. 准备模拟平仓...`);

        const position = this.currentPosition;
        const amount = position.amount;
        const spotPriceToSell = this.spotPrice.bid;
        const futuresPriceToBuy = this.futuresPrice.ask;
        const baseCurrency = this.config.spotSymbol.split('/')[0];

        const spotSellValue = amount * spotPriceToSell;
        const spotFee = spotSellValue * this.config.fees.spotTaker;
        const futuresFee = (amount * futuresPriceToBuy) * this.config.fees.futuresTaker;
        
        const spotPnL = (spotPriceToSell - position.entrySpotPrice) * amount;
        const futuresPnL = (position.entryFuturesPrice - futuresPriceToBuy) * amount;
        const totalFees = (spotSellValue * this.config.fees.spotTaker) +
                          ((amount * futuresPriceToBuy) * this.config.fees.futuresTaker) +
                          (position.amount * position.entrySpotPrice * this.config.fees.spotTaker) +
                          (position.amount * position.entryFuturesPrice * this.config.fees.futuresTaker); 

        const netPnL = spotPnL + futuresPnL - totalFees;

        this.paperPortfolio.USDT += (spotSellValue - spotFee - futuresFee);
        this.paperPortfolio[baseCurrency] -= amount;

        log('execution', `[模拟平仓] 卖出 ${amount.toFixed(6)} ${baseCurrency} 现货 @ ${spotPriceToSell}`);
        log('execution', `[模拟平仓] 平仓 ${amount.toFixed(6)} ${baseCurrency} 合约 @ ${futuresPriceToBuy}`);
        log('pnl', `[盈亏报告] 本次套利净利润: ${netPnL.toFixed(4)} USDT`);
        log('info', `当前模拟账户: ${JSON.stringify(this.paperPortfolio)}`);

        this.currentPosition = null;
    }
}

const bot = new ArbitrageBot(config);
bot.start();