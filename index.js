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

        // --- 网络优化修改 ---
        this.exchange = new ccxt[this.config.exchange]({
            'timeout': 30000, // 将超时时间从默认的10秒增加到30秒
            'options': {
                'defaultType': 'swap', // 将默认类型放在这里更安全
                // 如果api.binance.com连接不上，可以尝试备用域名
                // 'adjustForTimeDifference': true, // 如果遇到时间戳问题可以开启
                'hostname': 'api3.binance.com', // 尝试使用备用服务器 api1/2/3
                // 或者 'hostname': 'data.binance.com'
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
            await this.exchange.loadMarkets();
            log('info', '市场数据加载成功。');
        } catch (error) {
            log('error', `加载市场数据失败: ${error.message}`);
            // 提供更详细的错误帮助
            if (error instanceof ccxt.RequestTimeout) {
                log('help', '这通常是一个网络问题。请检查您的网络连接，或尝试在config.js中更换hostname。');
            }
            process.exit(1);
        }

        this.fetchFundingRatePeriodically();
        this.watchMarkets();
    }
    
    // ... 后续代码 (fetchFundingRatePeriodically, watchMarkets, etc.) 与之前版本完全相同，无需改动 ...
    async fetchFundingRatePeriodically() {
        try {
            const market = this.exchange.market(this.config.futuresSymbol);
            const fundingRateData = await this.exchange.fetchFundingRate(market.symbol);
            this.fundingRate = parseFloat(fundingRateData.fundingRate) * 100;
            log('info', `获取到资金费率: ${this.fundingRate.toFixed(4)}%`);
        } catch (error) {
            log('error', `获取资金费率失败: ${error.message}`);
        }
        setTimeout(() => this.fetchFundingRatePeriodically(), 1000 * 60 * 60);
    }

    async watchMarkets() {
        const watchSpot = async () => {
            while (true) {
                try {
                    const ticker = await this.exchange.watchTicker(this.config.spotSymbol);
                    this.spotPrice.bid = ticker.bid;
                    this.spotPrice.ask = ticker.ask;
                    if (this.config.logging.showPriceUpdates) {
                        log('data', `现货价格更新: 买一 ${this.spotPrice.bid} / 卖一 ${this.spotPrice.ask}`);
                    }
                    this.checkArbitrageOpportunity();
                } catch (error) {
                    log('error', `监控现货市场失败: ${error.message}`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }
        };

        const watchFutures = async () => {
            while (true) {
                try {
                    const ticker = await this.exchange.watchTicker(this.config.futuresSymbol);
                    this.futuresPrice.bid = ticker.bid;
                    this.futuresPrice.ask = ticker.ask;
                    if (this.config.logging.showPriceUpdates) {
                        log('data', `合约价格更新: 买一 ${this.futuresPrice.bid} / 卖一 ${this.futuresPrice.ask}`);
                    }
                    this.checkArbitrageOpportunity();
                } catch (error) {
                    log('error', `监控合约市场失败: ${error.message}`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }
        };

        watchSpot();
        watchFutures();
    }
    
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